import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';

import { checkEnvironment, desligarClisAusentes } from './env';
import { abortarLogin, codexBin, iniciarLogin, loginEmCurso, loginStatus } from '../lib/codexCli';
import { SESSIONS_ROOT } from '../config';
import { sessionDir } from '../state/manifest';
import { estimateSessionCost } from '../lib/cost';
import { getAllStyles, findStyle } from '../lib/userStyles';
import { listSessions, loadFullSession } from '../lib/sessions';
import { buildContactSheet } from '../lib/contactSheet';
import { buildSerieContactSheet } from '../lib/serie/contactSheet';
import { serieDir } from '../lib/serie/store';
import { capabilityMap, loadSettings, saveSettings, validateRunClis } from '../lib/settings';
import { runAuto, type IterationResult, type RunOptions } from '../lib/pipeline';
import { runSerie, type SerieSpec } from '../lib/serie/serieRun';
import type { JobResult, PanelVerdict, Session, Settings, Verdict } from '../types';
import { JobManager } from './jobs';
import { loadLocalToken, registerV1Routes } from './v1';

// Raiz do repo a partir deste arquivo (src/server → ../.. = repo). UI opcional em ui/dist.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
// Em dev (`tsx src/server/serve.ts`) `ROOT/ui/dist` resolve certo. Quando o server é
// empacotado (bundle esbuild → dist-electron/main.cjs), `HERE` muda de lugar, então o
// main do Electron passa o caminho correto via `ATELIE_UI_DIST`. Override opcional,
// retrocompatível: sem a env, comportamento idêntico ao anterior.
const UI_DIST = process.env.ATELIE_UI_DIST || path.join(ROOT, 'ui', 'dist');

// ── Serialização de veredito/resultado (espelha o headless do cli.tsx) ───────
function verdictJson(v?: Verdict | PanelVerdict) {
  if (!v) return null;
  const painel = (v as PanelVerdict).painel;
  return {
    nota: v.nota,
    aprovado: v.aprovado,
    alinhamento: v.alinhamento,
    problemas: v.problemas,
    sugestao_melhoria: v.sugestao_melhoria,
    prompt_sugerido: v.prompt_sugerido,
    painel: painel?.map((p) => ({
      provider: p.spec.provider,
      model: p.spec.model,
      nota: p.verdict?.nota ?? null,
      aprovado: p.verdict?.aprovado ?? null,
    })),
  };
}

function runResultJson(session: Session, iterations: IterationResult[], best?: JobResult) {
  return {
    sessionId: session.id,
    dir: sessionDir(session.id),
    request: session.request,
    versionsPerStyle: session.versionsPerStyle,
    iterations: iterations.map((it) => ({
      iteration: it.iteration,
      durationMs: it.durationMs,
      results: it.results.map((r) => ({
        styleId: r.job.styleId,
        index: r.job.index,
        pngPath: r.pngPath ?? null,
        ok: r.ok,
        verdict: verdictJson(r.verdict),
      })),
      best: it.best
        ? { styleId: it.best.job.styleId, index: it.best.job.index, pngPath: it.best.pngPath ?? null, nota: it.best.verdict?.nota ?? null }
        : null,
    })),
    best: best ? { styleId: best.job.styleId, pngPath: best.pngPath ?? null, nota: best.verdict?.nota ?? null } : null,
    durationMs: session.totalDurationMs ?? null,
    estimatedCostUsd: estimateSessionCost(session).usd,
  };
}

/** Settings serializáveis sem devolver material secreto ao renderer/HTTP. */
function publicSettings(settings: Settings) {
  return {
    ...settings,
    openaiApiKey: null,
    anthropicApiKey: null,
    googleApiKey: null,
    apiKeysConfigured: {
      openai: Boolean(settings.openaiApiKey),
      anthropic: Boolean(settings.anthropicApiKey),
      google: Boolean(settings.googleApiKey),
    },
  };
}

/** Normaliza `--size`: só `wide` precisa de tradução; o resto o backend resolve. */
function resolveSize(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const raw = v.trim();
  if (!raw) return undefined;
  return raw.toLowerCase() === 'wide' ? '2048x896' : raw;
}

type Send = (obj: unknown) => void;

// Superfície mínima do socket `ws` que usamos (evita depender de @types/ws).
interface WsSocket {
  send(data: string): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: string, cb: (...args: any[]) => void): void;
}

// ── Handlers do WebSocket (1 run por vez por socket) ─────────────────────────
async function handleRun(payload: any, runId: string, send: Send): Promise<void> {
  const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
  const styles: string[] = Array.isArray(payload?.styles) ? payload.styles.map((s: unknown) => String(s)) : [];
  if (!prompt || !styles.length) {
    send({ type: 'error', runId, message: 'run requer prompt e styles[]' });
    return;
  }
  const unknown = styles.filter((id) => !findStyle(id));
  if (unknown.length) {
    send({ type: 'error', runId, message: `estilo(s) inexistente(s): ${unknown.join(', ')}` });
    return;
  }

  const settings = loadSettings();
  const genProvider = payload?.genProvider === 'codex' ? payload.genProvider : undefined;
  const judgeMode = payload?.judgeMode === 'painel' || payload?.judgeMode === 'unico' ? payload.judgeMode : undefined;

  // Respeita enabledClis ANTES de gerar: CLI desabilitada → erro claro sem gastar imagem.
  const err = validateRunClis(settings, { genProvider, judgeMode, singleJudge: settings.singleJudge, judgePanel: settings.judgePanel });
  if (err) {
    send({ type: 'error', runId, message: err });
    return;
  }

  const versionsNum = Number(payload?.versions);
  const iterateNum = Number(payload?.iterate);
  const opts: RunOptions & { maxIterations: number } = {
    request: prompt,
    styleIds: styles,
    versionsPerStyle: Number.isFinite(versionsNum) && versionsNum > 0 ? versionsNum : settings.defaultVersionsPerStyle,
    quality: typeof payload?.quality === 'string' ? payload.quality : settings.defaultQuality,
    maxIterations: Number.isFinite(iterateNum) && iterateNum > 0 ? iterateNum : 0,
    onLog: (e) => send({ type: 'log', runId, entry: e }),
    onProgress: (ev) => send({ type: 'progress', runId, ev }),
  };
  if (genProvider) opts.genProvider = genProvider;
  if (judgeMode) opts.judgeMode = judgeMode;
  const avoid = typeof payload?.avoid === 'string' ? payload.avoid.trim() : '';
  if (avoid) opts.avoid = avoid;
  const size = resolveSize(payload?.size);
  if (size) opts.size = size;

  send({ type: 'started', runId, kind: 'run' });
  const { session, iterations, best } = await runAuto(opts);
  send({ type: 'done', runId, result: runResultJson(session, iterations, best) });
}

async function handleSerieRun(payload: any, runId: string, send: Send): Promise<void> {
  const spec = payload?.spec;
  if (!spec || typeof spec !== 'object' || !spec.titulo) {
    send({ type: 'error', runId, message: 'serie-run requer payload.spec com ao menos { titulo, paineis }' });
    return;
  }
  // runSerie valida as CLIs habilitadas no topo (lança ANTES de qualquer geração);
  // o catch do socket converte o erro em {type:'error'}.
  const startedAt = Date.now();
  const size = resolveSize(payload?.size);
  send({ type: 'started', runId, kind: 'serie-run' });
  const serie = await runSerie(spec as SerieSpec, {
    size,
    quality: typeof payload?.quality === 'string' ? payload.quality : undefined,
    onLog: (m) => send({ type: 'log', runId, entry: { ts: new Date().toISOString(), elapsedMs: Date.now() - startedAt, level: 'info', msg: m } }),
    onProgress: (ev) => send({ type: 'progress', runId, ev }),
  });
  let contactSheet: string | null = null;
  try {
    contactSheet = buildSerieContactSheet(serie.id);
  } catch {
    contactSheet = null;
  }
  send({
    type: 'done',
    runId,
    result: {
      serieId: serie.id,
      dir: serieDir(serie.id),
      canon: { personagens: serie.canon.personagens.map((p) => ({ nome: p.nome, anchorPng: p.anchorPng ?? null })) },
      paineis: (serie.paineis ?? []).map((p) => ({
        n: p.n,
        cena: p.cena,
        pngPath: p.pngPath ?? null,
        consistencia: p.consistencia ?? null,
        cenaNota: p.cenaNota ?? null,
        aprovado: p.aprovado ?? false,
      })),
      contactSheet,
    },
  });
}

function attachWs(socket: WsSocket): void {
  let running = false;
  const send: Send = (obj) => {
    try {
      socket.send(JSON.stringify(obj));
    } catch {
      /* socket já fechou — ignora */
    }
  };

  socket.on('message', async (raw: unknown) => {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      send({ type: 'error', runId: null, message: 'mensagem não é JSON válido' });
      return;
    }
    // 1 run por socket: se já roda, recusa (não enfileira) com mensagem clara.
    if (running) {
      send({ type: 'error', runId: null, message: 'já há um run em andamento neste socket; aguarde terminar' });
      return;
    }
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    running = true;
    try {
      if (msg?.type === 'run') await handleRun(msg.payload ?? {}, runId, send);
      else if (msg?.type === 'serie-run') await handleSerieRun(msg.payload ?? {}, runId, send);
      else send({ type: 'error', runId, message: `tipo desconhecido: ${msg?.type ?? '(vazio)'}` });
    } catch (e: any) {
      send({ type: 'error', runId, message: String(e?.message ?? e) });
    } finally {
      running = false;
    }
  });
}

// ── Rotas /api (plugin registrado APÓS o @fastify/websocket) ─────────────────
async function apiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/doctor', async () => checkEnvironment());

  // ── Onboarding: login ChatGPT pelo Codex CLI embutido ────────────────────
  // Estas rotas existem para o wizard de 1ª execução conseguir autenticar o
  // usuário sem terminal. O login roda em background; a UI faz polling do status.
  app.get('/api/auth/codex', async () => ({
    ...(await loginStatus()),
    emCurso: loginEmCurso(),
    binEmbutido: codexBin() != null,
  }));

  app.post('/api/auth/codex/login', async () => iniciarLogin());

  app.post('/api/auth/codex/cancelar', async () => {
    abortarLogin();
    return { ok: true };
  });

  // Serve um arquivo do disco APENAS se estiver sob ~/.atelie (SESSIONS_ROOT/ATELIE_HOME).
  // Usado pelas <img> das sessões/séries e para abrir os contact-sheets no navegador.
  const CONTENT_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
  };
  app.get('/api/file', async (req, reply) => {
    const raw = (req.query as { path?: string } | undefined)?.path;
    if (typeof raw !== 'string' || !raw.trim()) return reply.code(400).send({ error: 'parâmetro "path" obrigatório' });
    const abs = path.resolve(raw);
    const allowedRoots = ['sessions', 'series', 'jobs'].map((dir) => path.join(SESSIONS_ROOT, dir) + path.sep);
    // Barreira de path traversal e de segredo: serve somente artefatos das três
    // árvores conhecidas, nunca config.json, styles.json ou arquivo de token.
    if (!allowedRoots.some((root) => abs.startsWith(root))) return reply.code(403).send({ error: 'acesso negado: caminho fora das árvores de artefatos' });
    if (!Object.hasOwn(CONTENT_TYPES, path.extname(abs).toLowerCase())) return reply.code(403).send({ error: 'tipo de arquivo não permitido' });
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      return reply.code(404).send({ error: 'arquivo não encontrado' });
    }
    if (!stat.isFile()) return reply.code(404).send({ error: 'não é um arquivo' });
    reply.type(CONTENT_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
    return reply.send(fs.createReadStream(abs));
  });

  app.get('/api/styles', async () =>
    getAllStyles().map((s) => ({ id: s.id, nome: s.nome, grupo: s.grupo, desc: s.desc, origem: s.origem ?? 'builtin' })),
  );

  app.get('/api/sessions', async () => listSessions());

  app.get('/api/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const full = loadFullSession(id);
    if (!full) return reply.code(404).send({ error: `sessão "${id}" não encontrada` });
    return full;
  });

  app.get('/api/settings', async () => publicSettings(loadSettings()));

  app.put('/api/settings', async (req) => {
    const body = (req.body ?? {}) as Partial<Settings>;
    const current = loadSettings();
    // O GET sempre mascara chaves como null; um PUT do formulário completo não
    // pode apagar o segredo existente por acidente. String não vazia troca a chave.
    const key = (incoming: string | null | undefined, existing: string | null) =>
      typeof incoming === 'string' && incoming.trim() ? incoming.trim() : existing;
    saveSettings({
      ...current,
      ...body,
      openaiApiKey: key(body.openaiApiKey, current.openaiApiKey),
      anthropicApiKey: key(body.anthropicApiKey, current.anthropicApiKey),
      googleApiKey: key(body.googleApiKey, current.googleApiKey),
    } as Settings); // coerce (em saveSettings) valida o merge
    return publicSettings(loadSettings());
  });

  app.get('/api/clis', async () => ({ enabledClis: loadSettings().enabledClis, capabilities: capabilityMap() }));

  app.put('/api/clis', async (req) => {
    const body = (req.body ?? {}) as Partial<{ codex: boolean; claude: boolean }>;
    const s = loadSettings();
    const enabledClis = {
      codex: typeof body.codex === 'boolean' ? body.codex : s.enabledClis.codex,
      claude: typeof body.claude === 'boolean' ? body.claude : s.enabledClis.claude,
    };
    saveSettings({ ...s, enabledClis });
    return { enabledClis: loadSettings().enabledClis, capabilities: capabilityMap() };
  });

  app.post('/api/serie/sheet/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { path: buildSerieContactSheet(id) };
    } catch (e: any) {
      return reply.code(404).send({ error: String(e?.message ?? e) });
    }
  });

  app.post('/api/sessions/sheet/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return { path: buildContactSheet(id) };
    } catch (e: any) {
      return reply.code(404).send({ error: String(e?.message ?? e) });
    }
  });

  // WebSocket: 1 run por conexão (ver attachWs). @fastify/websocket v11 → handler (socket, req).
  app.get('/api/ws', { websocket: true }, (socket) => attachWs(socket));
}

/** Monta a instância Fastify (rotas + WS + estático + CORS localhost). Não escuta ainda. */
export interface CreateServerOptions {
  jobManager?: JobManager;
  token?: string;
}

export function createServer(options: CreateServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  const jobs = options.jobManager ?? new JobManager();
  const token = options.token ?? loadLocalToken();

  // CORS liberado só p/ origens localhost (o bind já é 127.0.0.1, então é a fundo dupla).
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.upgrade) return; // handshake de upgrade do WS não usa reply
    const origin = req.headers.origin;
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type,authorization');
    }
  });
  app.options('/*', async (_req, reply) => reply.code(204).send());

  app.register(fastifyWebsocket);
  app.register(apiRoutes);
  app.register(registerV1Routes, { jobs, token });

  if (fs.existsSync(UI_DIST)) {
    app.register(fastifyStatic, { root: UI_DIST, prefix: '/' });
  } else {
    app.get('/', async (_req, reply) => {
      reply.type('text/html');
      return '<!doctype html><meta charset="utf-8"><title>Ateliê</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>Ateliê</h1><p>UI ainda não construída (<code>ui/dist</code> ausente). A API está viva — veja <code>/api/health</code> e <code>/api/doctor</code>.</p></body>';
    });
  }

  return app;
}

/** Sobe o servidor em 127.0.0.1 (porta efêmera se omitida) e devolve URL + close(). */
export async function startServer(port?: number, options: CreateServerOptions = {}): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const app = createServer(options);
  // Antes de aceitar tráfego: alinhar as feature-flags ao que existe na máquina,
  // para uma instalação sem Claude Code não julgar com um provedor inexistente.
  const desligadas = await desligarClisAusentes();
  if (desligadas.length) console.log(`Ateliê · CLIs ausentes desativadas: ${desligadas.join(', ')}`);
  await app.listen({ port: port ?? 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port ?? 0;
  const url = `http://127.0.0.1:${actualPort}`;
  console.log(`Ateliê · servidor local em ${url}`);
  return { url, port: actualPort, close: () => app.close() };
}
