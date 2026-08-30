export interface CompararConteudoOptions {
  textoExtraPermitido?: boolean;
  texto_extra_permitido?: boolean;
  zeroTexto?: boolean;
  modo?: 'explicacao' | 'cena';
  texto_fora_da_imagem?: boolean;
  ordensObrigatorias?: string[][];
}

export interface ResultadoConteudo {
  faltantes: string[];
  extras: string[];
  numeracao: string[];
  ordemIncorreta: string[][];
  ok: boolean;
}

export interface TranscricaoConteudo {
  textos: string[];
  raw?: string;
  erro?: string;
}

/** Rubrica restrita à leitura: o modelo não recebe critérios nem decide aprovação. */
export function buildContentTranscriptionRubric(ordemVisual = false): string {
  return [
    'Transcreva todo o texto visível na imagem, sem avaliar, corrigir, resumir, explicar ou completar.',
    'Inclua títulos, rótulos, legendas, números, logotipos, marcas-d’água e pseudotexto que pareça legível.',
    ordemVisual ? 'Liste os textos na ordem visual de leitura, do início ao fim.' : '',
    'Responda APENAS com JSON no formato {"textos":["string 1","string 2"]}.',
    'Se não houver texto visível, responda {"textos":[]}.',
  ].filter(Boolean).join(' ');
}

export function coerceTranscricao(parsed: unknown, raw = ''): TranscricaoConteudo {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { textos: [], raw, erro: 'juiz de conteúdo não retornou JSON válido' };
  }
  const textos = (parsed as { textos?: unknown }).textos;
  if (!Array.isArray(textos) || textos.some((texto) => typeof texto !== 'string')) {
    return { textos: [], raw, erro: 'juiz de conteúdo não retornou uma lista de strings' };
  }
  return { textos: textos.map((texto) => texto.trim()).filter(Boolean), raw };
}

export function normalizarConteudo(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/\s+/g, ' ')
    .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '')
    .trim();
}

function distanciaEdicao(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const anterior = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = anterior[0];
    anterior[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const acima = anterior[j];
      anterior[j] = Math.min(
        anterior[j] + 1,
        anterior[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = acima;
    }
  }
  return anterior[b.length];
}

function limiteDistancia(tamanho: number): number {
  if (tamanho <= 4) return 0;
  if (tamanho <= 10) return 1;
  if (tamanho <= 24) return 2;
  return 3;
}

function correspondem(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const menor = a.length <= b.length ? a : b;
  const maior = a.length > b.length ? a : b;
  if (menor.length >= 3 && maior.includes(menor) && menor.length / maior.length >= 0.72) return true;
  if (Math.abs(a.length - b.length) > limiteDistancia(Math.max(a.length, b.length))) return false;
  return distanciaEdicao(a, b) <= limiteDistancia(Math.max(a.length, b.length));
}

function ehNumeracao(texto: string): boolean {
  return /^(?:\d+(?:[.,]\d+)*|[a-z]{1,3}\d+|\d+[a-z]{1,3})$/i.test(texto);
}

interface Ocorrencia {
  inicio: number;
  fim: number;
}

function localizarPermitida(normalizados: string[], permitida: string): Ocorrencia | undefined {
  for (let inicio = 0; inicio < normalizados.length; inicio++) {
    for (let quantidade = 1; quantidade <= 4 && inicio + quantidade <= normalizados.length; quantidade++) {
      const trecho = normalizados.slice(inicio, inicio + quantidade).join(' ');
      if (correspondem(trecho, permitida)) return { inicio, fim: inicio + quantidade - 1 };
    }
  }
  return undefined;
}

function unicos(strings: string[]): string[] {
  return [...new Set(strings)];
}

/**
 * Compara a transcrição com a allowlist sem delegar a decisão ao VLM.
 * A ordem da transcrição é preservada para validar seções ordenadas.
 */
export function compararConteudo(
  transcricao: string[],
  permitidas: string[],
  opts: CompararConteudoOptions = {},
): ResultadoConteudo {
  const entradas = transcricao
    .map((original) => ({ original: String(original).trim(), normalizada: normalizarConteudo(String(original)) }))
    .filter((entrada) => entrada.original && entrada.normalizada);
  const normalizados = entradas.map((entrada) => entrada.normalizada);
  const allowlist = permitidas.map((original) => ({ original, normalizada: normalizarConteudo(original) }));
  const ocorrencias = new Map<string, Ocorrencia>();

  for (const permitida of allowlist) {
    const ocorrencia = localizarPermitida(normalizados, permitida.normalizada);
    if (ocorrencia) ocorrencias.set(permitida.normalizada, ocorrencia);
  }

  const indicesPermitidos = new Set<number>();
  for (const ocorrencia of ocorrencias.values()) {
    for (let index = ocorrencia.inicio; index <= ocorrencia.fim; index++) indicesPermitidos.add(index);
  }

  const extras: string[] = [];
  const numeracao: string[] = [];
  entradas.forEach((entrada, index) => {
    if (indicesPermitidos.has(index)) return;
    if (allowlist.some((permitida) => correspondem(entrada.normalizada, permitida.normalizada))) return;
    if (ehNumeracao(entrada.normalizada)) numeracao.push(entrada.original);
    else extras.push(entrada.original);
  });

  const faltantes = allowlist
    .filter((permitida) => !ocorrencias.has(permitida.normalizada))
    .map((permitida) => permitida.original);

  const ordemIncorreta = (opts.ordensObrigatorias ?? []).filter((ordem) => {
    const posicoes = ordem
      .map((item) => ocorrencias.get(normalizarConteudo(item))?.inicio)
      .filter((posicao): posicao is number => posicao != null);
    return posicoes.length === ordem.length && posicoes.some((posicao, index) => index > 0 && posicao <= posicoes[index - 1]);
  });

  const temTexto = entradas.length > 0;
  const zeroTexto = opts.zeroTexto || opts.modo === 'cena' || opts.texto_fora_da_imagem;
  const textoExtraPermitido = opts.textoExtraPermitido || opts.texto_extra_permitido;
  const extrasVetados = !textoExtraPermitido && extras.length > 0;
  const ok = zeroTexto
    ? !temTexto
    : faltantes.length === 0 && !extrasVetados && ordemIncorreta.length === 0;

  return {
    faltantes: unicos(faltantes),
    extras: unicos(extras),
    numeracao: unicos(numeracao),
    ordemIncorreta,
    ok,
  };
}
