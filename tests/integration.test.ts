/** Integração sem rede/modelos: SDK → Fastify real → fila → motor fake → PNG/manifest. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-integration-'));
process.env.ATELIE_HOME = HOME;

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}
const PNG = pngHeader(320, 640);
let passed = 0;
const failures: string[] = [];
function ok(condition: unknown, name: string, detail = ''): void {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const { composeBriefPrompt, normalizeBrief, briefHash } = await import('../src/lib/brief');
  const { findStyle } = await import('../src/lib/userStyles');
  const { criarMotor } = await import('../src/lib/motor');
  const { JobManager } = await import('../src/server/jobs');
  const { createServer } = await import('../src/server/server');
  const { criarCliente } = await import('../src/sdk/index');
  const { loadSettings, saveSettings } = await import('../src/lib/settings');
  const { getGenProvider } = await import('../src/lib/genProviders');
  const { estimateImageCost } = await import('../src/lib/cost');
  const { tamanhoPorSuporte } = await import('../examples/macrostudio-adapter');

  async function wait(manager: InstanceType<typeof JobManager>, id: string): Promise<ReturnType<InstanceType<typeof JobManager>['get']>> {
    for (let i = 0; i < 500; i++) {
      const job = manager.get(id);
      if (job?.status === 'completed' || job?.status === 'failed' || job?.status === 'cancelled') return job;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw new Error(`timeout no teste aguardando ${id}`);
  }

  const brief = normalizeBrief({
    titulo: 'FLUXO SEGURO',
    objetivo: 'Explicar a passagem por três etapas.',
    modo: 'explicacao',
    estilo: 'infografico-bento',
    secoes: [
      { rotulo: 'PEDIDO', itens: ['limites', 'testes'] },
      { rotulo: 'ACEITAÇÃO', itens: ['veredito'] },
    ],
    legendas_curtas: true,
    idioma: 'pt-BR',
    tamanho: '2K',
    qualidade: 'medium',
    negativos: [],
    refs: [],
    iteracoes: 1,
  });

  const composed = composeBriefPrompt(brief, findStyle('infografico-bento')!);
  ok(composed.prompt.includes('"FLUXO SEGURO"'), 'brief→prompt põe título entre aspas');
  ok(composed.prompt.includes('"ACEITAÇÃO"'), 'brief→prompt preserva acentuação e aspas');
  ok(/microtexto/i.test(composed.prompt), 'brief→prompt proíbe microtexto');
  ok(briefHash(brief) === briefHash({ ...brief, estilo: undefined, estilos: ['infografico-bento', 'infografico-bento'] }), 'D2: estilo e estilos canonicalizam para o mesmo hash');
  ok(tamanhoPorSuporte.reels === '1152x2048' && tamanhoPorSuporte.corte === '1152x2048', 'D3: reels/corte usam 9:16 exato');
  ok(tamanhoPorSuporte.card === '1280x1600', 'D3: card usa 4:5 exato');
  let invalidProviderRejected = false;
  try { getGenProvider('desconhecido'); } catch { invalidProviderRejected = true; }
  ok(invalidProviderRejected, 'D4: resolver recusa provedor desconhecido');
  const customCost = estimateImageCost('high', '1152x2048', { ATELIE_IMAGE_PRICE_TABLE_JSON: '{"high":{"portrait":0.321}}' });
  ok(customCost.usd === 0.321 && customCost.tipo === 'estimativa', 'D5: tabela configurável produz custo marcado como estimativa');

  const overlay = composeBriefPrompt({ ...brief, texto_fora_da_imagem: true }, findStyle('infografico-bento')!);
  ok(overlay.stringsVisiveis.length === 0 && /zero texto visível/i.test(overlay.prompt), 'explicação com overlay gera imagem sem texto');
  ok(overlay.rotulosOverlay.some((label) => label.texto === 'ACEITAÇÃO'), 'explicação devolve rótulos estruturados para overlay');

  let generations = 0;
  let judgments = 0;
  const jobsRoot = path.join(HOME, 'jobs');
  const motor = criarMotor({
    rootDir: jobsRoot,
    dependencies: {
      generate: async (input) => {
        generations++;
        if (input.prompt.includes('FALHA PERMANENTE')) throw new Error('entrada inválida permanente');
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, PNG);
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image-1', durationMs: 2, costUsd: 0 };
      },
      transcribe: async (input) => ({
        transcricao: input.composed.stringsVisiveis,
        provider: 'fake',
        model: 'fake-transcriber-1',
      }),
      judge: async () => {
        judgments++;
        const approved = judgments >= 2;
        return {
          provider: 'fake',
          model: 'fake-judge-1',
          verdict: {
            aprovado: approved,
            nota: approved ? 9 : 5,
            alinhamento: approved ? 'texto legível' : 'acentuação incorreta',
            problemas: approved ? [] : ['ortografia errada no título'],
            sugestao_melhoria: approved ? '' : 'corrigir o título',
            prompt_sugerido: approved ? '' : 'Infográfico com título "FLUXO SEGURO".',
          },
        };
      },
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    },
  });
  const jobs = new JobManager({ rootDir: jobsRoot, concurrency: 1, motor, transientRetries: 1, retryDelayMs: 0 });

  let transientCalls = 0;
  const transientRoot = path.join(HOME, 'transient-jobs');
  const transientMotor = criarMotor({
    rootDir: transientRoot,
    dependencies: {
      generate: async (input) => {
        transientCalls++;
        if (transientCalls === 1) throw Object.assign(new Error('provedor temporariamente indisponível'), { code: 'service_unavailable' });
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, PNG);
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image-1', costUsd: 0 };
      },
      transcribe: async (input) => ({ transcricao: input.composed.stringsVisiveis, provider: 'fake', model: 'fake-transcriber-1' }),
      judge: async () => ({ provider: 'fake', model: 'fake-judge-1', verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' } }),
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    },
  });
  const transientJobs = new JobManager({ rootDir: transientRoot, motor: transientMotor, transientRetries: 1, retryDelayMs: 0 });
  const transient = transientJobs.create({ ...brief, titulo: 'FALHA TRANSITÓRIA' }).job;
  const transientDone = await wait(transientJobs, transient.id);
  ok(transientDone?.status === 'completed' && transientCalls === 2 && transientDone.tentativas === 2, 'D1: falha transitória recebe retry automático N vezes');

  const cancelRoot = path.join(HOME, 'cancel-jobs');
  const cancellableMotor = criarMotor({
    rootDir: cancelRoot,
    dependencies: {
      generate: (input) => new Promise((_, reject) => {
        const abort = () => {
          const error = new Error('cancelado pelo teste');
          error.name = 'AbortError';
          reject(error);
        };
        if (input.signal?.aborted) abort();
        else input.signal?.addEventListener('abort', abort, { once: true });
      }),
      judge: async () => { throw new Error('juiz não deveria rodar após cancelamento'); },
      now: () => new Date('2026-08-29T12:00:00.000Z'),
    },
  });
  const cancellableJobs = new JobManager({ rootDir: cancelRoot, concurrency: 1, motor: cancellableMotor });
  const cancellable = cancellableJobs.create({ ...brief, titulo: 'CANCELAR ESTE JOB' }).job;
  cancellableJobs.cancel(cancellable.id);
  await new Promise((resolve) => setTimeout(resolve, 0));
  ok(cancellableJobs.get(cancellable.id)?.status === 'cancelled', 'cancelamento aborta job em curso');

  const app = createServer({ jobManager: jobs, token: 'token-de-teste' });
  await app.ready();
  const baseUrl = 'http://atelie.test';
  const fetcher: typeof globalThis.fetch = async (input, init = {}) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, baseUrl);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const response = await app.inject({
      method: (init.method ?? 'GET') as any,
      url: `${url.pathname}${url.search}`,
      headers,
      payload: typeof init.body === 'string' ? init.body : undefined,
    });
    return new Response(response.rawPayload, { status: response.statusCode, headers: response.headers as HeadersInit });
  };

  try {
    const unauthorized = await fetcher(`${baseUrl}/v1/styles`);
    ok(unauthorized.status === 401, 'token protege rotas v1');
    saveSettings({ ...loadSettings(), openaiApiKey: 'segredo-que-nao-pode-sair' });
    const legacyUnauthorized = await fetcher(`${baseUrl}/api/settings`);
    ok(legacyUnauthorized.status === 401, 'D7: token protege rotas /api legadas');
    const wsUnauthorized = await app.inject({ method: 'GET', url: '/api/ws' });
    ok(wsUnauthorized.statusCode === 401, 'D7: token protege handshake do WebSocket');
    const wsAuthorized = await app.inject({ method: 'GET', url: '/api/ws', headers: { Authorization: 'Bearer token-de-teste' } });
    ok(wsAuthorized.statusCode !== 401, 'D7: WebSocket aceita o mesmo Bearer das rotas HTTP');
    const settingsResponse = await fetcher(`${baseUrl}/api/settings`, { headers: { Authorization: 'Bearer token-de-teste' } });
    const settingsText = await settingsResponse.text();
    ok(!settingsText.includes('segredo-que-nao-pode-sair'), 'API legada também mascara credenciais');
    const invalidLegacyProvider = await fetcher(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer token-de-teste', 'Content-Type': 'application/json' },
      body: JSON.stringify({ genProvider: 'desconhecido' }),
    });
    ok(invalidLegacyProvider.status === 400, 'D4: configuração legada também recusa provedor desconhecido com 400');
    const configLeak = await fetcher(`${baseUrl}/api/file?path=${encodeURIComponent(path.join(HOME, 'config.json'))}`, { headers: { Authorization: 'Bearer token-de-teste' } });
    ok(configLeak.status === 403, 'servidor de arquivos recusa config.json');
    const client = criarCliente({ baseUrl, token: 'token-de-teste', fetch: fetcher });
    ok((await client.health()).ok, 'SDK consulta health em servidor real');

    const first = await client.createJob(brief);
    const duplicate = await client.createJob(brief);
    ok(first.id === duplicate.id, 'idempotência: mesmo brief retorna mesmo job');
    ok(first.brief_hash === duplicate.brief_hash, 'idempotência mantém brief_hash');

    const invalidStyle = await fetcher(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-de-teste', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brief, estilos: ['estilo-que-nao-existe'], estilo: undefined }),
    });
    ok(invalidStyle.status === 400, 'D9: estilo inexistente falha com HTTP 400 antes da fila');
    const invalidProvider = await fetcher(`${baseUrl}/v1/jobs`, {
      method: 'POST',
      headers: { Authorization: 'Bearer token-de-teste', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...brief, provedor: 'desconhecido' }),
    });
    ok(invalidProvider.status === 400, 'D4: API recusa provedor desconhecido com HTTP 400');

    const done = await client.waitForJob(first.id, { intervalMs: 5, timeoutMs: 5_000 });
    ok(done.status === 'completed', 'fila completa job com provedor fake', done.status);
    ok(done.veredito?.aprovado === true, 'juiz simulado aprova após reiteração');
    ok(generations === 2 && judgments === 2, 'legibilidade reprovada dispara uma reiteração', `${generations}/${judgments}`);

    const manifest = done.resultado?.artefatos[0]?.manifest;
    ok(manifest?.schema === 'atelie.provenance/v1', 'manifest usa schema estável');
    ok(manifest?.vereditos.length === 2, 'manifest guarda histórico dos vereditos');
    ok(manifest?.arquivo.sha256.length === 64, 'manifest guarda sha256 do PNG');
    ok(manifest?.provedor.id === 'fake' && manifest.provedor.modelo === 'fake-image-1', 'manifest guarda provedor/modelo');
    ok(manifest?.atelie_versao === '0.2.1', 'D5: manifest guarda versão do Ateliê');
    ok(manifest?.arquivo.dimensoes.largura === 320 && manifest.arquivo.dimensoes.altura === 640, 'D5: manifest lê dimensões reais do IHDR');
    ok(manifest?.metricas.custo_usd === 0 && manifest.metricas.custo_tipo === 'informado', 'D5: manifest sempre preenche custo_usd e sua natureza');
    ok(typeof manifest?.vereditos[0]?.duracao_ms === 'number', 'D5: manifest guarda duração por tentativa');
    ok(manifest?.vereditos.every((veredito) => veredito.conteudo?.aprovado && veredito.visual?.aprovado != null), 'manifest separa vereditos de conteúdo e visual');

    const bytes = await client.artifact(first.id, 1);
    ok(Buffer.from(bytes).subarray(0, 8).equals(PNG.subarray(0, 8)), 'SDK baixa PNG pela rota de artefato');

    const after = await client.createJob(brief);
    ok(after.id === first.id && generations === 2, 'idempotência após conclusão não regenera');

    const forced = await client.createJob(brief, { force: true });
    ok(forced.id !== first.id, 'D1: force:true cria job novo mesmo após conclusão');
    await client.waitForJob(forced.id, { intervalMs: 2, timeoutMs: 5_000 });

    const failedBrief = { ...brief, titulo: 'FALHA PERMANENTE' };
    const failed = await client.createJob(failedBrief);
    const failedDone = await client.waitForJob(failed.id, { intervalMs: 2, timeoutMs: 5_000 });
    ok(failedDone.status === 'failed' && failedDone.tentativas === 1, 'D1: falha não transitória não é repetida automaticamente');
    const trapped = await client.createJob(failedBrief);
    ok(trapped.id === failed.id, 'D1: failed recente ainda é idempotente durante TTL');
    const retried = await client.createJob(failedBrief, { retry: true });
    ok(retried.id !== failed.id, 'D1: retry:true libera execução failed explicitamente');
    await client.waitForJob(retried.id, { intervalMs: 2, timeoutMs: 5_000 });

    const deleteWithEmptyJson = await fetcher(`${baseUrl}/v1/jobs/${encodeURIComponent(first.id)}`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer token-de-teste', 'Content-Type': 'application/json' },
    });
    ok(deleteWithEmptyJson.status === 200, 'D6: DELETE tolera Content-Type JSON sem corpo');

    const overlayJob = await client.createJob({ ...brief, titulo: 'OVERLAY SEGURO', texto_fora_da_imagem: true });
    const overlayDone = await client.waitForJob(overlayJob.id, { intervalMs: 2, timeoutMs: 5_000 });
    const overlayManifest = overlayDone.resultado?.artefatos[0]?.manifest;
    ok(overlayManifest?.rotulos_overlay.some((label) => label.texto === 'PEDIDO'), 'manifest devolve lista de rótulos do overlay');
  } finally {
    await app.close();
  }

  let clock = Date.parse('2026-08-29T12:00:00.000Z');
  const expiryRoot = path.join(HOME, 'expiry-jobs');
  const expiryMotor = criarMotor({
    rootDir: expiryRoot,
    dependencies: {
      generate: async () => { throw new Error('falha permanente'); },
      judge: async () => { throw new Error('não deve julgar'); },
      now: () => new Date(clock),
    },
  });
  const expiryJobs = new JobManager({ rootDir: expiryRoot, motor: expiryMotor, now: () => new Date(clock), transientRetries: 0, failedTtlMs: 100, retryDelayMs: 0 });
  const expiredFirst = expiryJobs.create({ ...brief, titulo: 'FALHA COM TTL' }).job;
  await wait(expiryJobs, expiredFirst.id);
  clock += 101;
  const expiredSecond = expiryJobs.create({ ...brief, titulo: 'FALHA COM TTL' }).job;
  ok(expiredSecond.id !== expiredFirst.id, 'D1: failed expira da idempotência após TTL configurável');

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
