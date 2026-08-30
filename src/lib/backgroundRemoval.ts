import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './runner';

export type FundoMotor = 'rembg' | 'cor-solida' | 'nenhum';

export interface FundoMetricas {
  fracao_transparente: number;
  fracao_opaca: number;
  fracao_semitransparente: number;
  borda_transparente: number;
  bbox: { x: number; y: number; largura: number; altura: number } | null;
  margem_minima_pct: number;
  componentes_conexos: number;
  fracao_maior_componente: number;
  fracao_objeto_cor_de_fundo: number;
  faixa_antialias_px: number;
  fracao_semitransparente_fora_da_faixa: number;
  halo: number;
}

export interface FundoResultado {
  ok: boolean;
  motor: FundoMotor;
  modelo: string;
  metricas: FundoMetricas;
  problemas: string[];
}

export interface FundoLimites {
  fracao_transparente_min?: number;
  fracao_transparente_max?: number;
  borda_transparente_min?: number;
  margem_minima_pct_min?: number;
  fracao_maior_componente_min?: number;
  halo_max?: number;
  tolerancia_cor?: number;
}

export interface RemoveBackgroundInput {
  pngPath: string;
  outPath: string;
  composicaoPath?: string;
  motor: FundoMotor;
  modelo: string;
  limites?: FundoLimites;
  signal?: AbortSignal;
}

export interface RemoveBackgroundOutput {
  pngPath: string;
  composicaoPath?: string;
  resultado: FundoResultado;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Resolve em runtime porque `process.resourcesPath` só existe no Electron. */
export function resolveBackgroundScript(): string {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidatos = [
    process.env.ATELIE_FUNDO_SCRIPT?.trim(),
    resourcesPath ? path.join(resourcesPath, 'fundo', 'remover_fundo.py') : undefined,
    path.join(REPO_ROOT, 'scripts', 'remover_fundo.py'),
    path.resolve(process.cwd(), 'scripts', 'remover_fundo.py'),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const encontrado = candidatos.find((candidate) => fs.existsSync(candidate));
  if (!encontrado) throw new Error(`remoção de fundo indisponível: script não encontrado (${candidatos.join(', ')})`);
  return encontrado;
}

function limiteArgs(limites: FundoLimites | undefined): string[] {
  if (!limites) return [];
  const mapa: Array<[keyof FundoLimites, string]> = [
    ['fracao_transparente_min', '--fracao-transparente-min'],
    ['fracao_transparente_max', '--fracao-transparente-max'],
    ['borda_transparente_min', '--borda-transparente-min'],
    ['margem_minima_pct_min', '--margem-minima-pct-min'],
    ['fracao_maior_componente_min', '--fracao-maior-componente-min'],
    ['halo_max', '--halo-max'],
    ['tolerancia_cor', '--tolerancia-cor'],
  ];
  return mapa.flatMap(([campo, flag]) => limites[campo] == null ? [] : [flag, String(limites[campo])]);
}

function pythonBin(): string {
  const configurado = process.env.ATELIE_FUNDO_PYTHON?.trim();
  if (configurado) return configurado;
  const venv = path.join(REPO_ROOT, '.venv-fundo', 'bin', 'python');
  if (!fs.existsSync(venv)) throw new Error('remoção de fundo indisponível: configure ATELIE_FUNDO_PYTHON ou crie .venv-fundo');
  return venv;
}

function timeoutMs(): number {
  const value = Number(process.env.ATELIE_FUNDO_TIMEOUT_MS ?? 120_000);
  return Number.isFinite(value) && value > 0 ? value : 120_000;
}

function pythonEnv(): NodeJS.ProcessEnv {
  const permitido = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'U2NET_HOME', 'XDG_CACHE_HOME',
    'USERPROFILE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH'];
  return Object.fromEntries(permitido.flatMap((key) => process.env[key] == null ? [] : [[key, process.env[key]]])) as NodeJS.ProcessEnv;
}

export async function defaultRemoveBackground(input: RemoveBackgroundInput): Promise<RemoveBackgroundOutput> {
  const args = [
    resolveBackgroundScript(),
    '--entrada', input.pngPath,
    '--saida', input.outPath,
    '--motor', input.motor,
    '--modelo', input.modelo,
    '--json',
    ...(input.composicaoPath ? ['--composicao', input.composicaoPath] : []),
    ...limiteArgs(input.limites),
  ];
  let execucao: Awaited<ReturnType<typeof run>['done']>;
  try {
    execucao = await run(pythonBin(), args, { signal: input.signal, timeoutMs: timeoutMs(), env: pythonEnv() }).done;
  } catch (error) {
    const detalhe = error instanceof Error ? error.message : String(error);
    throw new Error(detalhe.startsWith('remoção de fundo indisponível') ? detalhe : `remoção de fundo indisponível: ${detalhe}`);
  }
  let resultado: FundoResultado | undefined;
  try {
    resultado = JSON.parse(execucao.stdout.trim()) as FundoResultado;
  } catch {
    throw new Error('remoção de fundo indisponível: script não retornou JSON válido');
  }
  if (execucao.code !== 0 || !resultado || !Array.isArray(resultado.problemas)
    || typeof resultado.metricas?.fracao_transparente !== 'number') {
    const detalhe = resultado?.problemas?.join('; ') || `script encerrou com código ${execucao.code}`;
    throw new Error(`remoção de fundo indisponível: ${detalhe}`);
  }
  if (!fs.existsSync(input.outPath)) throw new Error('remoção de fundo indisponível: saída não foi escrita');
  return {
    pngPath: input.outPath,
    composicaoPath: input.composicaoPath && fs.existsSync(input.composicaoPath) ? input.composicaoPath : undefined,
    resultado,
  };
}
