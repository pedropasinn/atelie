/** Verificação de proporção e gate do motor, sem rede nem geração paga. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'atelie-proporcao-'));
process.env.ATELIE_HOME = ROOT;

function pngHeader(largura: number, altura: number): Buffer {
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.writeUInt32BE(13, 8);
  png.write('IHDR', 12, 'ascii');
  png.writeUInt32BE(largura, 16);
  png.writeUInt32BE(altura, 20);
  return png;
}

let passed = 0;
const failures: string[] = [];

function ok(condition: unknown, name: string, detail = ''): void {
  if (condition) passed++;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const { normalizeBrief } = await import('../src/lib/brief');
  const { criarMotor } = await import('../src/lib/motor');
  const { orientacaoDeTamanho, verificarProporcao } = await import('../src/lib/proporcao');
  const { estimateImageCost } = await import('../src/lib/cost');
  const { provenanceVerdict } = await import('../src/lib/provenance');

  const reciboLegado = provenanceVerdict(1, 'prompt', {
    aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '',
  });
  ok(reciboLegado.proporcao == null, 'provenanceVerdict aceita veredito legado sem proporção');
  ok(orientacaoDeTamanho('2048x1152') === 'landscape' && estimateImageCost('medium', '2048x1152').usd === estimateImageCost('medium', 'wide').usd, 'proporção e custo compartilham normalização de tamanho');

  const aliasOk = verificarProporcao('wide', { largura: 1600, altura: 900 });
  ok(aliasOk.ok && aliasOk.orientacao_pedida === 'landscape' && aliasOk.proporcao_pedida == null, 'alias wide compara somente orientação');
  const aliasDivergente = verificarProporcao('portrait', { largura: 1600, altura: 900 });
  ok(!aliasDivergente.ok && aliasDivergente.orientacao_real === 'landscape', 'alias divergente é reprovado');

  const razaoOk = verificarProporcao('1920x1080', { largura: 1280, altura: 720 });
  ok(razaoOk.ok && razaoOk.proporcao_pedida === 1920 / 1080, 'WxH aceita a mesma proporção em outras dimensões');
  const foraDaTolerancia = verificarProporcao('100x100', { largura: 106, altura: 100 });
  const toleranciaAmpliada = verificarProporcao('100x100', { largura: 106, altura: 100 }, 0.1);
  ok(!foraDaTolerancia.ok && toleranciaAmpliada.ok, 'WxH usa tolerância relativa configurável');
  const semProporcao = verificarProporcao('2K', { largura: 1024, altura: 1536 });
  ok(semProporcao.ok && semProporcao.motivo === 'tamanho não impõe proporção', '2K não impõe proporção');
  ok(verificarProporcao('formato-futuro', { largura: 900, altura: 900 }).ok, 'string desconhecida não impõe proporção');

  const briefBase = {
    titulo: 'FORMATO CERTO',
    objetivo: 'Testar a orientação da imagem.',
    modo: 'explicacao' as const,
    estilo: 'infografico-bento',
    secoes: [],
    legendas_curtas: true,
    idioma: 'pt-BR' as const,
    tamanho: '600x400',
    qualidade: 'medium' as const,
    negativos: [],
    refs: [],
    iteracoes: 1,
  };
  ok(normalizeBrief(briefBase).proporcao_estrita === true, 'explicação ativa proporção estrita por padrão');
  ok(normalizeBrief({ ...briefBase, modo: 'cena' }).proporcao_estrita === false, 'cena desativa proporção estrita por padrão');

  let tentativasEstritas = 0;
  const promptsEstritos: string[] = [];
  const motorEstrito = criarMotor({
    rootDir: path.join(ROOT, 'estrito'),
    dependencies: {
      transcribe: async (input) => ({ transcricao: input.composed.stringsVisiveis, provider: 'fake', model: 'fake-transcriber' }),
      generate: async (input) => {
        tentativasEstritas++;
        promptsEstritos.push(input.prompt);
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, tentativasEstritas === 1 ? pngHeader(320, 640) : pngHeader(600, 400));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      judge: async () => ({
        provider: 'fake',
        model: 'fake-judge',
        verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' },
      }),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const resultadoEstrito = await motorEstrito.gerar(briefBase, { jobId: 'proporcao-estrita' });
  const artefatoEstrito = resultadoEstrito.artifacts[0];
  ok(tentativasEstritas === 2, 'divergência estrita força nova tentativa');
  ok(artefatoEstrito.manifest.vereditos[0].aprovado === false, 'tentativa divergente fica reprovada mesmo com aprovação do juiz');
  ok(artefatoEstrito.manifest.vereditos[0].problemas.some((p) => p.startsWith('proporção divergente: pedido 600x400, real 320x640')), 'reprovação estrita registra problema concreto');
  ok(promptsEstritos[1].includes('FORMATO OBRIGATÓRIO: horizontal 3:2'), 'reiteração recebe instrução explícita de formato e razão');
  ok(artefatoEstrito.verdict.aprovado && artefatoEstrito.verdict.proporcao?.ok === true, 'nova tentativa proporcional pode ser aprovada');
  ok(artefatoEstrito.manifest.tamanho_solicitado === '600x400' && artefatoEstrito.manifest.proporcao.ok, 'recibo registra tamanho solicitado e verificação final');
  ok(artefatoEstrito.manifest.parametros.proporcao_estrita === true, 'recibo registra a política estrita aplicada');
  ok(artefatoEstrito.manifest.vereditos.every((v) => typeof v.proporcao.ok === 'boolean'), 'recibo registra proporção em cada tentativa');

  const motorEstritoEsgotado = criarMotor({
    rootDir: path.join(ROOT, 'estrito-esgotado'),
    dependencies: {
      transcribe: async (input) => ({ transcricao: input.composed.stringsVisiveis, provider: 'fake', model: 'fake-transcriber' }),
      generate: async (input) => {
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(320, 640));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      judge: async () => ({
        provider: 'fake',
        model: 'fake-judge',
        verdict: { aprovado: true, nota: 10, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' },
      }),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const resultadoEsgotado = await motorEstritoEsgotado.gerar({ ...briefBase, iteracoes: 0 }, { jobId: 'proporcao-estrita-esgotada' });
  ok(!resultadoEsgotado.verdict.aprovado && !resultadoEsgotado.artifacts[0].verdict.aprovado, 'gate estrito nunca aprova a divergência ao esgotar tentativas');
  const resultadoSemGeometria = await motorEstritoEsgotado.gerar({ ...briefBase, tamanho: '2K', iteracoes: 0 }, { jobId: 'proporcao-sem-geometria' });
  ok(resultadoSemGeometria.verdict.avisos?.some((aviso) => aviso.includes('sem geometria verificável')) === true, 'gate estrito inerte emite aviso');

  let tentativasFlexiveis = 0;
  const motorFlexivel = criarMotor({
    rootDir: path.join(ROOT, 'flexivel'),
    dependencies: {
      transcribe: async (input) => ({ transcricao: input.composed.stringsVisiveis, provider: 'fake', model: 'fake-transcriber' }),
      generate: async (input) => {
        tentativasFlexiveis++;
        fs.mkdirSync(path.dirname(input.outPath), { recursive: true });
        fs.writeFileSync(input.outPath, pngHeader(320, 640));
        return { pngPath: input.outPath, provider: 'fake', model: 'fake-image', costUsd: 0 };
      },
      judge: async () => ({
        provider: 'fake',
        model: 'fake-judge',
        verdict: { aprovado: true, nota: 9, alinhamento: 'ok', problemas: [], sugestao_melhoria: '', prompt_sugerido: '' },
      }),
      now: () => new Date('2026-08-30T12:00:00.000Z'),
    },
  });
  const resultadoFlexivel = await motorFlexivel.gerar({ ...briefBase, modo: 'cena' }, { jobId: 'proporcao-flexivel' });
  const artefatoFlexivel = resultadoFlexivel.artifacts[0];
  ok(tentativasFlexiveis === 1 && artefatoFlexivel.verdict.aprovado, 'divergência não estrita não força nova tentativa');
  ok(artefatoFlexivel.verdict.avisos?.some((a) => a.startsWith('proporção divergente:')) === true, 'divergência não estrita registra aviso');
  ok(resultadoFlexivel.verdict.avisos?.length === 1, 'veredito agregado preserva o aviso de proporção');
  ok(artefatoFlexivel.manifest.proporcao.ok === false && artefatoFlexivel.manifest.vereditos[0].avisos?.length === 1, 'aviso e resultado divergente chegam ao recibo');

  console.log(`PASSOU: ${passed}  FALHOU: ${failures.length}`);
  for (const failure of failures) console.log(`  ✗ ${failure}`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
