import { criarCliente, type StructuredBrief } from 'atelie/sdk';

const atelie = criarCliente({
  baseUrl: process.env.ATELIE_URL ?? 'http://127.0.0.1:4177',
  token: process.env.ATELIE_TOKEN,
});

const brief: StructuredBrief = {
  titulo: 'RELATÓRIO EM UMA PÁGINA',
  objetivo: 'Explicar o caminho de uma solicitação até a decisão auditável.',
  modo: 'explicacao',
  texto_fora_da_imagem: true,
  estilo: 'infografico-bento',
  secoes: [
    { rotulo: 'ENTRADA', itens: ['pedido', 'limites'] },
    { rotulo: 'EXECUÇÃO', itens: ['trabalho isolado', 'testes'] },
    { rotulo: 'DECISÃO', itens: ['veredito', 'recibo'] },
  ],
  legendas_curtas: true,
  idioma: 'pt-BR',
  tamanho: '2K',
  qualidade: 'medium',
  negativos: ['marca-d’água', 'logotipos'],
  refs: [],
  iteracoes: 1,
};

const queued = await atelie.createJob(brief);
const completed = await atelie.waitForJob(queued.id);
if (completed.status !== 'completed') throw new Error(`Ateliê terminou em ${completed.status}`);

const png = await atelie.artifact(completed.id, 1);
const receipt = completed.resultado?.artefatos[0]?.manifest;

// O AgentHub compõe receipt.rotulos_overlay em HTML/SVG sobre o PNG sem texto.
console.log(JSON.stringify({ jobId: completed.id, bytes: png.byteLength, rotulos: receipt?.rotulos_overlay, receipt }, null, 2));
