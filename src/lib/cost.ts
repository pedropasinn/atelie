import { readManifest } from '../state/manifest';
import { findStyle } from './userStyles';
import { orientacaoDeTamanho } from './proporcao';
import type { PanelVerdict, Session, Verdict } from '../types';

/*
 * Estimativa GROSSEIRA de custo (USD) por sessão. NÃO é faturamento — serve só
 * para dar ordem de grandeza no resumo/headless. Baseada em tabelas públicas de
 * preço (gpt-image da OpenAI para as imagens do Codex; custo de tokens dos
 * juízes) arredondadas para cima. Os provedores não expõem custo real aqui.
 */

type JudgeProvider = 'claude' | 'codex';

export type ImageOrientation = 'square' | 'portrait' | 'landscape';
export interface ImagePriceTable {
  low: Record<ImageOrientation, number>;
  medium: Record<ImageOrientation, number>;
  high: Record<ImageOrientation, number>;
}

export interface ImageCostEstimate {
  usd: number;
  tipo: 'estimativa';
  fonte: string;
}

/**
 * Proxy por saída, baseado na referência equivalente de API em 2026-08-29.
 * Não representa cobrança do canal Codex/ChatGPT. O operador pode substituir a
 * tabela inteira com ATELIE_IMAGE_PRICE_TABLE_JSON.
 */
export const DEFAULT_IMAGE_PRICE_TABLE: ImagePriceTable = {
  low: { square: 0.004, portrait: 0.005, landscape: 0.005 },
  medium: { square: 0.032, portrait: 0.05, landscape: 0.05 },
  high: { square: 0.11, portrait: 0.165, landscape: 0.165 },
};

function validPrice(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function loadImagePriceTable(env: NodeJS.ProcessEnv = process.env): { table: ImagePriceTable; source: string } {
  const raw = env.ATELIE_IMAGE_PRICE_TABLE_JSON?.trim();
  if (!raw) return { table: DEFAULT_IMAGE_PRICE_TABLE, source: 'tabela-padrao-atelie-2026-08-29' };
  try {
    const parsed = JSON.parse(raw) as Partial<Record<keyof ImagePriceTable, Partial<Record<ImageOrientation, unknown>>>>;
    const table = structuredClone(DEFAULT_IMAGE_PRICE_TABLE);
    for (const quality of ['low', 'medium', 'high'] as const) {
      for (const orientation of ['square', 'portrait', 'landscape'] as const) {
        table[quality][orientation] = validPrice(parsed[quality]?.[orientation], table[quality][orientation]);
      }
    }
    return { table, source: 'ATELIE_IMAGE_PRICE_TABLE_JSON' };
  } catch {
    return { table: DEFAULT_IMAGE_PRICE_TABLE, source: 'tabela-padrao-atelie-2026-08-29 (override inválido ignorado)' };
  }
}

function imageOrientation(size: string): ImageOrientation {
  return orientacaoDeTamanho(size) ?? 'square';
}

export function estimateImageCost(quality: 'low' | 'medium' | 'high', size: string, env: NodeJS.ProcessEnv = process.env): ImageCostEstimate {
  const { table, source } = loadImagePriceTable(env);
  return { usd: table[quality][imageOrientation(size)], tipo: 'estimativa', fonte: source };
}

// Custo aprox. por imagem gpt-image-2 (Codex) a ~1024², por qualidade.
const CODEX_BASE_USD: Record<string, number> = { low: 0.02, medium: 0.07, high: 0.19 };


// Custo aprox. por CHAMADA de juiz (imagem+rubrica na entrada, ~300 tokens na saída).
const JUDGE_CALL_USD: Record<JudgeProvider, number> = { claude: 0.012, codex: 0.01 };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Fator de custo pelo tamanho pedido (área relativa a 1024²). Default = 2K (~2.5x). */
function sizeFactor(sizeAlias?: string): number {
  if (!sizeAlias) return 2.5;
  const s = sizeAlias.trim().toUpperCase();
  if (s === '1K') return 1;
  if (s === '2K') return 2.5;
  if (s === '4K') return 8;
  const m = /^(\d+)X(\d+)$/.exec(s);
  if (m) {
    const area = Number(m[1]) * Number(m[2]);
    return Math.min(12, Math.max(0.5, area / (1024 * 1024)));
  }
  return 2.5;
}

function codexImageUsd(quality: string, sizeAlias?: string): number {
  const base = CODEX_BASE_USD[quality] ?? CODEX_BASE_USD.high;
  return base * sizeFactor(sizeAlias);
}

/** Classifica o provedor de um voto do painel pelo rótulo (manifest só guarda label). */
function providerFromLabel(label: string): JudgeProvider {
  const l = label.toLowerCase();
  if (l.includes('gpt') || l.includes('codex')) return 'codex';
  return 'claude';
}

function normProvider(p: string): JudgeProvider {
  return p === 'codex' ? 'codex' : 'claude';
}

function isPanel(v: Verdict | PanelVerdict): v is PanelVerdict {
  return Array.isArray((v as PanelVerdict).painel);
}

export interface CostBreakdown {
  codexImages: { count: number; usd: number };
  judge: { calls: number; usd: number; byProvider: Record<JudgeProvider, number> };
}

export interface CostEstimate {
  usd: number;
  breakdown: CostBreakdown;
  note: string;
}

interface GenRec {
  provider: string;
  styleId: string;
  sizeAlias?: string;
}

/**
 * Estima o custo total de uma sessão somando imagens (Codex por faixa de
 * qualidade/tamanho) e chamadas de juiz (aprox. por provedor). Lê o
 * manifest (cobre TODAS as iterações); se ele estiver vazio, cai no snapshot
 * `session.results` (última iteração). Valores documentados como estimativa.
 */
export function estimateSessionCost(session: Session): CostEstimate {
  const gens: GenRec[] = [];
  const judgeVotes: JudgeProvider[][] = [];

  for (const rec of readManifest(session.id)) {
    if (rec?.kind === 'generate' && rec.ok) {
      gens.push({
        provider: rec.provider ?? rec.meta?.resolved ?? session.genProvider ?? 'codex',
        styleId: rec.styleId ?? '',
        sizeAlias: rec.meta?.sizeRequested,
      });
    } else if (rec?.kind === 'verdict') {
      const painel = Array.isArray(rec.painel) ? rec.painel : null;
      judgeVotes.push(painel ? painel.map((p: any) => providerFromLabel(String(p?.label ?? 'claude'))) : ['claude']);
    }
  }

  // Fallback: manifest sem registros → deriva do snapshot da última iteração.
  if (gens.length === 0 && judgeVotes.length === 0) {
    for (const r of session.results ?? []) {
      if (!r.ok) continue;
      gens.push({
        provider: r.meta?.resolved ?? r.job.provider ?? session.genProvider ?? 'codex',
        styleId: r.job.styleId,
        sizeAlias: r.job.size ?? r.meta?.sizeRequested,
      });
      if (r.verdict) {
        judgeVotes.push(isPanel(r.verdict) ? r.verdict.painel.map((p) => normProvider(p.spec.provider)) : ['claude']);
      }
    }
  }

  let codexCount = 0;
  let codexUsd = 0;
  for (const g of gens) {
    const style = findStyle(g.styleId);
    // Qualidade por imagem não é persistida; usa o default do estilo como proxy.
    const quality = style?.defaults.quality ?? 'high';
    const sizeAlias = g.sizeAlias ?? style?.defaults.size;
    codexCount++;
    codexUsd += codexImageUsd(quality, sizeAlias);
  }

  const byProvider: Record<JudgeProvider, number> = { claude: 0, codex: 0 };
  let judgeCalls = 0;
  for (const votes of judgeVotes) {
    for (const p of votes) {
      judgeCalls++;
      byProvider[p] += JUDGE_CALL_USD[p];
    }
  }
  const judgeUsd = byProvider.claude + byProvider.codex;

  return {
    usd: round2(codexUsd + judgeUsd),
    breakdown: {
      codexImages: { count: codexCount, usd: round2(codexUsd) },
      judge: {
        calls: judgeCalls,
        usd: round2(judgeUsd),
        byProvider: { claude: round2(byProvider.claude), codex: round2(byProvider.codex) },
      },
    },
    note: 'estimativa aproximada — não é faturamento',
  };
}
