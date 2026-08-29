/** Integração sem rede/modelos: SDK → Fastify real → fila → motor fake → PNG/manifest. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-integration-'));
process.env.ATELIE_HOME = HOME;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
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
  ok(briefHash(brief) === briefHash({ ...brief, estilo: 'infografico-bento' }), 'brief_hash é determinístico');

  let generations = 0;
  let judgments = 0;
  const jobsRoot = path.join(HOME, 'jobs');
  const motor = criarMotor({
    rootDir: jobsRoot,
    dependencies: {
      generate: async (input) => {
        generations++;
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, PNG);
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image-1', durationMs: 2, costUsd: 0 };
      },
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
  const jobs = new JobManager({ rootDir: jobsRoot, concurrency: 1, motor });

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
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unauthorized = await fetch(`${baseUrl}/v1/styles`);
    ok(unauthorized.status === 401, 'token protege rotas v1');
    saveSettings({ ...loadSettings(), openaiApiKey: 'segredo-que-nao-pode-sair' });
    const settingsResponse = await fetch(`${baseUrl}/api/settings`);
    const settingsText = await settingsResponse.text();
    ok(!settingsText.includes('segredo-que-nao-pode-sair'), 'API legada também mascara credenciais');
    const configLeak = await fetch(`${baseUrl}/api/file?path=${encodeURIComponent(path.join(HOME, 'config.json'))}`);
    ok(configLeak.status === 403, 'servidor de arquivos recusa config.json');
    const client = criarCliente({ baseUrl, token: 'token-de-teste' });
    ok((await client.health()).ok, 'SDK consulta health em servidor real');

    const first = await client.createJob(brief);
    const duplicate = await client.createJob(brief);
    ok(first.id === duplicate.id, 'idempotência: mesmo brief retorna mesmo job');
    ok(first.brief_hash === duplicate.brief_hash, 'idempotência mantém brief_hash');

    const done = await client.waitForJob(first.id, { intervalMs: 5, timeoutMs: 5_000 });
    ok(done.status === 'completed', 'fila completa job com provedor fake', done.status);
    ok(done.veredito?.aprovado === true, 'juiz simulado aprova após reiteração');
    ok(generations === 2 && judgments === 2, 'legibilidade reprovada dispara uma reiteração', `${generations}/${judgments}`);

    const manifest = done.resultado?.artefatos[0]?.manifest;
    ok(manifest?.schema === 'atelie.provenance/v1', 'manifest usa schema estável');
    ok(manifest?.vereditos.length === 2, 'manifest guarda histórico dos vereditos');
    ok(manifest?.arquivo.sha256.length === 64, 'manifest guarda sha256 do PNG');
    ok(manifest?.provedor.id === 'fake' && manifest.provedor.modelo === 'fake-image-1', 'manifest guarda provedor/modelo');

    const bytes = await client.artifact(first.id, 1);
    ok(Buffer.from(bytes).subarray(0, 8).equals(PNG.subarray(0, 8)), 'SDK baixa PNG pela rota de artefato');

    const after = await client.createJob(brief);
    ok(after.id === first.id && generations === 2, 'idempotência após conclusão não regenera');
  } finally {
    await app.close();
  }

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
