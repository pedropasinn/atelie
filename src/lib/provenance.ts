import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { overlayLabels, type OverlayLabel, type StructuredBrief } from './brief';
import type { ResultadoConteudo } from './juizConteudo';
import type { Verdict } from '../types';
import { ATELIE_VERSION } from '../version';
import type { VerificacaoProporcao } from './proporcao';

export const MANIFEST_SCHEMA = 'atelie.provenance/v1' as const;

export interface ProvenanceVerdict {
  tentativa: number;
  em: string;
  prompt: string;
  aprovado: boolean;
  nota: number | null;
  alinhamento: string;
  problemas: string[];
  avisos?: string[];
  sugestao_melhoria: string;
  prompt_sugerido: string;
  proporcao: VerificacaoProporcao;
  juiz?: { provider: string; model: string };
  duracao_ms: number;
  geracao_ms: number;
  julgamento_ms: number;
  conteudo?: {
    aprovado: boolean;
    transcricao: string[];
    faltantes: string[];
    extras: string[];
    numeracao: string[];
    ordem_incorreta: string[][];
    problemas: string[];
    juiz: { provider: string; model: string };
  };
  visual?: {
    aprovado: boolean;
    nota: number | null;
    alinhamento: string;
    problemas: string[];
    sugestao_melhoria: string;
    prompt_sugerido: string;
    juiz: { provider: string; model: string };
  } | null;
}

export interface ArtifactManifest {
  schema: typeof MANIFEST_SCHEMA;
  artifact_id: string;
  job_id: string;
  brief_hash: string;
  criado_em: string;
  atelie_versao: string;
  prompt_final: string;
  estilo: { id: string; nome: string };
  provedor: { id: string; modelo: string };
  tamanho_solicitado: string;
  proporcao: VerificacaoProporcao;
  parametros: {
    modo: 'explicacao' | 'cena';
    provedor_solicitado: 'codex';
    texto_fora_da_imagem: boolean;
    texto_extra_permitido: boolean;
    largura_final_px?: number;
    tamanho: string;
    proporcao_estrita: boolean;
    qualidade: 'low' | 'medium' | 'high';
    idioma: 'pt-BR';
    referencias: Array<{ nome: string; sha256?: string }>;
  };
  rotulos_overlay: OverlayLabel[];
  vereditos: ProvenanceVerdict[];
  arquivo: { nome: string; mime: 'image/png'; sha256: string; bytes: number; dimensoes: { largura: number; altura: number } };
  metricas: { duracao_ms: number; custo_usd: number; custo_tipo: 'estimativa' | 'informado'; custo_fonte: string };
}

export function pngDimensions(file: string): { largura: number; altura: number } {
  const fd = fs.openSync(file, 'r');
  const header = Buffer.alloc(24);
  try {
    const bytes = fs.readSync(fd, header, 0, header.length, 0);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (bytes < 24 || !header.subarray(0, 8).equals(signature) || header.toString('ascii', 12, 16) !== 'IHDR') {
      throw new Error('artefato final não é um PNG com IHDR válido');
    }
    const largura = header.readUInt32BE(16);
    const altura = header.readUInt32BE(20);
    if (!largura || !altura) throw new Error('artefato final tem dimensões PNG inválidas');
    return { largura, altura };
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256File(file: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** Referências entram por hash e basename, nunca por caminho absoluto. */
export function referenceReceipts(refs: string[]): Array<{ nome: string; sha256?: string }> {
  return refs.map((ref) => {
    try {
      return { nome: path.basename(ref), sha256: sha256File(ref) };
    } catch {
      return { nome: path.basename(ref) };
    }
  });
}

export function provenanceVerdict(
  tentativa: number,
  prompt: string,
  verdict: Verdict,
  judge?: { provider: string; model: string },
  at = new Date().toISOString(),
  durations: { totalMs: number; generationMs: number; judgmentMs: number } = { totalMs: 0, generationMs: 0, judgmentMs: 0 },
  checks?: {
    conteudo: ResultadoConteudo;
    transcricao: string[];
    problemasConteudo: string[];
    juizConteudo: { provider: string; model: string };
    visual: { verdict: Verdict; judge: { provider: string; model: string } } | null;
  },
): ProvenanceVerdict {
  if (!verdict.proporcao) throw new Error('veredito sem verificação de proporção');
  const receipt: ProvenanceVerdict = {
    tentativa,
    em: at,
    prompt,
    aprovado: verdict.aprovado,
    nota: verdict.nota,
    alinhamento: verdict.alinhamento,
    problemas: verdict.problemas,
    avisos: verdict.avisos,
    sugestao_melhoria: verdict.sugestao_melhoria,
    prompt_sugerido: verdict.prompt_sugerido,
    proporcao: verdict.proporcao,
    juiz: judge,
    duracao_ms: Math.max(0, Math.round(durations.totalMs)),
    geracao_ms: Math.max(0, Math.round(durations.generationMs)),
    julgamento_ms: Math.max(0, Math.round(durations.judgmentMs)),
  };
  if (checks) {
    receipt.conteudo = {
      aprovado: checks.conteudo.ok,
      transcricao: checks.transcricao,
      faltantes: checks.conteudo.faltantes,
      extras: checks.conteudo.extras,
      numeracao: checks.conteudo.numeracao,
      ordem_incorreta: checks.conteudo.ordemIncorreta,
      problemas: checks.problemasConteudo,
      juiz: checks.juizConteudo,
    };
    receipt.visual = checks.visual ? {
      aprovado: checks.visual.verdict.aprovado,
      nota: checks.visual.verdict.nota,
      alinhamento: checks.visual.verdict.alinhamento,
      problemas: checks.visual.verdict.problemas,
      sugestao_melhoria: checks.visual.verdict.sugestao_melhoria,
      prompt_sugerido: checks.visual.verdict.prompt_sugerido,
      juiz: checks.visual.judge,
    } : null;
  }
  return receipt;
}

export function createArtifactManifest(input: {
  artifactId: string;
  jobId: string;
  briefHash: string;
  brief: StructuredBrief;
  finalPrompt: string;
  style: { id: string; nome: string };
  provider: { id: string; model: string };
  verdicts: ProvenanceVerdict[];
  pngPath: string;
  durationMs: number;
  costUsd: number;
  costType: 'estimativa' | 'informado';
  costSource: string;
  createdAt?: string;
}): ArtifactManifest {
  const stat = fs.statSync(input.pngPath);
  const dimensoes = pngDimensions(input.pngPath);
  return {
    schema: MANIFEST_SCHEMA,
    artifact_id: input.artifactId,
    job_id: input.jobId,
    brief_hash: input.briefHash,
    criado_em: input.createdAt ?? new Date().toISOString(),
    atelie_versao: ATELIE_VERSION,
    prompt_final: input.finalPrompt,
    estilo: input.style,
    provedor: { id: input.provider.id, modelo: input.provider.model },
    tamanho_solicitado: input.brief.tamanho,
    proporcao: input.verdicts[input.verdicts.length - 1].proporcao,
    parametros: {
      modo: input.brief.modo ?? 'explicacao',
      provedor_solicitado: input.brief.provedor ?? 'codex',
      texto_fora_da_imagem: input.brief.texto_fora_da_imagem === true,
      texto_extra_permitido: input.brief.texto_extra_permitido === true,
      largura_final_px: input.brief.largura_final_px,
      tamanho: input.brief.tamanho,
      proporcao_estrita: input.brief.proporcao_estrita === true,
      qualidade: input.brief.qualidade,
      idioma: input.brief.idioma,
      referencias: referenceReceipts(input.brief.refs),
    },
    rotulos_overlay: input.brief.texto_fora_da_imagem ? overlayLabels(input.brief) : [],
    vereditos: input.verdicts,
    arquivo: { nome: path.basename(input.pngPath), mime: 'image/png', sha256: sha256File(input.pngPath), bytes: stat.size, dimensoes },
    metricas: {
      duracao_ms: Math.max(0, Math.round(input.durationMs)),
      custo_usd: input.costUsd,
      custo_tipo: input.costType,
      custo_fonte: input.costSource,
    },
  };
}

export function writeManifest(file: string, manifest: ArtifactManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
