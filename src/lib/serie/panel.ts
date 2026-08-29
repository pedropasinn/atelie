import fs from 'fs';
import path from 'path';
import { generate as codexGenerate } from '../imageBackend';
import { loadSettings } from '../settings';
import { buildCanonBlock } from './canon';
import { judgeConsistency } from './consistencyJudge';
import { appendSerie, panelPath, saveSerie } from './store';
import type { Canon, ConsistencyVerdict, GenJob, JudgeSpec, Painel, ProgressEvent, Serie } from '../../types';

export interface PanelOpts {
  consistThreshold?: number;
  cenaThreshold?: number;
  maxTentativas?: number;
  incluirAnterior?: boolean;
  judgeSpec?: JudgeSpec;
  size?: string;
  quality?: string;
  onProgress?: (e: ProgressEvent) => void;
  onLog?: (msg: string) => void;
  signal?: AbortSignal;
  /** Persistir o snapshot da série a cada tentativa (default: sim). */
  persist?: boolean;
  /**
   * Veredito inicial semeado no loop (tela "Melhorar" da TUI): reforça os drifts
   * da rodada anterior já na 1ª tentativa desta chamada.
   */
  seedFeedback?: ConsistencyVerdict;
}

function nameKey(s: string): string {
  return s.trim().toLowerCase();
}

/** Âncoras (existentes em disco) dos personagens presentes no painel. */
function anchorRefs(canon: Canon, personagens: string[]): string[] {
  const present = new Set(personagens.map(nameKey));
  const all = present.size === 0; // painel sem lista explícita → todas as âncoras
  const refs: string[] = [];
  for (const p of canon.personagens ?? []) {
    if ((all || present.has(nameKey(p.nome))) && p.anchorPng && fs.existsSync(p.anchorPng)) refs.push(p.anchorPng);
  }
  return refs;
}

/**
 * Prompt do painel: bloco invariante do cânone + a CENA; se houver feedback de drift,
 * anexa a sugestão de ajuste e as diferenças a corrigir vs a referência.
 */
export function buildPanelPrompt(canon: Canon, painel: Painel, feedback?: ConsistencyVerdict): string {
  let prompt = buildCanonBlock(canon, painel.personagens) + ' CENA: ' + painel.cena;
  if (feedback && (feedback.sugestao_melhoria?.trim() || (feedback.drifts && feedback.drifts.length))) {
    prompt +=
      ' AJUSTE (mantendo consistência): ' +
      (feedback.sugestao_melhoria ?? '') +
      ' Diferenças a corrigir vs a referência: ' +
      (feedback.drifts ?? []).join('; ');
  }
  return prompt;
}

/** Painel anterior (maior n < painel.n) que já tem imagem — p/ continuidade. */
function previousPanel(serie: Serie, n: number): Painel | undefined {
  return (serie.paineis ?? [])
    .filter((p) => p.n < n && p.pngPath)
    .sort((a, b) => b.n - a.n)[0];
}

/**
 * LOOP DE COERÊNCIA de um painel: edit multi-ref (âncoras dos personagens presentes,
 * + painel anterior se `incluirAnterior`) → judgeConsistency → reforça os drifts no
 * próximo prompt, até (consistencia>=consistThreshold E cenaNota>=cenaThreshold) ou
 * esgotar maxTentativas. Painéis usam sempre codex para edição referenciada.
 */
export async function generatePanel(serie: Serie, painel: Painel, opts: PanelOpts = {}): Promise<Painel> {
  const s = loadSettings();
  const consistThreshold = opts.consistThreshold ?? s.consistThreshold;
  const cenaThreshold = opts.cenaThreshold ?? s.cenaThreshold;
  const maxTentativas = Math.max(1, opts.maxTentativas ?? s.maxTentativas);
  const incluirAnterior = opts.incluirAnterior ?? s.incluirAnterior;
  const judgeSpec = opts.judgeSpec ?? s.serieJudge;
  const persist = opts.persist ?? true;
  const canon = serie.canon;

  const charRefs = anchorRefs(canon, painel.personagens); // juiz compara só contra âncoras
  const prev = incluirAnterior ? previousPanel(serie, painel.n) : undefined;
  const genRefs = prev?.pngPath ? [...charRefs, prev.pngPath] : [...charRefs];

  const outPath = panelPath(serie.id, painel.n);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  let feedback: ConsistencyVerdict | undefined = opts.seedFeedback;
  painel.aprovado = false;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    if (opts.signal?.aborted) break;
    const prompt = buildPanelPrompt(canon, painel, feedback);
    painel.prompt = prompt;
    painel.tentativas = tentativa;
    opts.onLog?.(`painel ${painel.n}: tentativa ${tentativa}/${maxTentativas}…`);

    const job: GenJob = {
      id: `panel-${painel.n}-t${tentativa}`,
      styleId: canon.estiloId,
      index: painel.n,
      prompt,
      mode: 'edit',
      refs: genRefs.length ? genRefs : undefined,
      refPng: genRefs[0],
      outPath,
    };
    const { pngPath } = await codexGenerate(job, opts.size ?? '2K', opts.quality ?? 'high', opts.onProgress, opts.signal);
    painel.pngPath = pngPath;

    const v = await judgeConsistency(charRefs, pngPath, canon, painel.cena, judgeSpec, opts.signal);
    painel.consistencia = v.consistencia;
    painel.cenaNota = v.cenaNota;
    painel.drifts = v.drifts;
    painel.sugestao_melhoria = v.sugestao_melhoria;
    painel.prompt_sugerido = v.prompt_sugerido;
    appendSerie(serie.id, {
      kind: tentativa === 1 ? 'panel' : 'iterate',
      n: painel.n,
      tentativa,
      pngPath,
      consistencia: v.consistencia,
      cenaNota: v.cenaNota,
      drifts: v.drifts,
      prompt,
    });
    if (persist) saveSerie(serie);
    opts.onLog?.(
      `painel ${painel.n} t${tentativa}: consistência ${v.consistencia ?? '—'} · cena ${v.cenaNota ?? '—'}`,
    );

    const okC = v.consistencia != null && v.consistencia >= consistThreshold;
    const okS = v.cenaNota != null && v.cenaNota >= cenaThreshold;
    if (okC && okS) {
      painel.aprovado = true;
      break;
    }
    feedback = v; // reforça os drifts na próxima tentativa
  }
  if (persist) saveSerie(serie);
  return painel;
}
