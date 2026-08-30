import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { SESSIONS_ROOT } from '../config';
import type { GenJob, ProgressEvent, Verdict } from '../types';
import { briefHash, briefStyles, buildLegibilityRubric, composeBriefPrompt, normalizeBrief, type ComposedBrief, type StructuredBrief } from './brief';
import { resolveGenProvider } from './genProviders';
import { askImagesRaw } from './judgeProviders';
import { coerce } from './judge';
import { extractJson } from './jsonx';
import { cliEnabled, loadSettings } from './settings';
import { findStyle } from './userStyles';
import { createArtifactManifest, pngDimensions, provenanceVerdict, writeManifest, type ArtifactManifest } from './provenance';
import { estimateImageCost } from './cost';
import { verificarProporcao, type VerificacaoProporcao } from './proporcao';

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

export interface MotorDependencies {
  generate(input: MotorGenerationInput): Promise<MotorGenerationOutput>;
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
  pngPath: string;
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

async function defaultJudge(input: MotorJudgeInput): Promise<MotorJudgeOutput> {
  const settings = loadSettings();
  const spec = cliEnabled(settings.singleJudge.provider, settings)
    ? settings.singleJudge
    : settings.judgePanel.find((candidate) => cliEnabled(candidate.provider, settings));
  if (!spec) throw new Error('nenhum juiz de legibilidade está habilitado');
  const threshold = settings.approveThreshold;
  const rubric = buildLegibilityRubric(input.composed, threshold);
  const raw = await askImagesRaw(spec, [input.pngPath], rubric, input.signal);
  const verdict = coerce(extractJson(raw), raw, threshold);
  // Falha textual é impeditiva mesmo se o modelo marcou `aprovado:true` por engano.
  if (input.composed.brief.modo !== 'cena' && verdict.problemas.some((p) => /ileg[ií]vel|ortografi|acentua|microtexto|pseudotexto/i.test(p))) {
    verdict.aprovado = false;
  }
  return { verdict, provider: spec.provider, model: spec.model };
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
      const verdicts = [];
      let artifactCostUsd = 0;
      let artifactCostType: 'estimativa' | 'informado' = 'estimativa';
      const artifactCostSources = new Set<string>();
      const maxAttempts = 1 + (brief.iteracoes ?? 1);
      const artifactStarted = Date.now();

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const attemptStarted = Date.now();
        assertNotAborted(options.signal);
        const outPath = path.join(artifactDir, `tentativa-${String(attempt).padStart(2, '0')}.png`);
        options.onProgress?.({ etapa: attempt === 1 ? 'gerando' : 'iterando', estilo: styleId, artefato: artifactN, tentativa: attempt, concluidos: styleIndex, total: styleIds.length, mensagem: `gerando ${styleId}, tentativa ${attempt}` });
        generated = await this.deps.generate({
          prompt,
          outPath,
          styleId,
          size: brief.tamanho || style.defaults.size,
          quality: brief.qualidade,
          refs: brief.refs,
          mode: brief.refs.length ? 'edit' : style.defaults.background === 'transparent' ? 'transparent' : 'generate',
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
        assertNotAborted(options.signal);
        options.onProgress?.({ etapa: 'julgando', estilo: styleId, artefato: artifactN, tentativa: attempt, concluidos: styleIndex, total: styleIds.length, mensagem: `avaliando legibilidade de ${styleId}` });
        const judgmentStarted = Date.now();
        judged = await this.deps.judge({ pngPath: generated.pngPath, composed: { ...composed, prompt }, signal: options.signal });
        const avisoProporcao = proporcao.ok ? undefined : proporcaoDivergente(brief.tamanho, dimensoes, proporcao);
        judged = {
          ...judged,
          verdict: {
            ...judged.verdict,
            aprovado: brief.proporcao_estrita && !proporcao.ok ? false : judged.verdict.aprovado,
            problemas: brief.proporcao_estrita && avisoProporcao
              ? [...new Set([...judged.verdict.problemas, avisoProporcao])]
              : judged.verdict.problemas,
            avisos: !brief.proporcao_estrita && avisoProporcao
              ? [...new Set([...(judged.verdict.avisos ?? []), avisoProporcao])]
              : judged.verdict.avisos,
            proporcao,
          },
        };
        const judgmentMs = Date.now() - judgmentStarted;
        verdicts.push(provenanceVerdict(
          attempt,
          prompt,
          judged.verdict,
          { provider: judged.provider, model: judged.model },
          this.deps.now().toISOString(),
          { totalMs: Date.now() - attemptStarted, generationMs, judgmentMs },
        ));
        if (judged.verdict.aprovado || attempt === maxAttempts) break;
        prompt = [
          judged.verdict.prompt_sugerido.trim() || prompt,
          judged.verdict.sugestao_melhoria.trim() ? `AJUSTE OBRIGATÓRIO: ${judged.verdict.sugestao_melhoria.trim()}.` : '',
          brief.modo === 'cena' || brief.texto_fora_da_imagem
            ? 'Mantenha a imagem sem qualquer texto.'
            : `Mantenha exatamente estas strings e nenhuma outra: ${composed.stringsVisiveis.map((s) => `"${s}"`).join(', ')}. Sem microtexto.`,
          brief.proporcao_estrita && !proporcao.ok ? instrucaoProporcao(brief.tamanho, proporcao) : '',
        ].filter(Boolean).join(' ');
      }

      if (!generated || !judged) throw new Error(`geração do estilo "${styleId}" não produziu resultado`);
      const finalPng = path.join(artifactDir, 'artifact.png');
      fs.copyFileSync(generated.pngPath, finalPng);
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
        durationMs: Date.now() - artifactStarted,
        costUsd: Math.round(artifactCostUsd * 1_000_000) / 1_000_000,
        costType: artifactCostType,
        costSource: [...artifactCostSources].join('; '),
        createdAt: this.deps.now().toISOString(),
      });
      writeManifest(manifestPath, manifest);
      artifacts.push({ n: artifactN, id: artifactId, styleId, pngPath: finalPng, manifestPath, manifest, verdict: judged.verdict });
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
