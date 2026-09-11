import fs from 'fs';
import { WRAPPER_CJS } from '../config';
import type { GenJob, GenMeta, ProgressEvent } from '../types';
import { run } from './runner';
import { nodeBin, nodeSpawnEnv } from './nodeBin';

/** Aspect → dimensão concreta múltipla de 16 (só DICA no Codex, mas passamos). */
export function aspectToSize(aspect: string): string {
  switch (aspect) {
    case 'portrait':
      return '1536x2048';
    case 'landscape':
      return '2048x1152';
    case 'square':
      return '2048x2048';
    default:
      return '2048x2048';
  }
}

/**
 * Normaliza o tamanho para um valor que o binário aceita: aliases `2K`/`4K`,
 * ou `WxH` (múltiplos de 16). O binário NÃO conhece `1K` → mapeamos para
 * `1024x1024`. Qualquer coisa não reconhecida cai num default seguro em vez de
 * repassar um valor inválido (que o binário rejeitaria com `invalid value`).
 */
function resolveSize(sizeAlias: string): string {
  const s = sizeAlias.trim();
  const up = s.toUpperCase();
  if (up === '1K') return '1024x1024';
  if (up === '2K') return '2K';
  if (up === '4K') return '4K';
  if (/^\d+x\d+$/i.test(s)) return s.toLowerCase();
  if (s === 'square' || s === 'portrait' || s === 'landscape') return aspectToSize(s);
  return '2048x2048';
}

/** Monta os `--ref-image <p>` (repetível, até 16) do modo edit. Pula caminhos vazios. */
export function refImageArgs(refs: string[]): string[] {
  const out: string[] = [];
  for (const p of refs) {
    if (p) out.push('--ref-image', p);
  }
  return out;
}

/** Subcomando conforme o modo. Flags globais ficam ANTES disto (ver contrato). */
function subArgs(job: GenJob): string[] {
  if (job.mode === 'transparent') return ['transparent', 'generate'];
  if (job.mode === 'edit') {
    // Série: uma `--ref-image` por item de `refs`; fallback ao `refPng` legado.
    const refs = job.refs?.length ? job.refs : job.refPng ? [job.refPng] : [];
    const ra = refImageArgs(refs);
    // O wrapper exige ao menos uma `--ref-image` no edit; sem refs, mantém o legado (string vazia).
    return ['images', 'edit', ...(ra.length ? ra : ['--ref-image', job.refPng ?? ''])];
  }
  return ['images', 'generate'];
}

interface BackendError extends Error {
  code?: string;
  raw?: string;
}

/**
 * Gera (ou edita, ou gera transparente) uma imagem via wrapper Codex.
 * Trata os 3 modos lendo `job.mode`. NUNCA passa --n/--mask/--moderation/--input-fidelity.
 */
export async function generate(
  job: GenJob,
  sizeAlias: string,
  quality: string,
  onProgress?: (e: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<{ pngPath: string; meta: GenMeta }> {
  const size = resolveSize(sizeAlias);
  const args = [
    WRAPPER_CJS,
    // FLAGS GLOBAIS sempre antes do subcomando
    '--json',
    '--json-events',
    '--provider',
    'codex',
    ...subArgs(job),
    '--prompt',
    job.prompt,
    '--out',
    job.outPath,
    '--size',
    size,
    '--quality',
    quality,
  ];
  // `transparent generate` NÃO aceita --format (só --prompt/--out/--size/--quality/--moderation).
  // Só os subcomandos images generate/edit aceitam --format.
  if (job.mode !== 'transparent') {
    args.push('--format', 'png');
  }
  // O default do wrapper (`gpt-5.4`) deixou de existir na conta ChatGPT e devolve
  // HTTP 400. `ATELIE_GEN_MODEL` fixa o modelo condutor do caminho Codex/responses.
  // `transparent generate` não aceita `-m`.
  const genModel = process.env.ATELIE_GEN_MODEL?.trim();
  if (genModel && job.mode !== 'transparent') {
    args.push('-m', genModel);
  }

  const handle = run(nodeBin(), args, {
    signal,
    env: nodeSpawnEnv(),
    onStderrLine: (line) => {
      if (!onProgress) return;
      const t = line.trim();
      if (!t) return;
      let ev: any;
      try {
        ev = JSON.parse(t);
      } catch {
        return; // linha parcial / não-JSON
      }
      if (ev.kind === 'sse') return; // ruído do passthrough Codex
      if (ev.kind === 'progress') {
        onProgress({
          jobId: job.id,
          phase: ev.data?.phase ?? '',
          percent: ev.data?.percent ?? 0,
          message: ev.data?.message ?? '',
        });
      } else if (ev.type === 'retry_scheduled') {
        onProgress({ jobId: job.id, phase: 'retry', percent: 0, message: 'retentando…' });
      }
    },
  });

  const { stdout } = await handle.done;

  let json: any;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    const e: BackendError = Object.assign(new Error('resposta do wrapper não é JSON válido'), {
      code: 'parse_failed',
      raw: stdout,
    });
    throw e;
  }

  if (!json.ok) {
    const e: BackendError = Object.assign(new Error(json.error?.message || 'falha na geração'), {
      code: json.error?.code,
    });
    throw e;
  }

  // --out é a fonte de verdade do caminho — confirma com existsSync
  if (!fs.existsSync(job.outPath)) {
    const e: BackendError = Object.assign(new Error(`arquivo de saída não encontrado: ${job.outPath}`), {
      code: 'output_missing',
    });
    throw e;
  }

  const meta: GenMeta = {
    resolved: json.provider_selection?.resolved ?? '',
    retryCount: json.retry?.count,
    sizeRequested: sizeAlias,
  };
  return { pngPath: job.outPath, meta };
}

/** Conveniência: edição a partir de uma imagem-âncora (força mode='edit'). */
export async function edit(
  job: GenJob,
  sizeAlias: string,
  quality: string,
  onProgress?: (e: ProgressEvent) => void,
): Promise<{ pngPath: string; meta: GenMeta }> {
  return generate({ ...job, mode: 'edit' }, sizeAlias, quality, onProgress);
}

/** Força o wrapper a resolver o runtime e reporta o provider selecionado. */
export async function doctor(): Promise<{ resolved: string; ok: boolean }> {
  try {
    const { stdout } = await run(nodeBin(), [WRAPPER_CJS, '--json', 'doctor'], { env: nodeSpawnEnv() }).done;
    const json = JSON.parse(stdout.trim());
    return { resolved: json.provider_selection?.resolved ?? '', ok: json.ok !== false };
  } catch {
    return { resolved: '', ok: false };
  }
}

/** Checa se a auth do Codex está pronta. */
export async function authInspect(): Promise<{ codexReady: boolean }> {
  try {
    const { stdout } = await run(nodeBin(), [WRAPPER_CJS, '--json', 'auth', 'inspect'], { env: nodeSpawnEnv() }).done;
    const json = JSON.parse(stdout.trim());
    return { codexReady: Boolean(json.providers?.codex?.ready) };
  } catch {
    return { codexReady: false };
  }
}
