import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-conteudo-'));
process.env.ATELIE_HOME = HOME;

let passed = 0;
const failures: string[] = [];
function ok(condition: unknown, name: string, detail = ''): void {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function pngHeader(width: number, height: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

async function main(): Promise<void> {
  const { buildContentTranscriptionRubric, compararConteudo } = await import('../src/lib/juizConteudo');
  const { buildLegibilityRubric, composeBriefPrompt } = await import('../src/lib/brief');
  const { aplicarGateVisual, criarMotor } = await import('../src/lib/motor');
  const { findStyle } = await import('../src/lib/userStyles');

  const faltante = compararConteudo(['TÍTULO'], ['TÍTULO', 'Rótulo']);
  ok(!faltante.ok && faltante.faltantes.includes('Rótulo'), 'faltante veta');

  const extra = compararConteudo(['TÍTULO', 'slogan inventado'], ['TÍTULO']);
  ok(!extra.ok && extra.extras.includes('slogan inventado'), 'extra veta por padrão');

  const extraPermitido = compararConteudo(['TÍTULO', 'slogan inventado'], ['TÍTULO'], { textoExtraPermitido: true });
  ok(extraPermitido.ok && extraPermitido.extras.includes('slogan inventado'), 'extra permitido passa e continua auditável');

  const numeracao = compararConteudo(['TÍTULO', '1', 'B1', 'H3'], ['TÍTULO']);
  ok(numeracao.ok && numeracao.extras.length === 0 && numeracao.numeracao.length === 3, 'numeração não conta como extra');

  const cena = compararConteudo(['marca acidental'], [], { zeroTexto: true });
  ok(!cena.ok && cena.extras.includes('marca acidental'), 'cena com texto veta');

  const ordem = compararConteudo(
    ['TÍTULO', 'ETAPAS', 'segundo', 'primeiro'],
    ['TÍTULO', 'ETAPAS', 'primeiro', 'segundo'],
    { ordensObrigatorias: [['primeiro', 'segundo']] },
  );
  ok(!ordem.ok && ordem.ordemIncorreta.length === 1, 'ordem divergente veta');

  const tolerante = compararConteudo(['FLUXO', 'SEGURO', 'Rotulo'], ['FLUXO SEGURO', 'Rótulo']);
  ok(tolerante.ok, 'comparação tolera quebra de linha, caixa e acento');

  const prefixos = compararConteudo(['1. Entrada', '2. Processamento'], ['Entrada', 'Processamento'], { modo: 'explicacao' });
  ok(prefixos.ok && prefixos.numeracao.join(',') === '1,2', 'numeração colada aos rótulos é tolerada');
  const prefixoAlfanumerico = compararConteudo(['H3 Barato'], ['Barato'], { modo: 'explicacao' });
  ok(prefixoAlfanumerico.ok && prefixoAlfanumerico.numeracao[0] === 'H3', 'prefixo alfanumérico colado é tolerado');
  const romanoEMarcador = compararConteudo(['IV. Entrada', '• Saída'], ['Entrada', 'Saída'], { modo: 'explicacao' });
  ok(romanoEMarcador.ok && romanoEMarcador.numeracao.includes('IV') && romanoEMarcador.numeracao.includes('•'), 'romano curto e marcador são tolerados como prefixos');
  const rotulosColados = compararConteudo(['Entrada Saída'], ['Entrada', 'Saída'], {
    modo: 'explicacao',
    ordensObrigatorias: [['Entrada', 'Saída']],
  });
  ok(rotulosColados.ok && rotulosColados.ordemIncorreta.length === 0, 'dois rótulos na mesma entrada casam e preservam ordem');
  const residuo = compararConteudo(['Custo total por execução'], ['Custo total'], { modo: 'explicacao' });
  ok(!residuo.ok && residuo.faltantes.length === 0 && residuo.extras[0] === 'por execução', 'substring permitida casa e só o resíduo vira extra');
  ok(compararConteudo(['Custo total por execução'], ['Custo total'], { modo: 'explicacao', textoExtraPermitido: true }).ok, 'resíduo passa quando extras são permitidos');
  ok(compararConteudo(['Plano', 'de', 'ação', 'imediato', 'agora'], ['Plano de ação imediato agora'], { modo: 'explicacao' }).ok, 'rótulo pode atravessar mais de quatro entradas');

  const ortografia = compararConteudo(['Anállise'], ['Análise'], { modo: 'explicacao' });
  ok(!ortografia.ok && ortografia.faltantes.length === 0 && ortografia.ortografia[0]?.transcrito === 'Anállise', 'divergência de acento casa e veta em explicação');
  const letraTrocada = compararConteudo(['Sada'], ['Saída'], { modo: 'explicacao', ortografiaEstrita: false });
  ok(letraTrocada.ok && letraTrocada.ortografia[0]?.esperado === 'Saída', 'override desliga veto mas preserva divergência ortográfica');
  ok(compararConteudo(['2026'], [], { modo: 'explicacao' }).extras[0] === '2026', 'ano com quatro dígitos não é descartado como numeração');
  ok(buildContentTranscriptionRubric().includes('EXATAMENTE como está escrito') && buildContentTranscriptionRubric().includes('não corrija'), 'rubrica de transcrição proíbe correção espontânea');

  const brief = {
    titulo: 'FLUXO',
    objetivo: 'Explicar duas etapas diferentes.',
    modo: 'explicacao' as const,
    estilo: 'infografico-bento',
    secoes: [{ rotulo: 'ETAPAS', itens: ['primeiro', 'segundo'], ordem_obrigatoria: true }],
    legendas_curtas: true,
    idioma: 'pt-BR' as const,
    tamanho: '2K',
    largura_final_px: 800,
    qualidade: 'medium' as const,
    negativos: [],
    refs: [],
    iteracoes: 1,
  };
  const composed = composeBriefPrompt(brief, findStyle('infografico-bento')!);
  const rubric = buildLegibilityRubric(composed, 7, 1600);
  ok(rubric.includes('800 px') && rubric.includes('0.500') && rubric.includes('12 px'), 'rubrica visual considera o tamanho final');
  ok(rubric.includes('ortografia/acentuação') && rubric.includes('pseudotexto'), 'rubrica visual restaura ortografia e pseudotexto');
  ok(composed.ordensObrigatorias[0]?.join(',') === 'primeiro,segundo', 'brief compõe a ordem verificável');
  ok(!aplicarGateVisual({ aprovado: true, nota: 9, alinhamento: 'ok', problemas: ['texto ilegível'], sugestao_melhoria: '', prompt_sugerido: '' }).aprovado, 'falha visual crítica sobrepõe booleano aprovado');

  const events: string[] = [];
  const generationPrompts: string[] = [];
  let transcriptionCalls = 0;
  let visualCalls = 0;
  const motor = criarMotor({
    rootDir: path.join(HOME, 'jobs'),
    dependencies: {
      generate: async (input) => {
        generationPrompts.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(1600, 1000));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      transcribe: async (input) => {
        events.push('conteudo');
        transcriptionCalls++;
        return {
          transcricao: transcriptionCalls === 1
            ? [...input.composed.stringsVisiveis.filter((texto) => texto !== 'segundo'), 'slogan inventado']
            : input.composed.stringsVisiveis,
          provider: 'fake',
          model: 'fake-transcriber',
        };
      },
      judge: async () => {
        events.push('visual');
        visualCalls++;
        return {
          provider: 'fake',
          model: 'fake-visual',
          verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' },
        };
      },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const result = await motor.gerar(brief, { jobId: 'job-conteudo-fake' });
  const receipts = result.artifacts[0].manifest.vereditos;
  ok(result.verdict.aprovado && events.join(',') === 'conteudo,conteudo,visual', 'visual só roda depois de conteúdo aprovado', events.join(','));
  ok(visualCalls === 1 && receipts[0].visual === null && receipts[1].visual?.aprovado === true, 'veto não pode ser compensado por nota visual');
  ok(receipts[0].problemas.includes('texto não autorizado: slogan inventado'), 'veto expõe o texto não autorizado');
  ok(receipts[0].problemas.includes('rótulo ausente: segundo'), 'veto expõe o rótulo ausente');
  ok(generationPrompts[1]?.includes('PROIBIDO: qualquer texto além de:'), 'próxima tentativa recebe proibição explícita');
  ok(generationPrompts[1]?.includes('OBRIGATÓRIO incluir: "segundo"'), 'próxima tentativa recebe inclusão obrigatória');
  ok(result.artifacts[0].manifest.parametros.largura_final_px === 800, 'recibo grava largura_final_px');
  ok(result.artifacts[0].manifest.parametros.ortografia_estrita === true, 'recibo grava ortografia_estrita');

  let chamadasOrtografia = 0;
  let juizAposOrtografia = 0;
  const promptsOrtografia: string[] = [];
  const orthographyMotor = criarMotor({
    rootDir: path.join(HOME, 'ortografia'),
    dependencies: {
      generate: async (input) => {
        promptsOrtografia.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(1600, 1000));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      transcribe: async (input) => {
        chamadasOrtografia++;
        return {
          transcricao: input.composed.stringsVisiveis.map((texto) => chamadasOrtografia === 1 && texto === 'FLUXO' ? 'FLUXÓ' : texto),
          provider: 'fake',
          model: 'fake-transcriber',
        };
      },
      judge: async () => {
        juizAposOrtografia++;
        return { provider: 'fake', model: 'fake-visual', verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' } };
      },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const orthographyResult = await orthographyMotor.gerar(brief, { jobId: 'ortografia-fake' });
  const primeiroReciboOrtografia = orthographyResult.artifacts[0].manifest.vereditos[0];
  ok(orthographyResult.verdict.aprovado && juizAposOrtografia === 1 && primeiroReciboOrtografia.conteudo?.ortografia?.[0]?.transcrito === 'FLUXÓ', 'ortografia veta antes do visual e fica auditável');
  ok(promptsOrtografia[1]?.includes('substitua "FLUXÓ" por "FLUXO"'), 'reiteração recebe correção ortográfica explícita');

  const sceneBrief = { ...brief, titulo: 'CENA', modo: 'cena' as const, iteracoes: 0 };
  const sceneComposed = composeBriefPrompt(sceneBrief, findStyle('infografico-bento')!);
  ok(buildLegibilityRubric(sceneComposed).includes('zero texto') && sceneComposed.brief.ortografia_estrita === false, 'rubrica visual de cena proíbe texto e desliga ortografia estrita por padrão');
  const zeroTextMotor = criarMotor({
    rootDir: path.join(HOME, 'zero-texto'),
    dependencies: {
      generate: async (input) => {
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(1600, 1000));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      transcribe: async () => ({ transcricao: [], provider: 'fake', model: 'fake-transcriber' }),
      judge: async () => ({
        provider: 'fake',
        model: 'fake-visual',
        verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: ['há texto na imagem'], sugestao_melhoria: '', prompt_sugerido: '' },
      }),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const zeroTextResult = await zeroTextMotor.gerar(sceneBrief, { jobId: 'zero-texto-fake' });
  ok(!zeroTextResult.verdict.aprovado && zeroTextResult.artifacts[0].manifest.vereditos[0].visual?.aprovado === false, 'transcrição vazia não compensa texto reportado pelo juiz visual');

  const promptsSemAcumulo: string[] = [];
  const retryMotor = criarMotor({
    rootDir: path.join(HOME, 'prompt-sem-acumulo'),
    dependencies: {
      generate: async (input) => {
        promptsSemAcumulo.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(1600, 1000));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      transcribe: async () => ({ transcricao: [], provider: 'fake', model: 'fake-transcriber' }),
      judge: async () => { throw new Error('juiz visual não deveria rodar'); },
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  await retryMotor.gerar({ ...brief, iteracoes: 2 }, { jobId: 'prompt-sem-acumulo-fake' });
  ok((promptsSemAcumulo[2]?.match(/PROIBIDO:/g) ?? []).length === 1, 'reiteração não acumula blocos PROIBIDO');

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(HOME, { recursive: true, force: true }));
