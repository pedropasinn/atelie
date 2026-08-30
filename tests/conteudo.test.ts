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
  const { compararConteudo } = await import('../src/lib/juizConteudo');
  const { buildLegibilityRubric, composeBriefPrompt } = await import('../src/lib/brief');
  const { criarMotor } = await import('../src/lib/motor');
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
  ok(composed.ordensObrigatorias[0]?.join(',') === 'primeiro,segundo', 'brief compõe a ordem verificável');

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

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(HOME, { recursive: true, force: true }));
