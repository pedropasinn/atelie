import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-componente-'));
process.env.ATELIE_HOME = HOME;

let passed = 0;
const failures: string[] = [];
function ok(condition: unknown, name: string, detail = ''): void {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function pngHeader(width: number, height: number, alpha = false, marker = ''): Buffer {
  const png = Buffer.alloc(40 + marker.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png[24] = 8;
  png[25] = alpha ? 6 : 2;
  png.write(marker, 40, 'utf8');
  return png;
}

const metricasOk = {
  fracao_transparente: 0.5,
  fracao_opaca: 0.48,
  fracao_semitransparente: 0.02,
  borda_transparente: 1,
  bbox: { x: 30, y: 30, largura: 140, altura: 140 },
  margem_minima_pct: 15,
  componentes_conexos: 1,
  fracao_maior_componente: 1,
  fracao_objeto_cor_de_fundo: 0,
  faixa_antialias_px: 2,
  fracao_semitransparente_fora_da_faixa: 0.01,
  halo: 0.01,
};

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    titulo: 'Ícone da marca',
    objetivo: 'Criar uma coruja geométrica azul.',
    modo: 'componente',
    estilo: 'logo-icone',
    secoes: [],
    legendas_curtas: true,
    idioma: 'pt-BR',
    tamanho: '1K',
    qualidade: 'medium',
    negativos: [],
    refs: [],
    iteracoes: 1,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const { composeBriefPrompt, normalizeBrief, buildLegibilityRubric } = await import('../src/lib/brief');
  const { criarMotor } = await import('../src/lib/motor');
  const backgroundRemoval = await import('../src/lib/backgroundRemoval');
  const { findStyle } = await import('../src/lib/userStyles');

  const normalizado = normalizeBrief(brief({ texto_permitido: ['ATELIÊ'] }));
  const composto = composeBriefPrompt(normalizado, findStyle('logo-icone')!);
  ok(normalizado.fundo_geracao === '#00FF41' && normalizado.remover_fundo === 'obrigatorio' && normalizado.motor_fundo === 'rembg', 'brief componente aplica defaults de fundo');
  ok(composto.stringsVisiveis.join(',') === 'ATELIÊ' && /objeto único/i.test(composto.prompt) && /não use essa cor/i.test(composto.prompt), 'prompt pede componente isolado, proíbe o chroma no objeto e usa texto_permitido como allowlist');
  ok(buildLegibilityRubric(composto).includes('resíduos de fundo') && buildLegibilityRubric(composto).includes('xadrez'), 'rubrica visual de componente inspeciona o recorte');
  const builder = fs.readFileSync(path.resolve('electron-builder.yml'), 'utf8');
  ok((builder.match(/from: scripts\/remover_fundo\.py/g) ?? []).length === 4, 'electron-builder inclui o removedor nos quatro blocos de resources');
  ok(normalizeBrief(brief({ texto_extra_permitido: true })).texto_extra_permitido === false, 'componente força texto_extra_permitido efetivo para false');
  let modeloInvalido = false;
  try { normalizeBrief(brief({ modelo_fundo: '--modelo' })); } catch { modeloInvalido = true; }
  ok(modeloInvalido, 'modelo_fundo inválido é rejeitado no brief');
  await testarBridge(backgroundRemoval);

  const prompts: string[] = [];
  const imagensJulgadas: string[] = [];
  let remocoes = 0;
  const motorMargem = criarMotor({
    rootDir: path.join(HOME, 'margem'),
    dependencies: {
      generate: async (input) => {
        prompts.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(200, 200, false, `original-${prompts.length}`));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      removeBackground: async (input) => {
        remocoes++;
        fs.writeFileSync(input.outPath, pngHeader(200, 200, true, `alpha-${remocoes}`));
        if (input.composicaoPath) fs.writeFileSync(input.composicaoPath, pngHeader(200, 200, false, `xadrez-${remocoes}`));
        const falha = remocoes === 1;
        return {
          pngPath: input.outPath,
          composicaoPath: input.composicaoPath,
          resultado: {
            ok: !falha,
            motor: input.motor,
            modelo: input.modelo,
            metricas: falha ? { ...metricasOk, margem_minima_pct: 0.4 } : metricasOk,
            problemas: falha ? ['objeto cortado: margem 0,4%'] : [],
          },
        };
      },
      transcribe: async (input) => {
        imagensJulgadas.push(`conteudo:${path.basename(input.pngPath)}`);
        return { transcricao: [], provider: 'fake', model: 'fake-content' };
      },
      judge: async (input) => {
        imagensJulgadas.push(`visual:${path.basename(input.pngPath)}`);
        return { provider: 'fake', model: 'fake-visual', verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' } };
      },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  // Usa estilo não transparente para exercitar diretamente o motor fake configurado.
  const margemResult = await motorMargem.gerar(brief({ estilo: 'product-render', motor_fundo: 'cor-solida' }), { jobId: 'margem' });
  const margemManifest = margemResult.artifacts[0].manifest;
  ok(margemResult.verdict.aprovado && margemManifest.vereditos.length === 2, 'margem insuficiente reprova e provoca nova tentativa');
  ok(margemManifest.vereditos[0].problemas.includes('objeto cortado: margem 0,4%'), 'recibo preserva problema concreto de margem');
  ok(/mais margem/i.test(prompts[1] ?? ''), 'reiteração recebe dica específica de mais margem');
  ok(imagensJulgadas.join(',') === 'conteudo:tentativa-02-xadrez.png,visual:tentativa-02-xadrez.png', 'conteúdo e visual só julgam a composição xadrez aprovada', imagensJulgadas.join(','));
  ok(fs.existsSync(path.join(path.dirname(margemResult.artifacts[0].pngPath), 'tentativa-01-original.png')), 'original de cada tentativa é preservado');
  ok(fs.readFileSync(margemResult.artifacts[0].pngPath)[25] === 6, 'artefato final é o PNG com alpha produzido pelo removedor');
  ok(margemManifest.fundo?.motor === 'cor-solida' && margemManifest.vereditos[1].fundo?.metricas?.margem_minima_pct === 15 && Boolean(margemManifest.fundo?.arquivo_original_sha256), 'manifesto final e recibo registram fundo e hash do original');

  let juizesObrigatorio = 0;
  const indisponivel = (root: string, remover_fundo: 'obrigatorio' | 'opcional') => criarMotor({
    rootDir: path.join(HOME, root),
    dependencies: {
      generate: async (input) => {
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(200, 200, false, 'original'));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      removeBackground: async () => { throw new Error('python ausente'); },
      transcribe: async () => {
        juizesObrigatorio++;
        return { transcricao: [], provider: 'fake', model: 'fake-content' };
      },
      judge: async () => {
        juizesObrigatorio++;
        return { provider: 'fake', model: 'fake-visual', verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' } };
      },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  }).gerar(brief({ estilo: 'product-render', remover_fundo, iteracoes: 0 }), { jobId: root });

  const obrigatorio = await indisponivel('obrigatorio', 'obrigatorio');
  ok(!obrigatorio.verdict.aprovado && obrigatorio.verdict.problemas.includes('remoção de fundo indisponível'), 'remoção obrigatória indisponível nunca aprova em silêncio');
  ok(juizesObrigatorio === 0, 'indisponibilidade obrigatória veta antes dos juízes');
  ok(obrigatorio.artifacts[0].pngPath === null && !fs.existsSync(path.join(path.dirname(obrigatorio.artifacts[0].manifestPath), 'artifact.png')), 'remoção obrigatória sem recorte não grava original como artifact.png');
  ok(obrigatorio.artifacts[0].manifest.artefato_final === null && obrigatorio.artifacts[0].manifest.arquivo === null && Boolean(obrigatorio.artifacts[0].manifest.motivo_sem_artefato_final), 'manifesto registra artefato_final null com motivo');
  const opcional = await indisponivel('opcional', 'opcional');
  ok(opcional.verdict.aprovado && opcional.verdict.avisos?.some((aviso) => aviso.includes('usando artefato original')), 'remoção opcional indisponível aprova com aviso e original');
  ok(fs.readFileSync(opcional.artifacts[0].pngPath!)[25] === 2, 'fallback opcional entrega o artefato original');

  const motores: string[] = [];
  const nativo = criarMotor({
    rootDir: path.join(HOME, 'nativo'),
    dependencies: {
      generate: async (input) => {
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(200, 200, true, 'alpha-nativo'));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      removeBackground: async (input) => {
        motores.push(input.motor);
        fs.copyFileSync(input.pngPath, input.outPath);
        if (input.composicaoPath) fs.writeFileSync(input.composicaoPath, pngHeader(200, 200, false, 'xadrez'));
        return { pngPath: input.outPath, composicaoPath: input.composicaoPath, resultado: { ok: true, motor: input.motor, modelo: input.modelo, metricas: metricasOk, problemas: [] } };
      },
      transcribe: async () => ({ transcricao: [], provider: 'fake', model: 'fake-content' }),
      judge: async () => ({ provider: 'fake', model: 'fake-visual', verdict: { aprovado: false, nota: 5, alinhamento: 'reprovado', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' } }),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const nativoResult = await nativo.gerar(brief({ iteracoes: 0 }), { jobId: 'nativo' });
  ok(motores.join(',') === 'nenhum' && nativoResult.artifacts[0].manifest.fundo?.motor === 'nenhum', 'alpha nativo válido usa somente motor nenhum, sem cair em rembg', motores.join(','));
  ok(nativoResult.artifacts[0].verdict.problemas.length === 1, 'reprovação visual nunca sai com problemas vazio');

  await testarRecorteReprovado(criarMotor);
  await testarTextoEfetivo(criarMotor);

  testarScriptReal();

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

async function testarBridge(modulo: typeof import('../src/lib/backgroundRemoval')): Promise<void> {
  const envAnterior = {
    script: process.env.ATELIE_FUNDO_SCRIPT,
    python: process.env.ATELIE_FUNDO_PYTHON,
    timeout: process.env.ATELIE_FUNDO_TIMEOUT_MS,
    token: process.env.ATELIE_TOKEN,
  };
  const falso = path.join(HOME, 'nao-existe.py');
  const verdadeiro = path.join(HOME, 'removedor-teste.sh');
  try {
    process.env.ATELIE_FUNDO_SCRIPT = falso;
    ok(modulo.resolveBackgroundScript() === path.resolve('scripts/remover_fundo.py'), 'resolver ignora ATELIE_FUNDO_SCRIPT inexistente e acha script do repo');
    fs.writeFileSync(verdadeiro, '#!/bin/sh\n[ -z "$ATELIE_TOKEN" ] || exit 9\ncase " $* " in *" --tolerancia-cor 7 "*) ;; *) exit 8;; esac\nprintf \'%s\\n\' \'{"ok":true,"motor":"nenhum","modelo":"fake","metricas":{"fracao_transparente":0.5},"problemas":[]}\'\n');
    process.env.ATELIE_FUNDO_SCRIPT = verdadeiro;
    ok(modulo.resolveBackgroundScript() === verdadeiro, 'resolver prioriza ATELIE_FUNDO_SCRIPT existente');
    process.env.ATELIE_FUNDO_PYTHON = '/bin/sh';
    process.env.ATELIE_TOKEN = 'segredo-que-nao-deve-ser-herdado';
    let semSaida = '';
    try {
      await modulo.defaultRemoveBackground({ pngPath: verdadeiro, outPath: path.join(HOME, 'saida-ausente.png'), motor: 'nenhum', modelo: 'fake', limites: { tolerancia_cor: 7 } });
    } catch (error) { semSaida = String(error); }
    ok(semSaida.includes('saída não foi escrita'), 'bridge usa ambiente mínimo, repassa tolerância e reprova JSON ok sem saída', semSaida);

    fs.writeFileSync(verdadeiro, '#!/bin/sh\nsleep 5\n');
    process.env.ATELIE_FUNDO_TIMEOUT_MS = '20';
    let timeout = '';
    try {
      await modulo.defaultRemoveBackground({ pngPath: verdadeiro, outPath: path.join(HOME, 'timeout.png'), motor: 'nenhum', modelo: 'fake' });
    } catch (error) { timeout = String(error); }
    ok(timeout.includes('remoção de fundo indisponível') && timeout.includes('tempo limite'), 'bridge aplica timeout configurável e falha fechado', timeout);
  } finally {
    for (const [nome, valor] of Object.entries(envAnterior)) {
      const chave = nome === 'script' ? 'ATELIE_FUNDO_SCRIPT' : nome === 'python' ? 'ATELIE_FUNDO_PYTHON' : nome === 'timeout' ? 'ATELIE_FUNDO_TIMEOUT_MS' : 'ATELIE_TOKEN';
      if (valor == null) delete process.env[chave]; else process.env[chave] = valor;
    }
  }
}

async function testarRecorteReprovado(criarMotor: typeof import('../src/lib/motor').criarMotor): Promise<void> {
  const motor = criarMotor({
    rootDir: path.join(HOME, 'recorte-reprovado'),
    dependencies: {
      generate: async (input) => {
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(200, 200, false, 'original'));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      removeBackground: async (input) => {
        fs.writeFileSync(input.outPath, pngHeader(200, 200, true, 'recorte-reprovado'));
        return { pngPath: input.outPath, resultado: { ok: false, motor: input.motor, modelo: input.modelo, metricas: { ...metricasOk, margem_minima_pct: 0 }, problemas: ['objeto cortado: margem 0,0%'] } };
      },
      transcribe: async () => { throw new Error('não deveria julgar'); },
      judge: async () => { throw new Error('não deveria julgar'); },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const result = await motor.gerar(brief({ estilo: 'product-render', iteracoes: 0 }), { jobId: 'recorte-reprovado' });
  ok(Boolean(result.artifacts[0].pngPath) && fs.readFileSync(result.artifacts[0].pngPath!)[25] === 6, 'último recorte reprovado existente é preservado como artifact.png');
  ok(result.artifacts[0].manifest.artefato_final?.nome === 'artifact.png' && result.artifacts[0].manifest.fundo?.alpha_validado === false, 'manifesto distingue recorte reprovado de alpha validado');
}

async function testarTextoEfetivo(criarMotor: typeof import('../src/lib/motor').criarMotor): Promise<void> {
  const prompts: string[] = [];
  const motor = criarMotor({
    rootDir: path.join(HOME, 'texto-efetivo'),
    dependencies: {
      generate: async (input) => {
        prompts.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(200, 200, false, 'original'));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      removeBackground: async (input) => {
        fs.writeFileSync(input.outPath, pngHeader(200, 200, true, 'alpha'));
        return { pngPath: input.outPath, resultado: { ok: true, motor: input.motor, modelo: input.modelo, metricas: metricasOk, problemas: [] } };
      },
      transcribe: async () => ({ transcricao: ['PROMO 50'], provider: 'fake', model: 'fake-content' }),
      judge: async () => { throw new Error('conteúdo deveria vetar antes do visual'); },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const result = await motor.gerar(brief({ estilo: 'product-render', texto_permitido: ['ATELIÊ'], texto_extra_permitido: true }), { jobId: 'texto-efetivo' });
  ok(result.artifacts[0].verdict.problemas.includes('texto não autorizado: PROMO 50'), 'texto extra em componente nunca reprova com problemas vazios');
  ok(prompts.length === 2 && /PROIBIDO: qualquer texto além/i.test(prompts[1]), 'reiteração de componente sempre instrui a remover texto extra');
}

function testarScriptReal(): void {
  const python = process.env.ATELIE_FUNDO_PYTHON?.trim() || path.resolve('.venv-fundo/bin/python');
  const dependencias = spawnSync(python, ['-c', 'import PIL, numpy'], { encoding: 'utf8' });
  if (dependencias.status !== 0) {
    console.log('  AVISO: testes reais de cor-solida PULADOS — Python com Pillow/numpy não disponível');
    return;
  }
  const fixtures = path.join(HOME, 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  const gerador = [
    'from PIL import Image, ImageDraw',
    'import sys',
    'tipo, destino = sys.argv[1], sys.argv[2]',
    'if tipo == "halo":',
    ' im = Image.new("RGBA", (1024, 1024), (0,0,0,0))',
    ' d = ImageDraw.Draw(im)',
    ' d.ellipse((200,200,824,824), fill=(20,100,220,120))',
    ' d.ellipse((212,212,812,812), fill=(20,100,220,255))',
    'elif tipo == "logo-rembg":',
    ' im = Image.new("RGB", (1024, 1024), "white")',
    ' d = ImageDraw.Draw(im)',
    ' d.ellipse((230,180,794,744), fill=(20,100,220))',
    ' d.rounded_rectangle((160,690,864,820), radius=32, fill=(20,100,220))',
    'elif tipo == "cor-fundo":',
    ' im = Image.new("RGB", (256, 256), "white")',
    ' d = ImageDraw.Draw(im)',
    ' d.rectangle((40,40,216,216), fill=(20,100,220))',
    ' d.rectangle((120,0,136,145), fill="white")',
    'elif tipo == "diagonal":',
    ' im = Image.new("RGB", (256, 256), "white")',
    ' d = ImageDraw.Draw(im)',
    ' d.line((60,60,196,196), fill=(20,100,220), width=1)',
    'elif tipo == "relativo":',
    ' im = Image.new("RGB", (256, 256), "white")',
    ' d = ImageDraw.Draw(im)',
    ' d.rectangle((70,70,169,169), fill=(20,100,220))',
    ' d.rectangle((190,190,197,197), fill=(20,100,220))',
    'elif tipo == "gradiente":',
    ' im = Image.new("RGB", (256, 256), "white")',
    ' d = ImageDraw.Draw(im)',
    ' for y in range(256):',
    '  c = 250 - round(80 * y / 255)',
    '  d.line((0,y,255,y), fill=(c,c,c))',
    ' d.ellipse((56,56,200,200), fill=(20,100,220))',
    'else:',
    ' im = Image.new("RGB", (256, 256), "white")',
    ' d = ImageDraw.Draw(im)',
    ' if tipo == "circulo": d.ellipse((56,56,200,200), fill=(20,100,220))',
    ' elif tipo == "borda": d.ellipse((-30,60,110,200), fill=(20,100,220))',
    ' else:',
    '  d.ellipse((25,88,105,168), fill=(20,100,220))',
    '  d.ellipse((151,88,231,168), fill=(220,70,40))',
    'im.save(destino)',
  ].join('\n');
  const script = path.resolve('scripts/remover_fundo.py');
  const resultados: Record<string, { ok: boolean; problemas: string[]; metricas: Record<string, number> }> = {};
  for (const tipo of ['circulo', 'borda', 'blobs', 'halo', 'cor-fundo', 'diagonal', 'relativo', 'gradiente']) {
    const entrada = path.join(fixtures, `${tipo}.png`);
    const saida = path.join(fixtures, `${tipo}-alpha.png`);
    const criado = spawnSync(python, ['-c', gerador, tipo, entrada], { encoding: 'utf8' });
    if (criado.status !== 0) {
      failures.push(`fixture sintética ${tipo} não pôde ser criada`);
      continue;
    }
    const motor = tipo === 'halo' ? 'nenhum' : 'cor-solida';
    const composicao = tipo === 'circulo' ? path.join(fixtures, 'circulo-xadrez.png') : undefined;
    const execucao = spawnSync(python, [script, '--entrada', entrada, '--saida', saida, '--motor', motor, '--json', ...(composicao ? ['--composicao', composicao] : [])], { encoding: 'utf8' });
    try {
      resultados[tipo] = JSON.parse(execucao.stdout.trim());
    } catch {
      failures.push(`script cor-solida não retornou JSON para ${tipo}`);
    }
  }
  ok(resultados.circulo?.ok, 'script real cor-solida aprova círculo centralizado', resultados.circulo?.problemas?.join('; '));
  ok(fs.existsSync(path.join(fixtures, 'circulo-xadrez.png')), 'script real grava composição xadrez solicitada');
  ok(!resultados.borda?.ok && resultados.borda.problemas.some((p) => p.includes('objeto cortado')), 'script real detecta círculo tocando a borda');
  ok(!resultados.blobs?.ok && resultados.blobs.problemas.some((p) => p.includes('fragmentos')), 'script real detecta dois blobs distantes');
  ok(
    !resultados['cor-fundo']?.ok
      && resultados['cor-fundo'].problemas.some((p) => p.includes('objeto contém a cor do fundo'))
      && resultados['cor-fundo'].metricas.fracao_objeto_cor_de_fundo > 0.03,
    'cor-solida reprova remoção suspeita da cor do fundo dentro do fecho do objeto',
  );
  ok(
    resultados.diagonal?.metricas.componentes_conexos === 1
      && resultados.diagonal.problemas.some((p) => p.includes('objeto pequeno demais')),
    'componentes usam conectividade 8 e objeto fino recebe diagnóstico acionável',
    resultados.diagonal?.problemas?.join('; '),
  );
  ok(resultados.relativo?.metricas.componentes_conexos === 2, 'limiar de 0,5% dos componentes é relativo à área do objeto');
  ok(!resultados.gradiente?.ok && resultados.gradiente.problemas.some((p) => /fundo residual|objeto cortado/.test(p)), 'cor-solida falha fechado em fundo gradiente');
  console.log(`  HALO_FIXTURE: halo=${resultados.halo?.metricas.halo?.toFixed(6) ?? 'indisponível'}`);
  ok(
    !resultados.halo?.ok && resultados.halo.problemas.some((p) => p.includes('halo excessivo')),
    'script real reprova auréola semitransparente de 12 px',
    resultados.halo?.problemas?.join('; '),
  );
  ok(
    resultados.halo?.metricas.faixa_antialias_px === 2
      && resultados.halo.metricas.halo === resultados.halo.metricas.fracao_semitransparente_fora_da_faixa
      && resultados.halo.metricas.halo > 0.05
      && resultados.halo.metricas.halo < 0.08,
    'métrica halo audita a faixa antialias de 2 px, usa a área do objeto e aplica o default de 5%',
  );

  testarRemoverFundoComRembg(python, gerador, script, fixtures);
}

function testarRemoverFundoComRembg(python: string, gerador: string, script: string, fixtures: string): void {
  const rembgPython = path.resolve('.venv-fundo/bin/python');
  const raizesModelo = [path.join(os.homedir(), '.rembg', 'models'), path.join(os.homedir(), '.u2net')];
  const modeloDisponivel = raizesModelo.some((raiz) => {
    if (!fs.existsSync(raiz)) return false;
    const pendentes = [raiz];
    while (pendentes.length) {
      const atual = pendentes.pop()!;
      for (const item of fs.readdirSync(atual, { withFileTypes: true })) {
        const destino = path.join(atual, item.name);
        if (item.isDirectory()) pendentes.push(destino);
        else if (item.name === 'isnet-general-use.onnx') return true;
      }
    }
    return false;
  });
  if (!fs.existsSync(rembgPython) || !modeloDisponivel) {
    console.log('  AVISO: teste real de rembg PULADO — .venv-fundo ou modelo isnet-general-use não disponível');
    return;
  }

  const entrada = path.join(fixtures, 'logo-rembg.png');
  const saida = path.join(fixtures, 'logo-rembg-alpha.png');
  const criado = spawnSync(python, ['-c', gerador, 'logo-rembg', entrada], { encoding: 'utf8' });
  if (criado.status !== 0) {
    failures.push('fixture sintética do logo rembg não pôde ser criada');
    return;
  }
  const inicio = process.hrtime.bigint();
  const execucao = spawnSync(rembgPython, [
    script, '--entrada', entrada, '--saida', saida,
    '--motor', 'rembg', '--modelo', 'isnet-general-use', '--json',
  ], { encoding: 'utf8' });
  const duracaoSegundos = Number(process.hrtime.bigint() - inicio) / 1_000_000_000;
  console.log(`  REMBG_CPU_SEGUNDOS: ${duracaoSegundos.toFixed(3)}`);
  try {
    const resultado = JSON.parse(execucao.stdout.trim()) as {
      ok: boolean;
      problemas: string[];
      metricas: Record<string, number>;
    };
    console.log(
      `  REMBG_METRICAS: ok=${resultado.ok} halo=${resultado.metricas.halo.toFixed(6)} `
      + `fracao_semitransparente=${resultado.metricas.fracao_semitransparente.toFixed(6)}`,
    );
    ok(
      execucao.status === 0 && resultado.ok,
      'rembg real aprova logo sintético com antialias normal',
      resultado.problemas.join('; '),
    );
    ok(
      resultado.metricas.faixa_antialias_px === 2
        && resultado.metricas.halo === resultado.metricas.fracao_semitransparente_fora_da_faixa
        && resultado.metricas.halo <= 0.05,
      'rembg real emite as métricas auditáveis do halo calibrado',
    );
  } catch {
    failures.push(`script rembg não retornou JSON válido — ${execucao.stderr.trim()}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(HOME, { recursive: true, force: true }));
