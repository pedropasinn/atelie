import fs from 'fs';
import path from 'path';
import { CONFIG_FILE } from '../config';
import type { CliId, GenProviderId, JudgeSpec, Settings } from '../types';

/** Modelos de juiz padrão (Anthropic + OpenAI). */
export const CLAUDE_JUDGE_MODEL = 'opus';
export const CODEX_JUDGE_MODEL = 'gpt-5.6-sol';

/** Painel de consenso padrão: Claude Opus 5 + Codex GPT-5.6-sol. */
function defaultPanel(): JudgeSpec[] {
  return [
    { provider: 'claude', model: process.env.ATELIE_JUDGE_MODEL || CLAUDE_JUDGE_MODEL, label: 'Claude Opus 5' },
    { provider: 'codex', model: process.env.ATELIE_CODEX_JUDGE_MODEL || CODEX_JUDGE_MODEL, label: 'Codex GPT-5.6-sol' },
  ];
}

function defaultSingleJudge(): JudgeSpec {
  return { provider: 'claude', model: process.env.ATELIE_JUDGE_MODEL || CLAUDE_JUDGE_MODEL, label: 'Claude Opus 5' };
}

/** Juiz de consistência da série. */
function defaultSerieJudge(): JudgeSpec {
  return { provider: 'claude', model: process.env.ATELIE_SERIE_JUDGE_MODEL || CLAUDE_JUDGE_MODEL, label: 'Claude Opus 5' };
}

/** Defaults recalculados a cada carga (respeitam env vigente). */
function defaults(): Settings {
  return {
    judgeModel: process.env.ATELIE_JUDGE_MODEL || CLAUDE_JUDGE_MODEL,
    approveThreshold: 7,
    // 0 = sem limite: dispara todos os jobs de uma vez (era 2 por vez).
    concurrency: Number(process.env.ATELIE_CONCURRENCY || 0),
    defaultVersionsPerStyle: 2,
    defaultQuality: 'high',
    viewerCmd: null,
    // Abre a pasta publicada assim que a geração termina; ATELIE_AUTO_OPEN=0 desliga.
    autoOpenFolder: process.env.ATELIE_AUTO_OPEN !== '0',
    genProvider: 'codex',
    judgeMode: process.env.ATELIE_JUDGE_MODE === 'unico' ? 'unico' : 'painel',
    judgePanel: defaultPanel(),
    singleJudge: defaultSingleJudge(),
    consistThreshold: 8,
    cenaThreshold: 7,
    maxTentativas: 3,
    incluirAnterior: true,
    serieJudge: defaultSerieJudge(),
    authMode: defaultAuthMode(),
    openaiApiKey: null,
    anthropicApiKey: null,
    googleApiKey: null,
    enabledClis: { codex: true, claude: true },
  };
}

/** Modo de auth default (honra ATELIE_AUTH_MODE se válido, senão 'cli'). */
function defaultAuthMode(): Settings['authMode'] {
  const v = process.env.ATELIE_AUTH_MODE;
  return v === 'apikey' || v === 'auto' || v === 'cli' ? v : 'cli';
}

const JUDGE_PROVIDERS = new Set(['claude', 'codex']);

function coerceJudgeSpec(raw: any, fb: JudgeSpec): JudgeSpec {
  if (!raw || typeof raw !== 'object') return fb;
  const provider = JUDGE_PROVIDERS.has(raw.provider) ? raw.provider : fb.provider;
  const model = typeof raw.model === 'string' && raw.model.trim() ? raw.model : fb.model;
  const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label : model;
  return { provider, model, label };
}

function coerce(raw: any): Settings {
  const d = defaults();
  if (!raw || typeof raw !== 'object') return d;
  const q = raw.defaultQuality;
  const quality: Settings['defaultQuality'] =
    q === 'low' || q === 'medium' || q === 'high' ? q : d.defaultQuality;
  const num = (v: any, fb: number) => (Number.isFinite(Number(v)) ? Number(v) : fb);
  // incluirAnterior aceita boolean nativo (config.json) OU string do editor da TUI ('sim'/'nao').
  const bool = (v: any, fb: boolean): boolean => {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      const t = v.trim().toLowerCase();
      if (['sim', 'true', '1', 'yes', 'on'].includes(t)) return true;
      if (['nao', 'não', 'false', '0', 'no', 'off'].includes(t)) return false;
    }
    return fb;
  };
  if (raw.genProvider != null && raw.genProvider !== 'codex') {
    throw new Error(`provedor de geração desconhecido nas configurações: "${String(raw.genProvider)}"`);
  }
  const genProvider: GenProviderId = 'codex';
  const judgeMode: Settings['judgeMode'] = raw.judgeMode === 'unico' || raw.judgeMode === 'painel' ? raw.judgeMode : d.judgeMode;
  const authMode: Settings['authMode'] = raw.authMode === 'apikey' || raw.authMode === 'auto' || raw.authMode === 'cli' ? raw.authMode : d.authMode;
  // Chave: string não-vazia vira o valor; qualquer outra coisa (null, '', número) → null.
  const key = (v: any): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const ce = raw.enabledClis && typeof raw.enabledClis === 'object' ? raw.enabledClis : {};
  const enabledClis = {
    codex: bool(ce.codex, d.enabledClis.codex),
    claude: bool(ce.claude, d.enabledClis.claude),
  };
  const judgePanel: JudgeSpec[] = Array.isArray(raw.judgePanel) && raw.judgePanel.length
    ? raw.judgePanel.map((spec: any, i: number) => coerceJudgeSpec(spec, d.judgePanel[i] ?? d.singleJudge))
    : d.judgePanel;
  return {
    judgeModel: typeof raw.judgeModel === 'string' && raw.judgeModel.trim() ? raw.judgeModel : d.judgeModel,
    approveThreshold: Math.max(0, Math.min(10, num(raw.approveThreshold, d.approveThreshold))),
    concurrency: Math.max(0, Math.round(num(raw.concurrency, d.concurrency))), // 0 = ilimitado
    defaultVersionsPerStyle: Math.max(1, Math.round(num(raw.defaultVersionsPerStyle, d.defaultVersionsPerStyle))),
    defaultQuality: quality,
    viewerCmd: typeof raw.viewerCmd === 'string' && raw.viewerCmd.trim() ? raw.viewerCmd : null,
    autoOpenFolder: bool(raw.autoOpenFolder, d.autoOpenFolder),
    genProvider,
    judgeMode,
    judgePanel,
    singleJudge: coerceJudgeSpec(raw.singleJudge, d.singleJudge),
    consistThreshold: Math.max(0, Math.min(10, num(raw.consistThreshold, d.consistThreshold))),
    cenaThreshold: Math.max(0, Math.min(10, num(raw.cenaThreshold, d.cenaThreshold))),
    maxTentativas: Math.max(1, Math.round(num(raw.maxTentativas, d.maxTentativas))),
    incluirAnterior: bool(raw.incluirAnterior, d.incluirAnterior),
    serieJudge: coerceJudgeSpec(raw.serieJudge, d.serieJudge),
    authMode,
    openaiApiKey: key(raw.openaiApiKey),
    anthropicApiKey: key(raw.anthropicApiKey),
    googleApiKey: key(raw.googleApiKey),
    enabledClis,
  };
}

/** Lê config.json; merge com defaults; tolera arquivo ausente/corrompido. */
export function loadSettings(): Settings {
  let raw: unknown;
  try {
    const txt = fs.readFileSync(CONFIG_FILE, 'utf8');
    raw = JSON.parse(txt);
  } catch {
    return defaults();
  }
  return coerce(raw);
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(coerce(s), null, 2));
}

/** Descrição dos campos para a tela de Configurações iterar. */
export const SETTINGS_FIELDS: Array<{
  key: keyof Settings;
  label: string;
  kind: 'string' | 'number' | 'enum';
  options?: string[];
}> = [
  { key: 'authMode', label: 'Modo de autenticação', kind: 'enum', options: ['cli', 'apikey', 'auto'] },
  { key: 'judgeMode', label: 'Modo do juiz', kind: 'enum', options: ['painel', 'unico'] },
  { key: 'judgeModel', label: 'Modelo do juiz claude', kind: 'string' },
  { key: 'approveThreshold', label: 'Nota mínima p/ aprovar', kind: 'number' },
  { key: 'concurrency', label: 'Workers simultâneos (0 = todos de uma vez)', kind: 'number' },
  { key: 'defaultVersionsPerStyle', label: 'Versões por estilo (default)', kind: 'number' },
  { key: 'defaultQuality', label: 'Qualidade (default)', kind: 'enum', options: ['low', 'medium', 'high'] },
  { key: 'viewerCmd', label: 'Comando do viewer (vazio = xdg-open)', kind: 'string' },
  { key: 'autoOpenFolder', label: 'Abrir a pasta ao terminar a geração', kind: 'enum', options: ['sim', 'nao'] },
  { key: 'consistThreshold', label: 'Série · consistência mínima', kind: 'number' },
  { key: 'cenaThreshold', label: 'Série · fidelidade à cena mínima', kind: 'number' },
  { key: 'maxTentativas', label: 'Série · tentativas por painel', kind: 'number' },
  { key: 'incluirAnterior', label: 'Série · usar painel anterior como referência', kind: 'enum', options: ['sim', 'nao'] },
];

// ── Feature-flags de CLI (habilitação por capacidade) ───────────────────────
export type Capability = 'geração' | 'juiz' | 'add-style' | 'cânone-série';

/** Quais CLIs entregam cada capacidade do app (independe do que está habilitado). */
export function capabilityMap(): Record<Capability, CliId[]> {
  return {
    'geração': ['codex'],
    'juiz': ['claude', 'codex'],
    'add-style': ['claude'],
    'cânone-série': ['claude'],
  };
}

/** true se a CLI está habilitada nas configurações (ausência = habilitada, compat legado). */
export function cliEnabled(id: CliId, settings: Settings): boolean {
  return settings.enabledClis?.[id] !== false;
}

/** Provedor de geração efetivo: só existe codex; erro claro se estiver desabilitado. */
export function resolveEnabledGenProvider(requested: GenProviderId, settings: Settings): GenProviderId {
  if (cliEnabled('codex', settings)) return 'codex';
  throw new Error('A CLI codex está desabilitada nas configurações — não há provedor de geração.');
}

/** Painel de juízes filtrado pelas CLIs habilitadas (default: painel intacto). */
export function enabledJudgePanel(panel: JudgeSpec[], settings: Settings): JudgeSpec[] {
  return panel.filter((spec) => cliEnabled(spec.provider, settings));
}

/** Lança se o juiz único pedir uma CLI desabilitada. */
export function assertJudgeEnabled(spec: JudgeSpec, settings: Settings): void {
  if (!cliEnabled(spec.provider, settings)) {
    throw new Error(`CLI ${spec.provider} está desabilitada nas configurações (juiz).`);
  }
}

/**
 * Valida (ANTES de gerar) se um run pode rodar com as CLIs habilitadas. Retorna uma
 * mensagem clara quando o provedor de geração pedido OU o juiz exige uma CLI desabilitada;
 * `null` quando está tudo ok. Usado pela camada de servidor (WS) para abortar cedo.
 */
export function validateRunClis(
  settings: Settings,
  run: { genProvider?: GenProviderId; judgeMode?: 'painel' | 'unico'; singleJudge?: JudgeSpec; judgePanel?: JudgeSpec[] },
): string | null {
  if (!cliEnabled('codex', settings)) {
    return 'Geração indisponível: a CLI codex está desabilitada nas configurações.';
  }
  const mode = run.judgeMode ?? settings.judgeMode;
  if (mode === 'unico') {
    const spec = run.singleJudge ?? settings.singleJudge;
    if (!cliEnabled(spec.provider, settings)) return `CLI do juiz "${spec.provider}" está desabilitada nas configurações.`;
  } else {
    const panel = run.judgePanel ?? settings.judgePanel;
    if (!panel.some((spec) => cliEnabled(spec.provider, settings))) return 'Nenhum juiz do painel está habilitado nas configurações.';
  }
  return null;
}
