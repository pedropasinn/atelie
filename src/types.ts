export type Screen =
  | 'bootstrap'
  | 'menu'
  | 'compose'
  | 'generating'
  | 'judging'
  | 'review'
  | 'improve_question'
  | 'prompt_compose'
  | 'prompt_view'
  | 'sessions'
  | 'session_detail'
  | 'add_style'
  | 'config'
  | 'serie_menu'
  | 'serie_new'
  | 'serie_anchors'
  | 'serie_panels'
  | 'serie_view'
  | 'done'
  | 'fatal';

export interface PromptSlots {
  subject: string;
  scene: string;
  extra: string;
}

export type GenProviderId = 'codex';

export interface GenJob {
  id: string;
  styleId: string;
  index: number;
  prompt: string;
  mode: 'generate' | 'edit' | 'transparent';
  refPng?: string;
  // Série: múltiplas referências no modo edit (âncoras dos personagens + painel anterior).
  // Cada item vira UM `--ref-image <p>`; fallback p/ `[refPng]` quando ausente.
  refs?: string[];
  outPath: string;
  // v3: provedor de geração e dimensão pedidos por job (opcionais; default via settings/estilo).
  provider?: GenProviderId;
  size?: string;
}

export interface GenMeta {
  resolved: string;
  retryCount?: number;
  sizeRequested?: string;
  // modelo usado e formato REAL detectado por magic bytes.
  model?: string;
  format?: string;
}

/** Opções passadas a `GenProvider.generate`. */
export interface GenGenOpts {
  size: string;
  quality: string;
  onProgress?: (e: ProgressEvent) => void;
  /** Cancelamento: propagado até o subprocesso para matá-lo em voo. */
  signal?: AbortSignal;
}

export interface Verdict {
  aprovado: boolean;
  nota: number | null;
  alinhamento: string;
  problemas: string[];
  avisos?: string[];
  sugestao_melhoria: string;
  prompt_sugerido: string;
  proporcao?: import('./lib/proporcao').VerificacaoProporcao;
  raw?: string;
}

/** Um juiz do painel: provedor + modelo exato + rótulo curto p/ UI. */
export interface JudgeSpec {
  provider: 'claude' | 'codex';
  model: string;
  label: string;
}

/** Veredito consolidado de um painel multi-provedor; guarda cada voto em `painel`. */
export interface PanelVerdict extends Verdict {
  painel: Array<{ spec: JudgeSpec; verdict: Verdict }>;
}

export interface JobResult {
  job: GenJob;
  pngPath?: string;
  ok: boolean;
  error?: { code: string; message: string };
  meta?: GenMeta;
  verdict?: Verdict | PanelVerdict;
}

export interface ProgressEvent {
  jobId: string;
  phase: string;
  percent: number;
  message: string;
}

// ── Modalidade "Série" (coerência entre múltiplas imagens) ──────────────────
/** Um personagem do cânone; `descricao` é a trava visual detalhada (verbatim no prompt). */
export interface Personagem {
  nome: string;
  descricao: string;
  anchorPng?: string;
}

/** Cânone da série: travas invariantes injetadas em TODO painel. */
export interface Canon {
  estiloId: string; // id do catálogo (ou 'custom')
  estiloDescricao: string; // trava de estilo/linha/paleta, injetada VERBATIM em todo painel
  personagens: Personagem[];
  paleta?: string;
  mundo?: string;
}

/** Veredito de coerência (âncora(s) × painel candidato). */
export interface ConsistencyVerdict {
  consistencia: number | null; // 0–10 fidelidade ao personagem/estilo de referência
  cenaNota: number | null; // 0–10 fidelidade à cena pedida
  drifts: string[]; // diferenças concretas vs a referência
  sugestao_melhoria: string;
  prompt_sugerido: string;
  raw?: string;
}

/** Um painel/quadrinho da série. */
export interface Painel {
  n: number;
  cena: string;
  personagens: string[]; // nomes presentes neste painel
  pngPath?: string;
  prompt?: string;
  consistencia?: number | null;
  cenaNota?: number | null;
  drifts?: string[];
  sugestao_melhoria?: string;
  prompt_sugerido?: string;
  aprovado?: boolean;
  tentativas?: number;
}

export interface Serie {
  id: string;
  titulo: string;
  createdAt: string;
  request: string;
  canon: Canon;
  paineis: Painel[];
}

export interface Session {
  id: string;
  createdAt: string;
  request: string;
  slots: PromptSlots;
  subjectAnchor: string;
  styleIds: string[];
  n: number;
  versionsPerStyle: number;
  /** Versões pedidas de CADA estilo (fonte de verdade; versionsPerStyle é o máximo). */
  versionsByStyle?: Record<string, number>;
  iteration: number;
  provider: string;
  jobs: GenJob[];
  results: JobResult[];
  chosen?: { iteration: number; jobIndex: number; styleId: string; pngPath: string };
  totalDurationMs?: number;
  iterationsMeta?: { iteration: number; durationMs: number }[];
  // v3: provedor de geração da sessão + entradas do Criar (refs/negativos/aspecto) + favoritos.
  genProvider?: GenProviderId;
  refs?: string[];
  avoid?: string;
  size?: string;
  estimatedCostUsd?: number;
  /** Pasta pública com TODAS as imagens + página (publicada a cada iteração). */
  pageDir?: string;
  pagePath?: string;
}

// ── Configurações persistentes (lib/settings.ts) ───────────────────────────
export interface Settings {
  judgeModel: string;
  approveThreshold: number;
  concurrency: number; // 0 = sem limite (todos de uma vez)
  defaultVersionsPerStyle: number;
  defaultQuality: 'low' | 'medium' | 'high';
  viewerCmd: string | null;
  autoOpenFolder: boolean; // abre a pasta publicada ao fim de cada geração
  // v3
  genProvider: GenProviderId;
  judgeMode: 'painel' | 'unico';
  judgePanel: JudgeSpec[];
  singleJudge: JudgeSpec;
  // Série
  consistThreshold: number; // nota mínima de consistência p/ aprovar um painel
  cenaThreshold: number; // nota mínima de fidelidade à cena
  maxTentativas: number; // rondas do loop de coerência por painel
  incluirAnterior: boolean; // usar o painel anterior como referência extra
  serieJudge: JudgeSpec; // juiz de consistência da série
  // Camada de servidor: modo de auth + chaves de API + habilitação de CLIs.
  authMode: 'cli' | 'apikey' | 'auto'; // 'cli' = login das CLIs; 'apikey' = chaves; 'auto' = o que houver
  openaiApiKey: string | null; // persistidas em config.json (nunca impressas pelo /api/doctor)
  anthropicApiKey: string | null;
  googleApiKey: string | null;
  enabledClis: { codex: boolean; claude: boolean }; // feature-flags por CLI
}

/** Id de CLI habilitável (espelha as chaves de Settings.enabledClis). */
export type CliId = 'codex' | 'claude';

// ── Log + cronômetro (lib/logger.ts) ───────────────────────────────────────
export interface LogEntry {
  ts: string;
  elapsedMs: number;
  level: 'info' | 'ok' | 'warn' | 'err';
  msg: string;
}

// ── Navegação de sessões (lib/sessions.ts) ─────────────────────────────────
export interface SessionSummary {
  id: string;
  createdAt: string;
  request: string;
  styleIds: string[];
  iterations: number;
  imageCount: number;
  bestNota: number | null;
  durationMs?: number;
}
