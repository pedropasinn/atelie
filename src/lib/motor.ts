import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SESSIONS_ROOT } from '../config';
import type { GenJob, ProgressEvent, Verdict } from '../types';
import { briefHash, briefStyles, buildLegibilityRubric, composeBriefPrompt, normalizeBrief, type ComposedBrief, type StructuredBrief } from './brief';
import { resolveGenProvider } from './genProviders';
import { askImagesRaw } from './judgeProviders';
import { coerce } from './judge';
import { buildContentTranscriptionRubric, coerceTranscricao, compararConteudo, type ResultadoConteudo } from './juizConteudo';
import { extractJson } from './jsonx';
import { cliEnabled, loadSettings } from './settings';
import { findStyle } from './userStyles';
import { createArtifactManifest, pngDimensions, provenanceVerdict, sha256File, writeManifest, type ArtifactManifest, type FundoProveniencia, type ProvenanceVerdict } from './provenance';
import { estimateImageCost } from './cost';
import { verificarProporcao, type VerificacaoProporcao } from './proporcao';
import {
  defaultRemoveBackground,
  type RemoveBackgroundInput,
  type RemoveBackgroundOutput,
} from './backgroundRemoval';

export interface MotorGenerationInput {
  prompt: string;
  outPath: string;
  styleId: string;
  size: string;
  quality: 'low' | 'medium' | 'high';
  refs: string[];
  mode: GenJob['mode'];
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

export interface MotorGenerationOutput {
  pngPath: string;
  provider: string;
  model: string;
  durationMs?: number;
  costUsd?: number;
  costType?: 'estimativa' | 'informado';
  costSource?: string;
}

export interface MotorJudgeInput {
  pngPath: string;
  composed: ComposedBrief;
  signal?: AbortSignal;
}

export interface MotorJudgeOutput {
  verdict: Verdict;
  provider: string;
  model: string;
}

export interface MotorContentJudgeInput {
  pngPath: string;
  composed: ComposedBrief;
  signal?: AbortSignal;
}

export interface MotorContentJudgeOutput {
  transcricao: string[];
  provider: string;
  model: string;
  erro?: string;
}

export interface MotorDependencies {
  generate(input: MotorGenerationInput): Promise<MotorGenerationOutput>;
  removeBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundOutput>;
  transcribe(input: MotorContentJudgeInput): Promise<MotorContentJudgeOutput>;
  judge(input: MotorJudgeInput): Promise<MotorJudgeOutput>;
  now(): Date;
}

export interface MotorProgress {
  etapa: 'preparando' | 'gerando' | 'julgando' | 'iterando' | 'concluido';
  estilo?: string;
  artefato?: number;
  tentativa?: number;
  concluidos: number;
  total: number;
  percentual?: number;
  mensagem: string;
}

export interface GeneratedArtifact {
  n: number;
  id: string;
  styleId: string;
  pngPath: string | null;
  manifestPath: string;
  manifest: ArtifactManifest;
  verdict: Verdict;
}

export interface MotorResult {
  jobId: string;
  briefHash: string;
  dir: string;
  artifacts: GeneratedArtifact[];
  verdict: Verdict;
  durationMs: number;
}

export interface GenerateOptions {
  jobId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: MotorProgress) => void;
}

export interface MotorOptions {
  rootDir?: string;
  dependencies?: Partial<MotorDependencies>;
}

function abortError(): Error {
  const error = new Error('job cancelado');
  error.name = 'AbortError';
  return error;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function proporcaoDivergente(tamanho: string, dimensoes: { largura: number; altura: number }, verificacao: VerificacaoProporcao): string {
  return `proporção divergente: pedido ${tamanho}, real ${dimensoes.largura}x${dimensoes.altura} (${verificacao.orientacao_real})`;
}

function mdc(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

function instrucaoProporcao(tamanho: string, verificacao: VerificacaoProporcao): string {
  const forma = verificacao.orientacao_pedida === 'landscape'
    ? 'horizontal'
    : verificacao.orientacao_pedida === 'portrait'
      ? 'vertical'
      : 'quadrado';
  const match = /^(\d+)x(\d+)$/i.exec(tamanho.trim());
  if (!match) return `FORMATO OBRIGATÓRIO: ${forma}; respeite essa orientação na imagem final.`;
  const largura = Number(match[1]);
  const altura = Number(match[2]);
  const divisor = mdc(largura, altura);
  return `FORMATO OBRIGATÓRIO: ${forma} ${largura / divisor}:${altura / divisor}; respeite a proporção ${largura}x${altura} na imagem final.`;
}

async function defaultGenerate(input: MotorGenerationInput): Promise<MotorGenerationOutput> {
  const mode = input.mode;
  const job: GenJob = {
    id: `motor-${randomUUID()}`,
    styleId: input.styleId,
    index: 0,
    prompt: input.prompt,
    mode,
    refs: input.refs,
    refPng: input.refs[0],
    outPath: input.outPath,
    provider: 'codex',
    size: input.size,
  };
  const provider = resolveGenProvider('codex', mode);
  const started = Date.now();
  const result = await provider.generate(job, {
    size: input.size,
    quality: input.quality,
    signal: input.signal,
    onProgress: input.onProgress,
  });
  const dimensions = pngDimensions(result.pngPath);
  const estimatedCost = estimateImageCost(input.quality, `${dimensions.largura}x${dimensions.altura}`);
  return {
    pngPath: result.pngPath,
    provider: result.meta.resolved || provider.id,
    model: result.meta.model || 'gpt-image-2',
    durationMs: Date.now() - started,
    costUsd: estimatedCost.usd,
    costType: estimatedCost.tipo,
    costSource: estimatedCost.fonte,
  };
}

function judgeSpec() {
  const settings = loadSettings();
  const spec = cliEnabled(settings.singleJudge.provider, settings)
    ? settings.singleJudge
    : settings.judgePanel.find((candidate) => cliEnabled(candidate.provider, settings));
  if (!spec) throw new Error('nenhum juiz de legibilidade está habilitado');
  return { settings, spec };
}

async function defaultTranscribe(input: MotorContentJudgeInput): Promise<MotorContentJudgeOutput> {
  const { spec } = judgeSpec();
  const rubric = buildContentTranscriptionRubric(input.composed.ordensObrigatorias.length > 0);
  const raw = await askImagesRaw(spec, [input.pngPath], rubric, input.signal);
  const parsed = coerceTranscricao(extractJson(raw), raw);
  return { transcricao: parsed.textos, provider: spec.provider, model: spec.model, erro: parsed.erro };
}

async function defaultJudge(input: MotorJudgeInput): Promise<MotorJudgeOutput> {
  const { settings, spec } = judgeSpec();
  const threshold = settings.approveThreshold;
  const rubric = buildLegibilityRubric(input.composed, threshold, pngDimensions(input.pngPath).largura);
  const raw = await askImagesRaw(spec, [input.pngPath], rubric, input.signal);
  const verdict = coerce(extractJson(raw), raw, threshold);
  return { verdict: aplicarGateVisual(verdict), provider: spec.provider, model: spec.model };
}

/** Falhas declaradas pelo juiz visual nunca podem coexistir com aprovação. */
export function aplicarGateVisual(verdict: Verdict, zeroTexto = false): Verdict {
  const falhaVisual = /ileg[ií]vel|ortografi|acentua|microtexto|pseudotexto|cortad|sobrepost|res[ií]duo|serrilhad|halo|sombra chapada/i;
  const textoEmModoZero = /texto|letra|n[uú]mero|legenda|logotipo|marca-d[’' -]?água|pseudotexto/i;
  const reprovar = verdict.problemas.some((problema) => falhaVisual.test(problema) || (zeroTexto && textoEmModoZero.test(problema)));
  return reprovar && verdict.aprovado ? { ...verdict, aprovado: false } : verdict;
}

function contentProblems(
  result: ResultadoConteudo,
  composed: ComposedBrief,
  textoExtraPermitido: boolean,
  erro?: string,
): string[] {
  if (erro) return [erro];
  const componente = composed.brief.modo === 'componente';
  const zeroTexto = composed.brief.modo === 'cena' || composed.brief.texto_fora_da_imagem || (componente && !composed.stringsVisiveis.length);
  const problemas: string[] = [];
  if (zeroTexto || !textoExtraPermitido) {
    for (const extra of [...result.extras, ...((zeroTexto || componente) ? result.numeracao : [])]) {
      problemas.push(`texto não autorizado: ${extra}`);
    }
  }
  for (const faltante of result.faltantes) problemas.push(`rótulo ausente: ${faltante}`);
  if (composed.brief.ortografia_estrita) {
    for (const divergencia of result.ortografia) {
      problemas.push(`ortografia divergente: "${divergencia.transcrito}" ≠ "${divergencia.esperado}"`);
    }
  }
  for (const ordem of result.ordemIncorreta) problemas.push(`ordem obrigatória divergente: ${ordem.join(' → ')}`);
  return problemas;
}

function fundoVeto(problemas: string[], composed: ComposedBrief): Verdict {
  if (!problemas.length) problemas = ['remoção de fundo reprovada sem diagnóstico do removedor'];
  const dicas = dicasFundo(problemas);
  return {
    aprovado: false,
    nota: null,
    alinhamento: 'remoção de fundo reprovada por validação determinística',
    problemas,
    sugestao_melhoria: dicas.join('; '),
    prompt_sugerido: composed.prompt,
  };
}

function dicasFundo(problemas: string[]): string[] {
  const dicas: string[] = [];
  if (problemas.some((p) => /margem|cortad|incompleto/i.test(p))) dicas.push('mais margem ao redor do objeto completo');
  if (problemas.some((p) => /objeto pequeno demais/i.test(p))) dicas.push('objeto maior e mais espesso, ocupando mais área do quadro');
  if (problemas.some((p) => /cor do fundo/i.test(p))) dicas.push('objeto sem a cor do fundo ou use o motor rembg');
  if (problemas.some((p) => /fundo|borda|fração transparente|fragment|res[ií]duo/i.test(p))) dicas.push('fundo liso sem gradiente e sem elementos soltos');
  if (problemas.some((p) => /halo|sombra/i.test(p))) dicas.push('sem sombra projetada ou chapada');
  return dicas.length ? dicas : ['isolar melhor um único objeto sobre fundo liso uniforme'];
}

function contentVeto(problemas: string[], composed: ComposedBrief): Verdict {
  if (!problemas.length) problemas = ['conteúdo textual reprovado sem diagnóstico do transcritor'];
  const faltantes = problemas.filter((problema) => problema.startsWith('rótulo ausente:'));
  const ortografia = problemas.some((problema) => problema.startsWith('ortografia divergente:'));
  return {
    aprovado: false,
    nota: null,
    alinhamento: 'conteúdo textual reprovado por regra determinística',
    problemas,
    sugestao_melhoria: faltantes.length
      ? 'incluir todos os rótulos obrigatórios sem acrescentar texto'
      : ortografia ? 'corrigir exatamente a ortografia dos rótulos permitidos' : 'remover todo texto não autorizado',
    prompt_sugerido: composed.prompt,
  };
}

function finalVerdict(artifacts: GeneratedArtifact[]): Verdict {
  if (!artifacts.length) {
    return { aprovado: false, nota: null, alinhamento: 'nenhum artefato gerado', problemas: ['nenhum artefato gerado'], sugestao_melhoria: '', prompt_sugerido: '' };
  }
  const notes = artifacts.map((a) => a.verdict.nota).filter((n): n is number => n != null);
  const approved = artifacts.every((a) => a.verdict.aprovado);
  const worst = [...artifacts].sort((a, b) => (a.verdict.nota ?? -1) - (b.verdict.nota ?? -1))[0];
  const avisos = [...new Set(artifacts.flatMap((a) => a.verdict.avisos ?? []))].slice(0, 12);
  return {
    aprovado: approved,
    nota: notes.length ? Math.round(notes.reduce((sum, n) => sum + n, 0) / notes.length * 10) / 10 : null,
    alinhamento: approved ? 'todos os artefatos foram aprovados' : worst.verdict.alinhamento,
    problemas: [...new Set(artifacts.flatMap((a) => a.verdict.problemas))].slice(0, 12),
    avisos: avisos.length ? avisos : undefined,
    sugestao_melhoria: worst.verdict.sugestao_melhoria,
    prompt_sugerido: worst.verdict.prompt_sugerido,
  };
}

export class AtelieMotor {
  readonly rootDir: string;
  private readonly deps: MotorDependencies;

  constructor(options: MotorOptions = {}) {
    this.rootDir = options.rootDir ?? path.join(SESSIONS_ROOT, 'jobs');
    this.deps = {
      generate: options.dependencies?.generate ?? defaultGenerate,
      removeBackground: options.dependencies?.removeBackground ?? defaultRemoveBackground,
      transcribe: options.dependencies?.transcribe ?? defaultTranscribe,
      judge: options.dependencies?.judge ?? defaultJudge,
      now: options.dependencies?.now ?? (() => new Date()),
    };
  }

  async gerar(value: unknown, options: GenerateOptions = {}): Promise<MotorResult> {
    const brief = normalizeBrief(value);
    const hash = briefHash(brief);
    const jobId = options.jobId ?? `job-${hash.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
    const dir = path.join(this.rootDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    const styleIds = briefStyles(brief);
    const started = Date.now();
    const artifacts: GeneratedArtifact[] = [];
    options.onProgress?.({ etapa: 'preparando', concluidos: 0, total: styleIds.length, mensagem: 'brief validado e prompts em composição' });

    for (const [styleIndex, styleId] of styleIds.entries()) {
      assertNotAborted(options.signal);
      const style = findStyle(styleId);
      if (!style) throw new Error(`estilo "${styleId}" não existe`);
      const composed = composeBriefPrompt(brief, style);
      const artifactN = styleIndex + 1;
      const artifactId = `artifact-${String(artifactN).padStart(3, '0')}`;
      const artifactDir = path.join(dir, artifactId);
      fs.mkdirSync(artifactDir, { recursive: true });
      let prompt = composed.prompt;
      let generated: MotorGenerationOutput | undefined;
      let judged: MotorJudgeOutput | undefined;
      let finalAttemptPng: string | undefined;
      const verdicts: ProvenanceVerdict[] = [];
      let artifactCostUsd = 0;
      let artifactCostType: 'estimativa' | 'informado' = 'estimativa';
      const artifactCostSources = new Set<string>();
      const maxAttempts = 1 + (brief.iteracoes ?? 1);
      const artifactStarted = Date.now();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptStarted = Date.now();
        assertNotAborted(options.signal);
        const tentativaBase = `tentativa-${String(attempt).padStart(2, '0')}`;
        const componente = brief.modo === 'componente';
        const outPath = path.join(artifactDir, `${tentativaBase}${componente ? '-original' : ''}.png`);
        const generationMode: GenJob['mode'] = brief.refs.length ? 'edit' : style.defaults.background === 'transparent' ? 'transparent' : 'generate';
        options.onProgress?.({ etapa: attempt === 1 ? 'gerando' : 'iterando', estilo: styleId, artefato: artifactN, tentativa: attempt, concluidos: styleIndex, total: styleIds.length, mensagem: `gerando ${styleId}, tentativa ${attempt}` });
        generated = await this.deps.generate({
          prompt,
          outPath,
          styleId,
          size: brief.tamanho || style.defaults.size,
          quality: brief.qualidade,
          refs: brief.refs,
          mode: generationMode,
          signal: options.signal,
          onProgress: (event) => options.onProgress?.({
            etapa: 'gerando', estilo: styleId, artefato: artifactN, tentativa: attempt,
            concluidos: styleIndex, total: styleIds.length, percentual: event.percent, mensagem: event.message || event.phase,
          }),
        });
        const generationMs = generated.durationMs ?? Date.now() - attemptStarted;
        const generatedCost = generated.costUsd ?? estimateImageCost(brief.qualidade, brief.tamanho).usd;
        artifactCostUsd += generatedCost;
        artifactCostType = generated.costType ?? (generated.costUsd == null ? 'estimativa' : 'informado');
        artifactCostSources.add(generated.costSource ?? (generated.costUsd == null ? 'tabela-padrao-atelie-2026-08-29' : 'provedor-injetado'));
        const dimensoes = pngDimensions(generated.pngPath);
        const proporcao = verificarProporcao(brief.tamanho, dimensoes);
        finalAttemptPng = generated.pngPath;
        assertNotAborted(options.signal);
        const judgmentStarted = Date.now();
        const attemptComposed = { ...composed, prompt };
        let judgedPng = generated.pngPath;
        let fundo: FundoProveniencia | undefined;
        let fundoFalhou = false;
        let avisoFundo: string | undefined;
        if (componente) {
          const solicitado = brief.remover_fundo ?? 'obrigatorio';
          const motorSolicitado = brief.motor_fundo ?? 'rembg';
          const modelo = brief.modelo_fundo ?? 'isnet-general-use';
          const arquivoOriginalSha256 = sha256File(generated.pngPath);
          if (solicitado === 'nao') {
            fundo = { solicitado, motor: 'nenhum', modelo, removido: false, alpha_validado: false, metricas: null, problemas: [], arquivo_original_sha256: arquivoOriginalSha256 };
          } else {
            const fundoPng = path.join(artifactDir, `${tentativaBase}.png`);
            const composicaoPath = path.join(artifactDir, `${tentativaBase}-xadrez.png`);
            let removido: RemoveBackgroundOutput | undefined;
            try {
              if (generationMode === 'transparent') {
                const nativo = await this.deps.removeBackground({
                  pngPath: generated.pngPath, outPath: fundoPng, composicaoPath,
                  motor: 'nenhum', modelo, limites: brief.limites_fundo, signal: options.signal,
                });
                if (nativo.resultado.ok || motorSolicitado === 'nenhum') removido = nativo;
              }
              if (!removido) {
                removido = await this.deps.removeBackground({
                  pngPath: generated.pngPath, outPath: fundoPng, composicaoPath,
                  motor: motorSolicitado, modelo, limites: brief.limites_fundo, signal: options.signal,
                });
              }
              judgedPng = removido.pngPath;
              finalAttemptPng = removido.pngPath;
              fundo = {
                solicitado,
                motor: removido.resultado.motor,
                modelo: removido.resultado.modelo,
                removido: removido.resultado.motor !== 'nenhum',
                alpha_validado: removido.resultado.ok,
                metricas: removido.resultado.metricas,
                problemas: removido.resultado.problemas,
                arquivo_original_sha256: arquivoOriginalSha256,
              };
              fundoFalhou = !removido.resultado.ok;
              if (removido.composicaoPath) judgedPng = removido.composicaoPath;
            } catch {
              assertNotAborted(options.signal);
              fs.rmSync(fundoPng, { force: true });
              fs.rmSync(composicaoPath, { force: true });
              const problema = 'remoção de fundo indisponível';
              fundo = { solicitado, motor: motorSolicitado, modelo, removido: false, alpha_validado: false, metricas: null, problemas: [problema], arquivo_original_sha256: arquivoOriginalSha256 };
              finalAttemptPng = generated.pngPath;
              if (solicitado === 'obrigatorio') fundoFalhou = true;
              else avisoFundo = `${problema}; usando artefato original`;
            }
          }
        }
        let contentJudged: MotorContentJudgeOutput | undefined;
        let contentResult: ResultadoConteudo | undefined;
        let problemasConteudo: string[] = [];
        let visualJudged: MotorJudgeOutput | null = null;
        const zeroTexto = brief.modo === 'cena' || brief.texto_fora_da_imagem || (componente && !composed.stringsVisiveis.length);
        if (fundoFalhou) {
          judged = { verdict: fundoVeto(fundo?.problemas ?? ['remoção de fundo reprovada'], attemptComposed), provider: 'deterministico', model: fundo?.modelo ?? 'fundo' };
        } else {
          options.onProgress?.({ etapa: 'julgando', estilo: styleId, artefato: artifactN, tentativa: attempt, concluidos: styleIndex, total: styleIds.length, mensagem: `transcrevendo conteúdo de ${styleId}` });
          contentJudged = await this.deps.transcribe({ pngPath: judgedPng, composed: attemptComposed, signal: options.signal });
          const comparado = compararConteudo(contentJudged.transcricao, composed.stringsVisiveis, {
            textoExtraPermitido: componente ? false : brief.texto_extra_permitido,
            zeroTexto,
            modo: brief.modo,
            ortografiaEstrita: brief.ortografia_estrita,
            ordensObrigatorias: composed.ordensObrigatorias,
          });
          contentResult = componente ? {
            ...comparado,
            faltantes: [],
            ok: !contentJudged.erro
              && comparado.extras.length === 0
              && comparado.numeracao.length === 0
              && !(brief.ortografia_estrita && comparado.ortografia.length > 0),
          } : contentJudged.erro ? { ...comparado, ok: false } : comparado;
          const textoExtraPermitido = componente ? false : brief.texto_extra_permitido === true;
          problemasConteudo = contentProblems(contentResult, composed, textoExtraPermitido, contentJudged.erro);
          if (contentResult.ok) {
            options.onProgress?.({ etapa: 'julgando', estilo: styleId, artefato: artifactN, tentativa: attempt, concluidos: styleIndex, total: styleIds.length, mensagem: `avaliando visual de ${styleId}` });
            visualJudged = await this.deps.judge({ pngPath: judgedPng, composed: attemptComposed, signal: options.signal });
            visualJudged = { ...visualJudged, verdict: aplicarGateVisual(visualJudged.verdict, zeroTexto) };
            judged = visualJudged;
          } else {
            judged = {
              verdict: contentVeto(problemasConteudo, attemptComposed),
              provider: contentJudged.provider,
              model: contentJudged.model,
            };
          }
        }
        // Proporção: veto em modo estrito, aviso em modo flexível; nunca compensa o veto de conteúdo.
        const avisoProporcao = proporcao.ok ? undefined : proporcaoDivergente(brief.tamanho, dimensoes, proporcao);
        const avisoGateInerte = brief.proporcao_estrita && proporcao.orientacao_pedida == null
          ? `proporção estrita sem geometria verificável para o tamanho "${brief.tamanho}"`
          : undefined;
        const avisosProporcao = [...new Set([
          ...(judged.verdict.avisos ?? []),
          ...(avisoFundo ? [avisoFundo] : []),
          ...(!brief.proporcao_estrita && avisoProporcao ? [avisoProporcao] : []),
          ...(avisoGateInerte ? [avisoGateInerte] : []),
        ])];
        judged = {
          ...judged,
          verdict: {
            ...judged.verdict,
            aprovado: brief.proporcao_estrita && !proporcao.ok ? false : judged.verdict.aprovado,
            problemas: brief.proporcao_estrita && avisoProporcao
              ? [...new Set([...judged.verdict.problemas, avisoProporcao])]
              : judged.verdict.problemas,
            avisos: avisosProporcao.length ? avisosProporcao : undefined,
            proporcao,
          },
        };
        if (!judged.verdict.aprovado && !judged.verdict.problemas.length) {
          judged = { ...judged, verdict: { ...judged.verdict, problemas: ['avaliação reprovada sem diagnóstico do juiz'] } };
        }
        const judgmentMs = Date.now() - judgmentStarted;
        verdicts.push(provenanceVerdict(
          attempt,
          prompt,
          judged.verdict,
          { provider: judged.provider, model: judged.model },
          this.deps.now().toISOString(),
          { totalMs: Date.now() - attemptStarted, generationMs, judgmentMs },
          contentResult && contentJudged ? {
            conteudo: contentResult,
            transcricao: contentJudged.transcricao,
            problemasConteudo,
            juizConteudo: { provider: contentJudged.provider, model: contentJudged.model },
            visual: visualJudged ? {
              verdict: visualJudged.verdict,
              judge: { provider: visualJudged.provider, model: visualJudged.model },
            } : null,
          } : undefined,
          fundo,
        ));
        if (judged.verdict.aprovado || attempt === maxAttempts) break;
        const instrucaoFormato = brief.proporcao_estrita && !proporcao.ok ? instrucaoProporcao(brief.tamanho, proporcao) : '';
        if (fundoFalhou) {
          prompt = [
            composed.prompt,
            `AJUSTES OBRIGATÓRIOS: ${dicasFundo(fundo?.problemas ?? []).join('; ')}.`,
            composed.stringsVisiveis.length
              ? `Mantenha somente estas strings permitidas: ${composed.stringsVisiveis.map((s) => `"${s}"`).join(', ')}.`
              : 'Mantenha o componente sem qualquer texto.',
            instrucaoFormato,
          ].filter(Boolean).join(' ');
        } else if (contentResult && !contentResult.ok) {
          prompt = [
            composed.prompt,
            zeroTexto
              ? 'PROIBIDO: qualquer texto visível, inclusive números, logotipos, marcas-d’água e pseudotexto.'
              : !(componente ? false : brief.texto_extra_permitido)
                ? `PROIBIDO: qualquer texto além de: ${composed.stringsVisiveis.map((s) => `"${s}"`).join(', ')}.`
                : '',
            contentResult.faltantes.length
              ? `OBRIGATÓRIO incluir: ${contentResult.faltantes.map((s) => `"${s}"`).join(', ')}.`
              : '',
            contentResult.ortografia.length
              ? `ORTOGRAFIA OBRIGATÓRIA: ${contentResult.ortografia.map((item) => `substitua "${item.transcrito}" por "${item.esperado}"`).join('; ')}.`
              : '',
            contentResult.ordemIncorreta.map((ordem) => `ORDEM OBRIGATÓRIA: ${ordem.map((s) => `"${s}"`).join(' → ')}.`).join(' '),
            instrucaoFormato,
          ].filter(Boolean).join(' ');
        } else if (contentResult) {
          prompt = [
            judged.verdict.prompt_sugerido.trim() || composed.prompt,
            judged.verdict.sugestao_melhoria.trim() ? `AJUSTE OBRIGATÓRIO: ${judged.verdict.sugestao_melhoria.trim()}.` : '',
            zeroTexto
              ? 'Mantenha a imagem sem qualquer texto.'
              : `Mantenha exatamente estas strings e nenhuma outra: ${composed.stringsVisiveis.map((s) => `"${s}"`).join(', ')}. Sem microtexto.`,
            instrucaoFormato,
          ].filter(Boolean).join(' ');
        }
      }

      if (!generated || !judged || !finalAttemptPng) throw new Error(`geração do estilo "${styleId}" não produziu resultado`);
      const ultimoFundo = verdicts[verdicts.length - 1]?.fundo;
      const semRecorteObrigatorio = brief.modo === 'componente'
        && (brief.remover_fundo ?? 'obrigatorio') === 'obrigatorio'
        && ultimoFundo?.metricas == null;
      const finalPng = semRecorteObrigatorio ? undefined : path.join(artifactDir, 'artifact.png');
      if (finalPng) fs.copyFileSync(finalAttemptPng, finalPng);
      const manifestPath = path.join(artifactDir, 'manifest.json');
      const manifest = createArtifactManifest({
        artifactId,
        jobId,
        briefHash: hash,
        brief,
        finalPrompt: prompt,
        style: { id: style.id, nome: style.nome },
        provider: { id: generated.provider, model: generated.model },
        verdicts,
        pngPath: finalPng,
        noArtifactReason: semRecorteObrigatorio ? 'remoção de fundo obrigatória não produziu recorte avaliável' : undefined,
        durationMs: Date.now() - artifactStarted,
        costUsd: Math.round(artifactCostUsd * 1_000_000) / 1_000_000,
        costType: artifactCostType,
        costSource: [...artifactCostSources].join('; '),
        createdAt: this.deps.now().toISOString(),
      });
      writeManifest(manifestPath, manifest);
      artifacts.push({ n: artifactN, id: artifactId, styleId, pngPath: finalPng ?? null, manifestPath, manifest, verdict: judged.verdict });
      options.onProgress?.({ etapa: 'concluido', estilo: styleId, artefato: artifactN, concluidos: artifactN, total: styleIds.length, mensagem: `${styleId} concluído` });
    }

    const verdict = finalVerdict(artifacts);
    const result: MotorResult = { jobId, briefHash: hash, dir, artifacts, verdict, durationMs: Date.now() - started };
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 'atelie.job/v1', job_id: jobId, brief_hash: hash, artifacts: artifacts.map((a) => ({ n: a.n, id: a.id, manifest: path.relative(dir, a.manifestPath) })), verdict, duration_ms: result.durationMs }, null, 2), { mode: 0o600 });
    return result;
  }
}

export function criarMotor(options: MotorOptions = {}): AtelieMotor {
  return new AtelieMotor(options);
}

export type { StructuredBrief };
