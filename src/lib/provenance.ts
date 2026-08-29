import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { StructuredBrief } from './brief';
import type { Verdict } from '../types';

export const MANIFEST_SCHEMA = 'atelie.provenance/v1' as const;

export interface ProvenanceVerdict {
  tentativa: number;
  em: string;
  prompt: string;
  aprovado: boolean;
  nota: number | null;
  alinhamento: string;
  problemas: string[];
  sugestao_melhoria: string;
  prompt_sugerido: string;
  juiz?: { provider: string; model: string };
}

export interface ArtifactManifest {
  schema: typeof MANIFEST_SCHEMA;
  artifact_id: string;
  job_id: string;
  brief_hash: string;
  criado_em: string;
  prompt_final: string;
  estilo: { id: string; nome: string };
  provedor: { id: string; modelo: string };
  parametros: {
    modo: 'explicacao' | 'cena';
    tamanho: string;
    qualidade: 'low' | 'medium' | 'high';
    idioma: 'pt-BR';
    referencias: Array<{ nome: string; sha256?: string }>;
  };
  vereditos: ProvenanceVerdict[];
  arquivo: { nome: string; mime: 'image/png'; sha256: string; bytes: number };
  metricas: { duracao_ms: number; custo_usd?: number };
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
): ProvenanceVerdict {
  return {
    tentativa,
    em: at,
    prompt,
    aprovado: verdict.aprovado,
    nota: verdict.nota,
    alinhamento: verdict.alinhamento,
    problemas: verdict.problemas,
    sugestao_melhoria: verdict.sugestao_melhoria,
    prompt_sugerido: verdict.prompt_sugerido,
    juiz: judge,
  };
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
  costUsd?: number;
  createdAt?: string;
}): ArtifactManifest {
  const stat = fs.statSync(input.pngPath);
  return {
    schema: MANIFEST_SCHEMA,
    artifact_id: input.artifactId,
    job_id: input.jobId,
    brief_hash: input.briefHash,
    criado_em: input.createdAt ?? new Date().toISOString(),
    prompt_final: input.finalPrompt,
    estilo: input.style,
    provedor: { id: input.provider.id, modelo: input.provider.model },
    parametros: {
      modo: input.brief.modo ?? 'explicacao',
      tamanho: input.brief.tamanho,
      qualidade: input.brief.qualidade,
      idioma: input.brief.idioma,
      referencias: referenceReceipts(input.brief.refs),
    },
    vereditos: input.verdicts,
    arquivo: { nome: path.basename(input.pngPath), mime: 'image/png', sha256: sha256File(input.pngPath), bytes: stat.size },
    metricas: {
      duracao_ms: Math.max(0, Math.round(input.durationMs)),
      ...(input.costUsd == null ? {} : { custo_usd: input.costUsd }),
    },
  };
}

export function writeManifest(file: string, manifest: ArtifactManifest): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
