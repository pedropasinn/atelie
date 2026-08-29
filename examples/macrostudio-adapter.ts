import { criarCliente, type AtelieClient, type StructuredBrief } from 'atelie/sdk';

// No consumidor real, importe estes tipos de `Macrostudio/src/dominio/papel`
// e `Macrostudio/src/dominio/suporte`. Aqui a forma mínima deixa o exemplo isolado.
type Papel = 'acento' | 'acentoEscuro' | 'tinta' | 'tintaSuave' | 'neutro' | 'rejeita' | 'naoRejeita' | 'inconclusivo';
type IdSuporte = 'reels' | 'corte' | 'paisagem' | 'card' | 'post';

export interface CenaParaImagem {
  id: string;
  objetivo: string;
  elementos: string[];
  suporte: IdSuporte;
  papeisDeCor?: Partial<Record<Papel, string>>;
}

/** Porta proposta ao lado de `GeradorCriativo`, em `Macrostudio/src/ports`. */
export interface GeradorDeImagemParaCena {
  gerarImagemParaCena(cena: CenaParaImagem, estilo: string): Promise<{
    png: Uint8Array;
    atelieJobId: string;
    manifest: unknown;
  }>;
}

const tamanhoPorSuporte: Record<IdSuporte, string> = {
  reels: '1536x2048',
  corte: '1536x2048',
  paisagem: '2048x1152',
  card: '1536x2048',
  post: '2048x2048',
};

export class AtelieGeradorDeImagemParaCena implements GeradorDeImagemParaCena {
  constructor(private readonly client: AtelieClient = criarCliente({
    baseUrl: process.env.ATELIE_URL ?? 'http://127.0.0.1:4177',
    token: process.env.ATELIE_TOKEN,
  })) {}

  async gerarImagemParaCena(cena: CenaParaImagem, estilo: string) {
    const brief: StructuredBrief = {
      titulo: cena.id,
      objetivo: cena.objetivo,
      modo: 'cena',
      estilo,
      secoes: [{ rotulo: 'elementos', itens: cena.elementos }],
      legendas_curtas: false,
      idioma: 'pt-BR',
      tamanho: tamanhoPorSuporte[cena.suporte],
      qualidade: 'medium',
      negativos: ['texto', 'logotipo', 'marca-d’água'],
      refs: [],
      paleta: cena.papeisDeCor,
      iteracoes: 1,
    };
    const queued = await this.client.createJob(brief);
    const completed = await this.client.waitForJob(queued.id);
    if (completed.status !== 'completed') throw new Error(`Ateliê terminou em ${completed.status}`);
    return {
      png: await this.client.artifact(completed.id, 1),
      atelieJobId: completed.id,
      manifest: completed.resultado?.artefatos[0]?.manifest,
    };
  }
}
