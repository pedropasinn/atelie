#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import meow from 'meow';
import { SESSIONS_ROOT } from './config';
import { loadSettings } from './lib/settings';
import { doctor, authInspect, generate } from './lib/imageBackend';
import { judge } from './lib/judge';
import { compose } from './lib/promptComposer';
import { findStyle, getAllStyles, saveUserStyle } from './lib/userStyles';
import { runAuto, runIteration, type IterationResult, type RunOptions } from './lib/pipeline';
import { generateStyleDef } from './lib/styleGenerator';
import { listSessions, loadFullSession } from './lib/sessions';
import { estimateSessionCost } from './lib/cost';
import { buildContactSheet, publishSession } from './lib/contactSheet';
import { openFolder } from './lib/viewer';
import { buildSerieContactSheet } from './lib/serie/contactSheet';
import { draftCanon } from './lib/serie/canon';
import { generateAnchor } from './lib/serie/anchor';
import { generatePanel } from './lib/serie/panel';
import { runSerie, type SerieSpec } from './lib/serie/serieRun';
import { appendSerie, createSerie, ensureSerie, listSeries, loadSerie, saveSerie, serieDir } from './lib/serie/store';
import { SessionLogger } from './lib/logger';
import { criarMotor } from './lib/motor';
import { normalizeBrief } from './lib/brief';
import { startServer } from './server/server';
import { append, readSnapshot, sessionDir, writeSnapshot } from './state/manifest';
import type { Canon, GenJob, GenProviderId, JobResult, JudgeSpec, LogEntry, Painel, Personagem, Serie, Session, Verdict } from './types';

const cli = meow(
  `
  Uso
    $ atelie                          abre a TUI

  Esteira headless
    --brief <brief.json|json> [--json] gera um brief estruturado pelo motor integrável
    --serve [--port <N>]              sobe a API HTTP local (/v1/* e /api/*)
    --run --prompt "<txt>" --styles a,b,c --versions <N|"estilo=N,outro=M"> [--quality low|medium|high] [--iterate <M>] [--json]
                                      gera N versões de cada estilo, julga, escolhe best; --iterate auto-melhora
      [--judge-mode painel|unico] [--judge-models "claude:opus,codex:gpt-5.6-sol"]
      [--workers <N>]  (0 = todas as imagens de uma vez; default das configurações)
          [--refs a.png,b.png] [--avoid "texto"] [--size 2K|WxH|square|portrait|landscape|wide]
    --batch <file.jsonl> [--json]     um pedido por linha (JSON) → uma sessão por linha
    --contact-sheet <sessionId>       gera o contact-sheet HTML da sessão e imprime o caminho
    --sessions [--json]               lista sessões passadas
    --session <id> [--json]           detalhe de uma sessão (imagens + vereditos + pasta)
    --continue <id> [--iterate <M>] [--prompt "<novo>"] [--json]
                                      continua uma sessão (nova iteração)
    --add-style --desc "<txt>" [--images a.png,b.png] [--files x.md] [--save] [--json]
                                      Claude propõe um StyleDef; --save grava em styles.json
    --list-styles [--json]            lista todos os estilos (builtin + user)

  Modalidade Série (sequências coerentes; ações via posicional)
    serie new --titulo "..." --estilo <id> [--desc "<descrição livre>"] [--canon canon.json] [--json]
                                      cria a série; com --desc, Claude monta o cânone; imprime o cânone
    serie anchor <serieId> [--personagem <nome>] [--json]
                                      gera a(s) âncora(s) (character sheet) do(s) personagem(ns)
    serie panel <serieId> --cena "<ação>" [--personagens a,b] [--json]
                                      gera 1 painel coerente (loop de coerência) e imprime o veredito
    serie run --spec serie.json [--json]
                                      série INTEIRA headless (cânone + âncoras + painéis) — gera imagens
    serie list [--json]               lista as séries salvas
    serie show <id> [--json]          detalhe de uma série (cânone + painéis)
    serie sheet <id>                  gera o contact-sheet HTML da série e imprime o caminho

  Flags de debug
    --doctor                          checa runtime + auth do Codex (imprime JSON)
    --gen-one --style <id> --prompt "<txt>" [--quality low|medium|high]
    --judge-file <png> --request "<txt>" [--style <id>] [--model sonnet]
`,
  {
    importMeta: import.meta,
    flags: {
      doctor: { type: 'boolean', default: false },
      genOne: { type: 'boolean', default: false },
      style: { type: 'string' },
      prompt: { type: 'string' },
      quality: { type: 'string' },
      judgeFile: { type: 'string' },
      request: { type: 'string' },
      model: { type: 'string' },
      // v2 headless
      run: { type: 'boolean', default: false },
      styles: { type: 'string' },
      versions: { type: 'string' },
      workers: { type: 'number' },
      // sem default: undefined = herda autoOpenFolder das configurações; --no-open desliga
      open: { type: 'boolean' },
      iterate: { type: 'number' },
      json: { type: 'boolean', default: false },
      sessions: { type: 'boolean', default: false },
      session: { type: 'string' },
      continue: { type: 'string' },
      addStyle: { type: 'boolean', default: false },
      desc: { type: 'string' },
      images: { type: 'string' },
      files: { type: 'string' },
      save: { type: 'boolean', default: false },
      listStyles: { type: 'boolean', default: false },
      // v3 headless
      genProvider: { type: 'string' },
      judgeMode: { type: 'string' },
      judgeModels: { type: 'string' },
      refs: { type: 'string' },
      avoid: { type: 'string' },
      size: { type: 'string' },
      aspect: { type: 'string' },
      batch: { type: 'string' },
      contactSheet: { type: 'string' },
      brief: { type: 'string' },
      serve: { type: 'boolean', default: false },
      port: { type: 'number' },
      // série
      titulo: { type: 'string' },
      estilo: { type: 'string' },
      canon: { type: 'string' },
      personagem: { type: 'string' },
      cena: { type: 'string' },
      personagens: { type: 'string' },
      spec: { type: 'string' },
    },
  },
);

// Encerra em silêncio quando o consumidor fecha o pipe (ex.: `… | head`).
process.stdout.on('error', (e: NodeJS.ErrnoException) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

// ── Helpers ────────────────────────────────────────────────────────────────
function fail(msg: string): void {
  console.error(`erro: ${msg}`);
  process.exitCode = 1;
}

function splitCsv(v?: string): string[] {
  return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
}

/** Só existe um provedor de geração; ids desconhecidos são erro explícito. */
function parseGenProvider(value?: string): GenProviderId | undefined {
  if (value == null || !value.trim()) return undefined;
  if (value.trim() === 'codex') return 'codex';
  throw new Error(`provedor de geração desconhecido: "${value.trim()}"; use "codex"`);
}

/**
 * `--versions` aceita um número (igual p/ todos) ou um mapa por estilo
 * ("mos-ravena=3,mos-klimt=1"); estilos ausentes do mapa caem no default.
 */
function parseVersions(v: string | undefined, styleIds: string[], fallback: number): { versionsPerStyle: number; versionsByStyle?: Record<string, number> } {
  const raw = (v ?? '').trim();
  if (!raw) return { versionsPerStyle: fallback };
  if (!raw.includes('=')) {
    const n = Number(raw);
    return { versionsPerStyle: Number.isFinite(n) && n > 0 ? Math.round(n) : fallback };
  }
  const map: Record<string, number> = {};
  for (const part of raw.split(',')) {
    const [id, num] = part.split('=').map((s) => s.trim());
    const n = Number(num);
    if (id && Number.isFinite(n) && n > 0) map[id] = Math.round(n);
  }
  for (const id of styleIds) if (map[id] == null) map[id] = fallback;
  const versionsPerStyle = Math.max(1, ...Object.values(map));
  return { versionsPerStyle, versionsByStyle: map };
}

function parseJudgeMode(v?: string): 'painel' | 'unico' | undefined {
  return v === 'painel' || v === 'unico' ? v : undefined;
}

/** "claude:opus,codex:gpt-5.6-sol" → JudgeSpec[]. Divide no 1º ':'. */
function parseJudgeSpecs(csv?: string): JudgeSpec[] {
  if (!csv) return [];
  const out: JudgeSpec[] = [];
  for (const raw of csv.split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const i = s.indexOf(':');
    if (i < 0) continue;
    const provider = s.slice(0, i).trim().toLowerCase();
    const model = s.slice(i + 1).trim();
    if ((provider === 'claude' || provider === 'codex') && model) {
      out.push({ provider, model, label: model });
    }
  }
  return out;
}

/** Normaliza --size/--aspect num valor que o codex aceita (WxH/2K/alias). */
function resolveSizeFlag(size?: string, aspect?: string): string | undefined {
  const raw = (size?.trim() || aspect?.trim() || '').trim();
  if (!raw) return undefined;
  const low = raw.toLowerCase();
  if (low === 'wide') return '2048x896';
  return raw; // 2K/4K/1K/WxH e square/portrait/landscape são resolvidos no backend
}

/** Aplica gen-provider/judge-mode/judge-models/refs/avoid/size sobre RunOptions. */
function applyGenJudgeFlags(
  opts: RunOptions,
  f: {
    genProvider?: string;
    judgeMode?: string;
    judgeModels?: string;
    refs?: string;
    avoid?: string;
    size?: string;
    aspect?: string;
  },
): void {
  const genProvider = parseGenProvider(f.genProvider);
  if (genProvider) opts.genProvider = genProvider;

  const specs = parseJudgeSpecs(f.judgeModels);
  let judgeMode = parseJudgeMode(f.judgeMode);
  if (!judgeMode && specs.length) judgeMode = specs.length === 1 ? 'unico' : 'painel';
  if (judgeMode) opts.judgeMode = judgeMode;
  if (specs.length) {
    if (judgeMode === 'unico') opts.singleJudge = specs[0];
    else opts.judgePanel = specs;
  }

  const avoid = f.avoid?.trim();
  if (avoid) opts.avoid = avoid;

  const size = resolveSizeFlag(f.size, f.aspect);
  if (size) opts.size = size;

  const refs = splitCsv(f.refs);
  if (refs.length) {
    opts.refs = refs;
    opts.editMode = true;
    opts.refPng = refs[0];
    if (refs.length > 1) process.stderr.write(`aviso: codex edit usa 1 referência; usando ${refs[0]}.\n`);
  }
}

function loggerLine(e: LogEntry): string {
  return `[+${(e.elapsedMs / 1000).toFixed(1)}s] ${e.level.padEnd(4)} ${e.msg}`;
}

function maxNota(results: JobResult[]): JobResult | undefined {
  let best: JobResult | undefined;
  let bestNota = -Infinity;
  for (const r of results) {
    const nota = r.verdict?.nota;
    if (r.ok && nota != null && nota > bestNota) {
      bestNota = nota;
      best = r;
    }
  }
  return best ?? results.find((r) => r.ok);
}

function verdictJson(v?: Verdict) {
  if (!v) return null;
  // painel[] só existe quando o veredito é PanelVerdict (juiz em modo painel);
  // expõe a nota por-modelo para consumo headless.
  const painel = (v as { painel?: Array<{ spec: { provider: string; model: string }; verdict?: Verdict }> }).painel;
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

function buildRunJson(session: Session, iterations: IterationResult[], best?: JobResult) {
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

function printRunHuman(j: ReturnType<typeof buildRunJson>): void {
  console.log(`Sessão ${j.sessionId}  (${j.dir})`);
  console.log(`Pedido: ${j.request}`);
  for (const it of j.iterations) {
    console.log(`\n  Iteração ${it.iteration}  (${(it.durationMs / 1000).toFixed(1)}s)`);
    for (const r of it.results) {
      const mark = r.verdict?.aprovado ? '✓' : '✗';
      const nota = r.verdict?.nota ?? '—';
      if (r.ok) {
        console.log(`    ${r.styleId} v${r.index}  nota ${nota} ${mark}  ${r.pngPath}`);
        const prob = r.verdict?.problemas?.[0];
        if (prob) console.log(`        problema: ${prob}`);
      } else {
        console.log(`    ${r.styleId} v${r.index}  falhou`);
      }
    }
  }
  if (j.best) console.log(`\n  best: ${j.best.styleId} nota ${j.best.nota ?? '—'} -> ${j.best.pngPath}`);
  if (j.durationMs != null) console.log(`  tempo total: ${(j.durationMs / 1000).toFixed(1)}s`);
  console.log(`  custo estimado: ~US$ ${j.estimatedCostUsd.toFixed(2)} (aproximado)`);
}

// ── Subcomandos ──────────────────────────────────────────────────────────────
async function cmdRun(f: typeof cli.flags): Promise<void> {
  if (!f.prompt || !f.styles) {
    fail('--run requer --prompt "<txt>" e --styles a,b,c');
    return;
  }
  const settings = loadSettings();
  const styleIds = splitCsv(f.styles);
  const unknown = styleIds.filter((id) => !findStyle(id));
  if (unknown.length) {
    fail(`estilo(s) inexistente(s): ${unknown.join(', ')}. Rode --list-styles para ver os disponíveis.`);
    return;
  }
  const { versionsPerStyle, versionsByStyle } = parseVersions(f.versions, styleIds, settings.defaultVersionsPerStyle);
  const opts: RunOptions & { maxIterations: number } = {
    request: f.prompt,
    styleIds,
    versionsPerStyle,
    versionsByStyle,
    quality: f.quality || settings.defaultQuality,
    concurrency: typeof f.workers === 'number' && f.workers >= 0 ? f.workers : settings.concurrency,
    maxIterations: f.iterate && f.iterate > 0 ? f.iterate : 0,
    onLog: (e) => process.stderr.write(loggerLine(e) + '\n'),
  };
  applyGenJudgeFlags(opts, f);
  if ((opts.judgeMode ?? settings.judgeMode) === 'painel') {
    const n = (opts.judgePanel ?? settings.judgePanel).length;
    process.stderr.write(`aviso: juiz em painel (${n} modelos) → ${n} chamadas por imagem (mais tempo/custo).\n`);
  }
  const { session, iterations, best } = await runAuto(opts);
  const j = buildRunJson(session, iterations, best);
  // A página com TODAS as imagens já foi publicada pela pipeline; só abre a pasta.
  const pub = readSnapshot(session.id);
  if (pub?.pageDir) {
    process.stderr.write(`imagens + página: ${pub.pageDir}\n`);
    if (f.open ?? settings.autoOpenFolder) openFolder(pub.pageDir);
  }
  if (f.json) console.log(JSON.stringify({ ...j, pageDir: pub?.pageDir, page: pub?.pagePath }));
  else {
    printRunHuman(j);
    if (pub?.pagePath) console.log(`  página: ${pub.pagePath}`);
  }
}

async function cmdContinue(f: typeof cli.flags): Promise<void> {
  const id = f.continue!;
  const session = readSnapshot(id);
  if (!session) {
    fail(`sessão "${id}" não encontrada`);
    return;
  }
  const settings = loadSettings();
  const request = f.prompt || session.request;
  const prevBest = maxNota(session.results ?? []);
  const startedAt = Date.now();
  const logger = new SessionLogger(session.id, startedAt, (e) => process.stderr.write(loggerLine(e) + '\n'));

  // Sem novo prompt → reaplica a melhoria do melhor da última iteração.
  const firstCtx =
    !f.prompt && prevBest?.verdict
      ? { sugestao_melhoria: prevBest.verdict.sugestao_melhoria, prompt_sugerido: prevBest.verdict.prompt_sugerido, anchor: session.subjectAnchor }
      : undefined;

  const base: RunOptions = {
    request,
    styleIds: session.styleIds,
    versionsPerStyle: session.versionsPerStyle,
    versionsByStyle: session.versionsByStyle,
    quality: f.quality || settings.defaultQuality,
    concurrency: typeof f.workers === 'number' && f.workers >= 0 ? f.workers : settings.concurrency,
  };

  session.iteration = session.iteration + 1;
  let it = await runIteration(session, { ...base, improveCtx: firstCtx }, logger);
  const iterations: IterationResult[] = [it];
  let best = it.best;

  const maxIt = f.iterate && f.iterate > 0 ? f.iterate : 0;
  let extra = 0;
  while (best && !best.verdict?.aprovado && extra < maxIt) {
    extra++;
    session.iteration = session.iteration + 1;
    const ctx = {
      sugestao_melhoria: best.verdict?.sugestao_melhoria ?? '',
      prompt_sugerido: best.verdict?.prompt_sugerido ?? '',
      anchor: session.subjectAnchor,
    };
    it = await runIteration(session, { ...base, improveCtx: ctx }, logger);
    iterations.push(it);
    best = it.best;
  }

  const addedMs = Date.now() - startedAt;
  session.totalDurationMs = (session.totalDurationMs ?? 0) + addedMs;
  session.iterationsMeta = [...(session.iterationsMeta ?? []), ...iterations.map((i) => ({ iteration: i.iteration, durationMs: i.durationMs }))];
  session.chosen = best && best.pngPath ? { iteration: it.iteration, jobIndex: best.job.index, styleId: best.job.styleId, pngPath: best.pngPath } : session.chosen;
  append(session.id, { kind: 'session_end', chosen: session.chosen, totalDurationMs: session.totalDurationMs });
  writeSnapshot(session);

  const j = buildRunJson(session, iterations, best);
  if (f.json) console.log(JSON.stringify(j));
  else printRunHuman(j);
}

function cmdSessions(f: typeof cli.flags): void {
  const list = listSessions();
  if (f.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    console.log('(nenhuma sessão)');
    return;
  }
  for (const s of list) {
    const nota = s.bestNota != null ? `nota ${s.bestNota}` : 'sem nota';
    const dur = s.durationMs != null ? ` · ${(s.durationMs / 1000).toFixed(0)}s` : '';
    console.log(`${s.id}  ${s.createdAt}  [${s.imageCount} img · ${nota}${dur}]  ${s.request}`);
  }
}

function cmdSession(f: typeof cli.flags): void {
  const id = f.session!;
  const full = loadFullSession(id);
  if (!full) {
    fail(`sessão "${id}" não encontrada`);
    return;
  }
  if (f.json) {
    console.log(JSON.stringify({ dir: sessionDir(id), request: full.session.request, images: full.images }, null, 2));
    return;
  }
  console.log(`Sessão ${id}  (${sessionDir(id)})`);
  console.log(`Pedido: ${full.session.request}`);
  for (const img of full.images) {
    console.log(`  iter ${img.iteration}  ${img.styleId}  nota ${img.nota ?? '—'}  ${img.pngPath}`);
  }
}

async function cmdAddStyle(f: typeof cli.flags): Promise<void> {
  if (!f.desc) {
    fail('--add-style requer --desc "<txt>"');
    return;
  }
  process.stderr.write('Claude analisando…\n');
  const { style, raw } = await generateStyleDef({
    descricao: f.desc,
    imagens: splitCsv(f.images),
    arquivos: splitCsv(f.files),
    model: f.model,
  });
  if (f.save) {
    try {
      saveUserStyle(style);
      process.stderr.write(`salvo: ${style.id}\n`);
    } catch (err: any) {
      fail(`não foi possível salvar: ${err?.message ?? err}`);
      return;
    }
  }
  if (f.json) {
    console.log(JSON.stringify(style, null, 2));
  } else {
    console.log(`id: ${style.id}`);
    console.log(`nome: ${style.nome}`);
    console.log(`grupo: ${style.grupo}`);
    console.log(`desc: ${style.desc}`);
    console.log(`template: ${style.template}`);
    console.log(`defaults: ${JSON.stringify(style.defaults)}`);
    console.log(f.save ? '(salvo em styles.json)' : '(não salvo — use --save)');
    if (!f.json && process.env.ATELIE_DEBUG) console.error(`raw:\n${raw}`);
  }
}

function cmdListStyles(f: typeof cli.flags): void {
  const all = getAllStyles();
  if (f.json) {
    console.log(JSON.stringify(all.map((s) => ({ id: s.id, nome: s.nome, grupo: s.grupo, origem: s.origem ?? 'builtin' })), null, 2));
    return;
  }
  let grupo = '';
  for (const s of all) {
    if (s.grupo !== grupo) {
      grupo = s.grupo;
      console.log(`\n${grupo}`);
    }
    const marca = s.origem === 'user' ? ' (user)' : '';
    console.log(`  ${s.id}  —  ${s.nome}${marca}`);
  }
}

/** Pool de concorrência local (batch): roda até `limit` pedidos ao mesmo tempo. */
async function runPoolLocal<T>(items: T[], limit: number, worker: (item: T, i: number) => Promise<void>): Promise<void> {
  if (!items.length) return;
  let idx = 0;
  const width = Math.min(Math.max(1, limit), items.length);
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const i = idx++;
        if (i >= items.length) break;
        await worker(items[i], i);
      }
    }),
  );
}

type BatchOutput = ReturnType<typeof buildRunJson> | { error: string; request?: string };

async function cmdBatch(f: typeof cli.flags): Promise<void> {
  const file = f.batch!;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fail(`não foi possível ler o batch: ${file}`);
    return;
  }

  const settings = loadSettings();
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const parsed: Array<{ i: number; line: any }> = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      parsed.push({ i, line: JSON.parse(lines[i]) });
    } catch {
      process.stderr.write(`linha ${i + 1}: JSON inválido, pulando\n`);
    }
  }
  if (!parsed.length) {
    fail('batch sem linhas válidas');
    return;
  }

  const outputs: BatchOutput[] = new Array(parsed.length);
  await runPoolLocal(parsed, settings.concurrency, async (entry, k) => {
    const line = entry.line ?? {};
    const request = typeof line.request === 'string' ? line.request : '';
    const styleIds: string[] = Array.isArray(line.styles)
      ? line.styles.map((s: unknown) => String(s))
      : splitCsv(typeof line.styles === 'string' ? line.styles : '');
    if (!request || !styleIds.length) {
      outputs[k] = { error: 'linha requer request e styles', request };
      return;
    }
    const unknown = styleIds.filter((id) => !findStyle(id));
    if (unknown.length) {
      outputs[k] = { error: `estilo(s) inexistente(s): ${unknown.join(', ')}`, request };
      return;
    }
    const opts: RunOptions & { maxIterations: number } = {
      request,
      styleIds,
      versionsPerStyle:
        typeof line.versionsPerStyle === 'number' && line.versionsPerStyle > 0 ? line.versionsPerStyle : settings.defaultVersionsPerStyle,
      versionsByStyle:
        line.versionsByStyle && typeof line.versionsByStyle === 'object' ? line.versionsByStyle : undefined,
      quality: line.quality || settings.defaultQuality,
      maxIterations: line.iterate && line.iterate > 0 ? line.iterate : 0,
      onLog: (e) => process.stderr.write(`[#${entry.i + 1}] ${loggerLine(e)}\n`),
    };
    // Campos v3 são JSON arbitrário: coage p/ string (senão `.trim()`/`.split()` sobre
    // um número lançaria TypeError). Dentro do try por-linha → vira erro daquela linha.
    const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    try {
      applyGenJudgeFlags(opts, {
        genProvider: asStr(line.genProvider),
        judgeMode: asStr(line.judgeMode),
        judgeModels: asStr(line.judgeModels),
        refs: Array.isArray(line.refs) ? line.refs.map((x: unknown) => String(x)).join(',') : asStr(line.refs),
        avoid: asStr(line.avoid),
        size: asStr(line.size),
        aspect: asStr(line.aspect),
      });
      const { session, iterations, best } = await runAuto(opts);
      outputs[k] = buildRunJson(session, iterations, best);
    } catch (err: any) {
      outputs[k] = { error: String(err?.message ?? err), request };
    }
  });

  if (f.json) {
    console.log(JSON.stringify(outputs));
    return;
  }
  for (const o of outputs) {
    if (o && 'error' in o) console.log(`ERRO (${o.request ?? '—'}): ${o.error}`);
    else if (o) printRunHuman(o);
  }
}

function cmdContactSheet(f: typeof cli.flags): void {
  const id = f.contactSheet!;
  try {
    const pub = publishSession(id);
    console.log(pub.page);
    if (f.open ?? loadSettings().autoOpenFolder) openFolder(pub.dir);
  } catch (err: any) {
    fail(String(err?.message ?? err));
  }
}

// ── Modalidade Série ─────────────────────────────────────────────────────────
function progressToStderr(e: { percent: number; phase: string; message: string }): void {
  process.stderr.write(`[${e.percent}%] ${e.phase} ${e.message}\n`);
}

/** Coage um objeto arbitrário (arquivo --canon) num Canon; estiloId vem do --estilo se ausente. */
function canonFromRaw(raw: any, estiloId: string): Canon {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const personagens: Personagem[] = Array.isArray(o.personagens)
    ? o.personagens
        .filter((x: any) => x && typeof x === 'object')
        .map((x: any) => {
          const p: Personagem = {
            nome: String(x.nome ?? '').trim() || 'Personagem',
            descricao: String(x.descricao ?? '').trim(),
          };
          if (typeof x.anchorPng === 'string' && x.anchorPng.trim()) p.anchorPng = x.anchorPng.trim();
          return p;
        })
    : [];
  return {
    estiloId: typeof o.estiloId === 'string' && o.estiloId.trim() ? o.estiloId.trim() : estiloId || 'custom',
    estiloDescricao: typeof o.estiloDescricao === 'string' ? o.estiloDescricao.trim() : '',
    personagens,
    paleta: typeof o.paleta === 'string' && o.paleta.trim() ? o.paleta.trim() : undefined,
    mundo: typeof o.mundo === 'string' && o.mundo.trim() ? o.mundo.trim() : undefined,
  };
}

function printCanonHuman(serie: Serie): void {
  console.log(`Série ${serie.id} criada  (${serieDir(serie.id)})`);
  console.log(`Título: ${serie.titulo}`);
  console.log(`Estilo: ${serie.canon.estiloId}`);
  if (serie.canon.estiloDescricao) console.log(`  ${serie.canon.estiloDescricao}`);
  if (serie.canon.paleta) console.log(`Paleta: ${serie.canon.paleta}`);
  if (serie.canon.mundo) console.log(`Mundo: ${serie.canon.mundo}`);
  console.log(`Personagens (${serie.canon.personagens.length}):`);
  for (const p of serie.canon.personagens) console.log(`  ${p.nome} — ${p.descricao}`);
}

async function cmdSerieNew(f: typeof cli.flags): Promise<void> {
  if (!f.titulo) {
    fail('serie new requer --titulo "<título>"');
    return;
  }
  const estiloId = f.estilo || 'custom';
  let canon: Canon;
  if (f.canon) {
    let raw: any;
    try {
      raw = JSON.parse(fs.readFileSync(f.canon, 'utf8'));
    } catch {
      fail(`não foi possível ler o cânone: ${f.canon}`);
      return;
    }
    canon = canonFromRaw(raw, estiloId);
  } else if (f.desc) {
    process.stderr.write('Claude montando o cânone…\n');
    canon = await draftCanon(f.desc, estiloId, { model: f.model });
  } else {
    fail('serie new requer --desc "<descrição>" ou --canon <arquivo.json>');
    return;
  }
  if (!canon.personagens.length) process.stderr.write('aviso: cânone sem personagens (âncoras/painéis exigem personagens).\n');

  const request = f.desc || f.titulo;
  const serie = createSerie(f.titulo, request, canon);
  ensureSerie(serie);
  appendSerie(serie.id, {
    kind: 'serie_start',
    titulo: f.titulo,
    estilo: estiloId,
    personagens: canon.personagens.map((p) => p.nome),
  });
  saveSerie(serie);

  if (f.json) console.log(JSON.stringify({ serieId: serie.id, dir: serieDir(serie.id), canon }, null, 2));
  else printCanonHuman(serie);
}

async function cmdSerieAnchor(id: string | undefined, f: typeof cli.flags): Promise<void> {
  if (!id) {
    fail('serie anchor requer <serieId>');
    return;
  }
  const serie = loadSerie(id);
  if (!serie) {
    fail(`série "${id}" não encontrada`);
    return;
  }
  let alvos = serie.canon.personagens;
  if (f.personagem) {
    const key = f.personagem.trim().toLowerCase();
    alvos = serie.canon.personagens.filter((p) => p.nome.trim().toLowerCase() === key);
    if (!alvos.length) {
      fail(`personagem "${f.personagem}" não está no cânone da série`);
      return;
    }
  }
  if (!alvos.length) {
    fail('cânone sem personagens para ancorar');
    return;
  }
  const size = resolveSizeFlag(f.size, f.aspect);
  const out: Array<{ nome: string; anchorPng: string }> = [];
  for (const p of alvos) {
    process.stderr.write(`âncora: ${p.nome}…\n`);
    const { pngPath } = await generateAnchor(serie.canon, p, {
      serieId: serie.id,
      size,
      quality: f.quality,
      onProgress: progressToStderr,
    });
    appendSerie(serie.id, { kind: 'anchor', nome: p.nome, anchorPng: pngPath });
    out.push({ nome: p.nome, anchorPng: pngPath });
  }
  saveSerie(serie);

  if (f.json) console.log(JSON.stringify({ serieId: serie.id, anchors: out }, null, 2));
  else for (const a of out) console.log(`${a.nome}  ${a.anchorPng}`);
}

function panelJson(p: Painel) {
  return {
    n: p.n,
    cena: p.cena,
    personagens: p.personagens,
    pngPath: p.pngPath ?? null,
    consistencia: p.consistencia ?? null,
    cenaNota: p.cenaNota ?? null,
    aprovado: p.aprovado ?? false,
    drifts: p.drifts ?? [],
    sugestao_melhoria: p.sugestao_melhoria ?? '',
    tentativas: p.tentativas ?? null,
  };
}

async function cmdSeriePanel(id: string | undefined, f: typeof cli.flags): Promise<void> {
  if (!id) {
    fail('serie panel requer <serieId>');
    return;
  }
  if (!f.cena) {
    fail('serie panel requer --cena "<ação>"');
    return;
  }
  const serie = loadSerie(id);
  if (!serie) {
    fail(`série "${id}" não encontrada`);
    return;
  }
  const escolhidos = splitCsv(f.personagens);
  const personagens = escolhidos.length ? escolhidos : serie.canon.personagens.map((p) => p.nome);
  const n = (serie.paineis ?? []).reduce((m, p) => Math.max(m, p.n), 0) + 1;
  const painel: Painel = { n, cena: f.cena, personagens };
  serie.paineis.push(painel);

  const size = resolveSizeFlag(f.size, f.aspect);
  await generatePanel(serie, painel, {
    size,
    quality: f.quality,
    onLog: (m) => process.stderr.write(m + '\n'),
    onProgress: progressToStderr,
  });
  saveSerie(serie);

  if (f.json) console.log(JSON.stringify(panelJson(painel), null, 2));
  else {
    const mark = painel.aprovado ? '✓' : '✗';
    console.log(`Painel ${painel.n} ${mark}  consistência ${painel.consistencia ?? '—'} · cena ${painel.cenaNota ?? '—'}`);
    console.log(`  ${painel.pngPath ?? '(sem arquivo)'}`);
    for (const d of painel.drifts ?? []) console.log(`  drift: ${d}`);
    if (painel.sugestao_melhoria) console.log(`  sugestão: ${painel.sugestao_melhoria}`);
  }
}

function printSerieRunHuman(out: {
  serieId: string;
  dir: string;
  canon: { personagens: Array<{ nome: string; anchorPng: string | null }> };
  paineis: Array<{ n: number; cena: string; consistencia: number | null; cenaNota: number | null; aprovado: boolean }>;
  contactSheet: string | null;
}): void {
  console.log(`Série ${out.serieId}  (${out.dir})`);
  console.log(`Âncoras:`);
  for (const p of out.canon.personagens) console.log(`  ${p.nome}  ${p.anchorPng ?? '(sem âncora)'}`);
  console.log(`Painéis:`);
  for (const p of out.paineis) {
    const mark = p.aprovado ? '✓' : '✗';
    console.log(`  ${p.n}. ${mark} consist ${p.consistencia ?? '—'} · cena ${p.cenaNota ?? '—'}  ${p.cena}`);
  }
  if (out.contactSheet) console.log(`contact-sheet: ${out.contactSheet}`);
}

async function cmdSerieRun(f: typeof cli.flags): Promise<void> {
  if (!f.spec) {
    fail('serie run requer --spec <serie.json>');
    return;
  }
  let raw: any;
  try {
    raw = JSON.parse(fs.readFileSync(f.spec, 'utf8'));
  } catch {
    fail(`não foi possível ler o spec: ${f.spec}`);
    return;
  }
  if (!raw || typeof raw !== 'object' || !raw.titulo) {
    fail('spec inválido: requer ao menos { titulo, paineis }');
    return;
  }
  const spec = raw as SerieSpec;
  const size = resolveSizeFlag(f.size, f.aspect);
  let serie: Serie;
  try {
    serie = await runSerie(spec, {
      size,
      quality: f.quality,
      canonModel: f.model,
      onLog: (m) => process.stderr.write(m + '\n'),
      onProgress: progressToStderr,
    });
  } catch (err: any) {
    fail(String(err?.message ?? err));
    return;
  }

  let contactSheet: string | null = null;
  try {
    contactSheet = buildSerieContactSheet(serie.id);
  } catch {
    contactSheet = null;
  }
  const out = {
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
      drifts: p.drifts ?? [],
    })),
    contactSheet,
  };
  if (f.json) console.log(JSON.stringify(out));
  else printSerieRunHuman(out);
}

function cmdSerieList(f: typeof cli.flags): void {
  const list = listSeries();
  if (f.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (!list.length) {
    console.log('(nenhuma série)');
    return;
  }
  for (const s of list) {
    console.log(
      `${s.id}  ${s.createdAt}  [${s.personagens} pers · ${s.paineis} painel(is) · ${s.aprovados} aprovado(s)]  ${s.titulo}`,
    );
  }
}

function cmdSerieShow(id: string | undefined, f: typeof cli.flags): void {
  if (!id) {
    fail('serie show requer <id>');
    return;
  }
  const serie = loadSerie(id);
  if (!serie) {
    fail(`série "${id}" não encontrada`);
    return;
  }
  if (f.json) {
    console.log(JSON.stringify({ dir: serieDir(id), ...serie }, null, 2));
    return;
  }
  console.log(`Série ${serie.id}  (${serieDir(id)})`);
  console.log(`Título: ${serie.titulo}  ·  ${serie.createdAt}`);
  console.log(`Estilo: ${serie.canon.estiloId}`);
  console.log(`Personagens (${serie.canon.personagens.length}):`);
  for (const p of serie.canon.personagens) {
    console.log(`  ${p.nome}${p.anchorPng ? `  [${p.anchorPng}]` : '  (sem âncora)'}`);
  }
  const paineis = [...(serie.paineis ?? [])].sort((a, b) => a.n - b.n);
  console.log(`Painéis (${paineis.length}):`);
  for (const p of paineis) {
    const mark = p.aprovado ? '✓' : '✗';
    console.log(`  ${p.n}. ${mark} consist ${p.consistencia ?? '—'} · cena ${p.cenaNota ?? '—'}  ${p.cena}`);
  }
}

function cmdSerieSheet(id: string | undefined): void {
  if (!id) {
    fail('serie sheet requer <id>');
    return;
  }
  try {
    console.log(buildSerieContactSheet(id));
  } catch (err: any) {
    fail(String(err?.message ?? err));
  }
}

/** Despacha `serie <ação>` pelo posicional (cli.input[1]) antes do roteamento de flags. */
async function cmdSerie(args: string[], f: typeof cli.flags): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'new':
      return cmdSerieNew(f);
    case 'anchor':
      return cmdSerieAnchor(args[1], f);
    case 'panel':
      return cmdSeriePanel(args[1], f);
    case 'run':
      return cmdSerieRun(f);
    case 'list':
      return cmdSerieList(f);
    case 'show':
      return cmdSerieShow(args[1], f);
    case 'sheet':
      return cmdSerieSheet(args[1]);
    default:
      fail(`ação de série desconhecida: "${sub ?? ''}". Use: new | anchor | panel | run | list | show | sheet`);
  }
}

async function main(): Promise<void> {
  const f = cli.flags;

  // ── Modalidade Série (posicional): despacha ANTES do roteamento de flags ───
  if (cli.input[0] === 'serie') return cmdSerie(cli.input.slice(1), f);

  // ── Motor integrável / API v1 ───────────────────────────────────────────
  if (f.serve) {
    const server = await startServer(f.port);
    const close = () => server.close().finally(() => process.exit(0));
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
    return;
  }
  if (f.brief) {
    let raw: unknown;
    try {
      const source = fs.existsSync(f.brief) ? fs.readFileSync(f.brief, 'utf8') : f.brief;
      raw = JSON.parse(source);
    } catch {
      fail(`não foi possível ler o brief JSON: ${f.brief}`);
      return;
    }
    try {
      const brief = normalizeBrief(raw);
      const result = await criarMotor().gerar(brief, {
        onProgress: (p) => process.stderr.write(`[${p.concluidos}/${p.total}] ${p.etapa}: ${p.mensagem}\n`),
      });
      if (f.json) console.log(JSON.stringify(result));
      else {
        console.log(`Job ${result.jobId} · ${result.verdict.aprovado ? '✓ aprovado' : '✗ reprovado'} · nota ${result.verdict.nota ?? '—'}`);
        for (const artifact of result.artifacts) console.log(`  ${artifact.n}. ${artifact.pngPath}\n     recibo: ${artifact.manifestPath}`);
      }
    } catch (error: any) {
      fail(String(error?.message ?? error));
    }
    return;
  }

  // ── --doctor ────────────────────────────────────────────────────────────
  if (f.doctor) {
    const [d, a] = await Promise.all([doctor(), authInspect()]);
    console.log(JSON.stringify({ doctor: d, auth: a }, null, 2));
    return;
  }

  // ── --gen-one (debug) ─────────────────────────────────────────────────────
  if (f.genOne) {
    if (!f.style || !f.prompt) {
      fail('--gen-one requer --style <id> e --prompt "<txt>"');
      return;
    }
    const style = findStyle(f.style);
    if (!style) {
      fail(`estilo "${f.style}" não existe. Disponíveis: ${getAllStyles().map((s) => s.id).join(', ')}`);
      return;
    }
    const outDir = path.join(SESSIONS_ROOT, '_debug');
    fs.mkdirSync(outDir, { recursive: true });
    const id = `${style.id}-${Date.now()}`;
    const job: GenJob = {
      id,
      styleId: style.id,
      index: 0,
      prompt: compose(f.prompt, style),
      mode: style.defaults.background === 'transparent' ? 'transparent' : 'generate',
      outPath: path.join(outDir, `${id}.png`),
    };
    const quality = f.quality || style.defaults.quality;
    const { pngPath, meta } = await generate(job, style.defaults.size, quality, (e) => {
      process.stderr.write(`[${e.percent}%] ${e.phase} ${e.message}\n`);
    });
    console.log(pngPath);
    console.error(JSON.stringify(meta));
    return;
  }

  // ── --judge-file (debug) ──────────────────────────────────────────────────
  if (f.judgeFile) {
    if (!f.request) {
      fail('--judge-file requer --request "<txt>"');
      return;
    }
    const style = f.style ? findStyle(f.style) : undefined;
    const styleInfo = style ? { nome: style.nome, desc: style.desc } : { nome: 'livre', desc: 'sem estilo específico' };
    const verdict = await judge(f.judgeFile, f.request, styleInfo, f.model || loadSettings().judgeModel);
    console.log(JSON.stringify(verdict, null, 2));
    return;
  }

  // ── Esteira headless v2/v3 ────────────────────────────────────────────────
  if (f.run) return cmdRun(f);
  if (f.batch) return cmdBatch(f);
  if (f.contactSheet) return cmdContactSheet(f);
  if (f.sessions) return cmdSessions(f);
  if (f.session) return cmdSession(f);
  if (f.continue) return cmdContinue(f);
  if (f.addStyle) return cmdAddStyle(f);
  if (f.listStyles) return cmdListStyles(f);

  // ── default: TUI ──────────────────────────────────────────────────────────
  const [{ default: App }, { render }, React] = await Promise.all([
    import('./App'),
    import('ink'),
    import('react').then((m) => m.default),
  ]);
  render(React.createElement(App));
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
