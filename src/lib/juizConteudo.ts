export interface CompararConteudoOptions {
  textoExtraPermitido?: boolean;
  texto_extra_permitido?: boolean;
  zeroTexto?: boolean;
  modo?: 'explicacao' | 'cena' | 'componente';
  texto_fora_da_imagem?: boolean;
  ortografiaEstrita?: boolean;
  ortografia_estrita?: boolean;
  ordensObrigatorias?: string[][];
}

export interface DivergenciaOrtografica {
  esperado: string;
  transcrito: string;
}

export interface ResultadoConteudo {
  faltantes: string[];
  extras: string[];
  numeracao: string[];
  ortografia: DivergenciaOrtografica[];
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
    'Transcreva todo o texto visível na imagem, sem avaliar, resumir, explicar ou completar.',
    'Transcreva EXATAMENTE como está escrito, inclusive erros de acentuação e letras trocadas; não corrija.',
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
  if (Math.abs(a.length - b.length) > limiteDistancia(Math.max(a.length, b.length))) return false;
  return distanciaEdicao(a, b) <= limiteDistancia(Math.max(a.length, b.length));
}

function ehNumeracao(texto: string): boolean {
  return /^(?:\d{1,3}|[a-z]{1,2}\d{1,2}|\d{1,2}[a-z]{1,2})$/i.test(texto)
    || /^[ivxlcdm]{1,5}$/i.test(texto);
}

function ehMarcador(texto: string): boolean {
  return /^[•●◦▪▫‣⁃*\-–—]+$/u.test(texto.trim());
}

interface TokenConteudo {
  original: string;
  normalizado: string;
  entrada: number;
  indiceNaEntrada: number;
}

interface EntradaConteudo {
  original: string;
  tokens: TokenConteudo[];
}

interface Ocorrencia {
  inicio: number;
  fim: number;
  offset: number;
  tokens: TokenConteudo[];
}

function tokenizar(original: string, entrada: number): TokenConteudo[] {
  return [...original.matchAll(/[\p{L}\p{N}]+/gu)].map((match, indiceNaEntrada) => ({
    original: match[0],
    normalizado: normalizarConteudo(match[0]),
    entrada,
    indiceNaEntrada,
  }));
}

function localizarPermitida(tokens: TokenConteudo[], permitida: string): Ocorrencia | undefined {
  const quantidade = tokenizar(permitida, -1).length;
  if (!quantidade) return undefined;
  let melhor: Ocorrencia | undefined;
  let menorDistancia = Number.POSITIVE_INFINITY;
  for (let inicio = 0; inicio + quantidade <= tokens.length; inicio++) {
    const trechoTokens = tokens.slice(inicio, inicio + quantidade);
    const trecho = trechoTokens.map((token) => token.normalizado).join(' ');
    if (correspondem(trecho, permitida)) {
      const distancia = distanciaEdicao(trecho, permitida);
      if (distancia >= menorDistancia) continue;
      menorDistancia = distancia;
      melhor = {
        inicio: trechoTokens[0].entrada,
        fim: trechoTokens[trechoTokens.length - 1].entrada,
        offset: trechoTokens[0].indiceNaEntrada,
        tokens: trechoTokens,
      };
      if (distancia === 0) break;
    }
  }
  return melhor;
}

function formaOrtografica(texto: string): string {
  return texto.normalize('NFC').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim();
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
  const entradas: EntradaConteudo[] = transcricao
    .map(String)
    .map((original) => original.trim())
    .filter(Boolean)
    .map((original, index) => ({ original, tokens: tokenizar(original, index) }));
  const tokens = entradas.flatMap((entrada) => entrada.tokens);
  const allowlist = permitidas.map((original) => ({
    original,
    normalizada: tokenizar(original, -1).map((token) => token.normalizado).join(' '),
    ortografica: tokenizar(original, -1).map((token) => token.original).join(' '),
  }));
  const ocorrencias = new Map<string, Ocorrencia>();

  for (const permitida of allowlist) {
    const ocorrencia = localizarPermitida(tokens, permitida.normalizada);
    if (ocorrencia) ocorrencias.set(permitida.normalizada, ocorrencia);
  }

  const tokensCobertos = new Set<TokenConteudo>();
  for (const ocorrencia of ocorrencias.values()) {
    for (const token of ocorrencia.tokens) tokensCobertos.add(token);
  }

  const extras: string[] = [];
  const numeracao: string[] = [];
  for (const entrada of entradas) {
    const marcador = entrada.original.match(/^\s*([•●◦▪▫‣⁃*\-–—]+)(?:\s+|(?=[\p{L}\p{N}]))/u)?.[1];
    if (marcador) numeracao.push(marcador);
    if (!entrada.tokens.length) {
      if (!marcador && ehMarcador(entrada.original)) numeracao.push(entrada.original);
      else if (!marcador) extras.push(entrada.original);
      continue;
    }
    let grupo: TokenConteudo[] = [];
    const classificarGrupo = (proximoCoberto: boolean) => {
      if (!grupo.length) return;
      const original = grupo.map((token) => token.original).join(' ');
      const entradaSoTemNumeracao = grupo.length === entrada.tokens.length;
      if (grupo.every((token) => ehNumeracao(token.original)) && (entradaSoTemNumeracao || proximoCoberto)) numeracao.push(original);
      else extras.push(original);
      grupo = [];
    };
    entrada.tokens.forEach((token) => {
      if (tokensCobertos.has(token)) classificarGrupo(true);
      else grupo.push(token);
    });
    classificarGrupo(false);
  }

  const faltantes = allowlist
    .filter((permitida) => !ocorrencias.has(permitida.normalizada))
    .map((permitida) => permitida.original);
  const ortografia = allowlist.flatMap((permitida): DivergenciaOrtografica[] => {
    const ocorrencia = ocorrencias.get(permitida.normalizada);
    if (!ocorrencia) return [];
    const transcrito = ocorrencia.tokens.map((token) => token.original).join(' ');
    return formaOrtografica(transcrito) === formaOrtografica(permitida.ortografica)
      ? []
      : [{ esperado: permitida.original, transcrito }];
  });

  const ordemIncorreta = (opts.ordensObrigatorias ?? []).filter((ordem) => {
    const posicoes = ordem
      .map((item) => ocorrencias.get(tokenizar(item, -1).map((token) => token.normalizado).join(' ')))
      .filter((posicao): posicao is Ocorrencia => posicao != null);
    return posicoes.length === ordem.length && posicoes.some((posicao, index) => index > 0 && (
      posicao.inicio < posicoes[index - 1].inicio
      || (posicao.inicio === posicoes[index - 1].inicio && posicao.offset <= posicoes[index - 1].offset)
    ));
  });

  const temTexto = entradas.length > 0;
  const zeroTexto = opts.zeroTexto || opts.modo === 'cena' || opts.texto_fora_da_imagem;
  const textoExtraPermitido = opts.textoExtraPermitido || opts.texto_extra_permitido;
  const ortografiaEstrita = opts.ortografiaEstrita ?? opts.ortografia_estrita ?? opts.modo === 'explicacao';
  const extrasVetados = !textoExtraPermitido && extras.length > 0;
  const ok = zeroTexto
    ? !temTexto
    : faltantes.length === 0 && !extrasVetados && ordemIncorreta.length === 0 && !(ortografiaEstrita && ortografia.length);

  return {
    faltantes: unicos(faltantes),
    extras: unicos(extras),
    numeracao: unicos(numeracao),
    ortografia,
    ordemIncorreta,
    ok,
  };
}
