import { createHash } from 'node:crypto';

import type { StyleDef } from '../styles/catalog.types';
import type { FundoLimites, FundoMotor } from './backgroundRemoval';
import { compose } from './promptComposer';

export type BriefMode = 'explicacao' | 'cena' | 'componente';
export type BriefQuality = 'low' | 'medium' | 'high';
export type RemocaoFundo = 'obrigatorio' | 'opcional' | 'nao';

export interface BriefSection {
  rotulo: string;
  itens: string[];
  ordem_obrigatoria?: boolean;
}

export interface StructuredBrief {
  titulo: string;
  objetivo: string;
  modo?: BriefMode;
  /** Único provedor de geração implementado nesta versão. */
  provedor?: 'codex';
  estilo?: string;
  estilos?: string[];
  /** Em explicações, gera só a camada visual e devolve os rótulos no manifest. */
  texto_fora_da_imagem?: boolean;
  /** Permite texto além da allowlist no raster. O default é false. */
  texto_extra_permitido?: boolean;
  /** Allowlist de texto para logos e outros componentes. */
  texto_permitido?: string[];
  /** Cor lisa pedida à geração antes da remoção. */
  fundo_geracao?: string;
  remover_fundo?: RemocaoFundo;
  motor_fundo?: FundoMotor;
  modelo_fundo?: string;
  limites_fundo?: FundoLimites;
  /** Largura em que o artefato será efetivamente exibido. */
  largura_final_px?: number;
  secoes: BriefSection[];
  legendas_curtas: boolean;
  idioma: 'pt-BR';
  tamanho: string;
  /** Reprova e repete tentativas cuja proporção real diverge da solicitada. */
  proporcao_estrita?: boolean;
  /** Reprova divergências de letras ou acentos no modo explicação. */
  ortografia_estrita?: boolean;
  qualidade: BriefQuality;
  negativos: string[];
  refs: string[];
  paleta?: Record<string, string>;
  /** Número de novas tentativas depois da primeira geração. */
  iteracoes?: number;
}

export interface ComposedBrief {
  brief: StructuredBrief;
  prompt: string;
  stringsVisiveis: string[];
  ordensObrigatorias: string[][];
  rotulosOverlay: OverlayLabel[];
  avisos: string[];
}

export interface OverlayLabel {
  id: string;
  tipo: 'titulo' | 'secao' | 'item';
  texto: string;
  secao?: number;
}

const MAX_VISIBLE_STRINGS = 12;
const MAX_LABEL_LENGTH = 42;

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((v) => v.trim()).filter(Boolean);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`brief inválido: "${field}" é obrigatório`);
  return value.trim();
}

function normalizeFundoLimits(value: unknown): FundoLimites | undefined {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('brief inválido: "limites_fundo" precisa ser um objeto');
  }
  const raw = value as Record<string, unknown>;
  const campos: Array<keyof FundoLimites> = [
    'fracao_transparente_min', 'fracao_transparente_max', 'borda_transparente_min',
    'margem_minima_pct_min', 'fracao_maior_componente_min', 'halo_max',
    'tolerancia_cor',
  ];
  const result: FundoLimites = {};
  for (const campo of campos) {
    if (raw[campo] == null) continue;
    const numero = Number(raw[campo]);
    if (!Number.isFinite(numero) || numero < 0) throw new Error(`brief inválido: limite "${campo}" precisa ser um número não negativo`);
    result[campo] = numero;
  }
  return Object.keys(result).length ? result : undefined;
}

/** Valida e preenche defaults sem aceitar campos de credencial. */
export function normalizeBrief(value: unknown): StructuredBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('brief inválido: esperado um objeto JSON');
  const raw = value as Record<string, unknown>;
  const modo: BriefMode = raw.modo === 'cena' || raw.modo === 'componente' ? raw.modo : 'explicacao';
  const requestedProvider = raw.provedor ?? raw.provider;
  if (requestedProvider != null && requestedProvider !== 'codex') {
    throw new Error(`brief inválido: provedor "${String(requestedProvider)}" não é suportado; use "codex"`);
  }
  const qualidade: BriefQuality = raw.qualidade === 'low' || raw.qualidade === 'high' ? raw.qualidade : 'medium';
  const idioma = raw.idioma == null ? 'pt-BR' : raw.idioma;
  if (idioma !== 'pt-BR') throw new Error('brief inválido: somente idioma "pt-BR" é suportado nesta versão');

  const secoesRaw = raw.secoes == null ? [] : raw.secoes;
  if (!Array.isArray(secoesRaw)) throw new Error('brief inválido: "secoes" precisa ser uma lista');
  const secoes = secoesRaw.map((section, index): BriefSection => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      throw new Error(`brief inválido: seção ${index + 1} precisa ser um objeto`);
    }
    const s = section as Record<string, unknown>;
    return {
      rotulo: requiredString(s.rotulo, `secoes[${index}].rotulo`),
      itens: stringArray(s.itens),
      ordem_obrigatoria: s.ordem_obrigatoria === true,
    };
  });

  const estilo = typeof raw.estilo === 'string' && raw.estilo.trim() ? raw.estilo.trim() : undefined;
  const estilos = [...new Set([...(estilo ? [estilo] : []), ...stringArray(raw.estilos)])].sort();
  if (!estilos.length) throw new Error('brief inválido: informe "estilo" ou "estilos"');

  const paleta = raw.paleta && typeof raw.paleta === 'object' && !Array.isArray(raw.paleta)
    ? Object.fromEntries(Object.entries(raw.paleta as Record<string, unknown>)
      .filter(([, cor]) => typeof cor === 'string' && cor.trim())
      .map(([papel, cor]) => [papel, String(cor).trim()]))
    : undefined;

  const iteracoes = Number(raw.iteracoes);
  const larguraFinal = Number(raw.largura_final_px);
  if (raw.largura_final_px != null && (!Number.isFinite(larguraFinal) || larguraFinal < 1)) {
    throw new Error('brief inválido: "largura_final_px" precisa ser um número positivo em pixels');
  }
  const titulo = requiredString(raw.titulo, 'titulo');
  if (titulo.length > MAX_LABEL_LENGTH) {
    throw new Error(`brief inválido: "titulo" pode ter no máximo ${MAX_LABEL_LENGTH} caracteres para permanecer legível`);
  }
  const removerFundo: RemocaoFundo = raw.remover_fundo === 'opcional' || raw.remover_fundo === 'nao' ? raw.remover_fundo : 'obrigatorio';
  const motorFundo: FundoMotor = raw.motor_fundo === 'cor-solida' || raw.motor_fundo === 'nenhum' ? raw.motor_fundo : 'rembg';
  const modeloFundo = typeof raw.modelo_fundo === 'string' && raw.modelo_fundo.trim() ? raw.modelo_fundo.trim() : 'isnet-general-use';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(modeloFundo)) {
    throw new Error('brief inválido: "modelo_fundo" deve conter apenas a-z, 0-9, ponto, hífen ou sublinhado');
  }
  return {
    titulo,
    objetivo: requiredString(raw.objetivo, 'objetivo'),
    modo,
    provedor: 'codex',
    estilos,
    texto_fora_da_imagem: modo === 'explicacao' && raw.texto_fora_da_imagem === true,
    texto_extra_permitido: modo === 'componente' ? false : raw.texto_extra_permitido === true,
    texto_permitido: modo === 'componente' ? stringArray(raw.texto_permitido) : undefined,
    fundo_geracao: modo === 'componente'
      ? typeof raw.fundo_geracao === 'string' && raw.fundo_geracao.trim() ? raw.fundo_geracao.trim() : '#00FF41'
      : undefined,
    remover_fundo: modo === 'componente' ? removerFundo : undefined,
    motor_fundo: modo === 'componente' ? motorFundo : undefined,
    modelo_fundo: modo === 'componente'
      ? modeloFundo
      : undefined,
    limites_fundo: modo === 'componente' ? normalizeFundoLimits(raw.limites_fundo) : undefined,
    largura_final_px: raw.largura_final_px == null ? undefined : Math.round(larguraFinal),
    secoes,
    legendas_curtas: raw.legendas_curtas !== false,
    idioma: 'pt-BR',
    tamanho: typeof raw.tamanho === 'string' && raw.tamanho.trim() ? raw.tamanho.trim() : '2K',
    proporcao_estrita: typeof raw.proporcao_estrita === 'boolean' ? raw.proporcao_estrita : modo === 'explicacao',
    ortografia_estrita: typeof raw.ortografia_estrita === 'boolean' ? raw.ortografia_estrita : modo !== 'cena',
    qualidade,
    negativos: stringArray(raw.negativos),
    refs: stringArray(raw.refs),
    paleta: paleta && Object.keys(paleta).length ? paleta : undefined,
    iteracoes: Number.isFinite(iteracoes) ? Math.max(0, Math.min(10, Math.round(iteracoes))) : 1,
  };
}

export function briefStyles(brief: StructuredBrief): string[] {
  return [...new Set([...(brief.estilo ? [brief.estilo] : []), ...(brief.estilos ?? [])])].sort();
}

export function overlayLabels(brief: StructuredBrief): OverlayLabel[] {
  const labels: OverlayLabel[] = [{ id: 'titulo', tipo: 'titulo', texto: brief.titulo }];
  brief.secoes.forEach((section, sectionIndex) => {
    labels.push({ id: `secao-${sectionIndex + 1}`, tipo: 'secao', texto: section.rotulo, secao: sectionIndex + 1 });
    section.itens.forEach((item, itemIndex) => {
      labels.push({ id: `secao-${sectionIndex + 1}-item-${itemIndex + 1}`, tipo: 'item', texto: item, secao: sectionIndex + 1 });
    });
  });
  return labels;
}

function quote(text: string): string {
  return `"${text.replace(/["\n\r]+/g, ' ').trim()}"`;
}

function paletteInstruction(palette?: Record<string, string>): string {
  if (!palette || !Object.keys(palette).length) return '';
  return `Paleta semântica por papel: ${Object.entries(palette).map(([role, color]) => `${role}=${color}`).join(', ')}.`;
}

/**
 * Compõe o pedido sem LLM. No modo explicação, só strings curtas entram na lista
 * literal; os demais itens viram conceitos visuais, evitando microtexto.
 */
export function composeBriefPrompt(value: unknown, style: StyleDef): ComposedBrief {
  const brief = normalizeBrief(value);
  const avisos: string[] = [];
  if (brief.modo === 'componente') {
    const concepts = brief.secoes.flatMap((s) => [s.rotulo, ...s.itens]).join('; ');
    const permitidas = brief.texto_permitido ?? [];
    const regraTexto = permitidas.length
      ? `As únicas strings permitidas são: ${permitidas.map(quote).join(', ')}. Não escreva nenhuma outra letra, número ou pseudotexto.`
      : 'Não renderize texto, letras, números, legendas, logotipos, marcas-d’água ou pseudotexto.';
    const request = [
      `Crie um único componente visual: ${brief.objetivo}.`,
      concepts ? `Características do objeto: ${concepts}.` : '',
      paletteInstruction(brief.paleta),
      'Mostre exatamente um objeto, inteiro, centralizado e isolado, com margem livre generosa em todos os lados.',
      `Use fundo liso perfeitamente uniforme na cor ${brief.fundo_geracao}, sem textura, cenário, gradiente ou variação de iluminação. Não use essa cor em nenhuma parte do objeto.`,
      'Não use sombra projetada, sombra chapada no chão nem elementos soltos ao redor do objeto.',
      regraTexto,
    ].filter(Boolean).join(' ');
    const styled = compose(request, style, undefined, {
      avoid: [...brief.negativos, 'fundo com gradiente', 'cenário', 'sombra projetada', 'objeto cortado', permitidas.length ? 'texto não autorizado' : 'texto'].join(', '),
    });
    return {
      brief,
      prompt: `${styled} REGRA PRIORITÁRIA DE COMPONENTE: objeto único e completo, centralizado com margem, fundo liso uniforme ${brief.fundo_geracao}, sem sombra projetada. ${regraTexto}`,
      stringsVisiveis: permitidas,
      ordensObrigatorias: [],
      rotulosOverlay: [],
      avisos,
    };
  }
  if (brief.modo === 'cena' || brief.texto_fora_da_imagem) {
    const concepts = brief.secoes.flatMap((s) => [s.rotulo, ...s.itens]).join('; ');
    const request = [
      brief.objetivo,
      concepts ? `Elementos da cena: ${concepts}.` : '',
      paletteInstruction(brief.paleta),
      brief.modo === 'cena'
        ? 'Imagem puramente visual para uma peça/cena.'
        : 'Camada visual de uma explicação; reserve composição e áreas livres para o consumidor aplicar os rótulos depois.',
      'Não renderize texto, letras, números, legendas, logotipos ou marcas-d’água.',
    ].filter(Boolean).join(' ');
    const styled = compose(request, style, undefined, { avoid: [...brief.negativos, 'texto', 'letras', 'logotipos', 'marca-d’água'].join(', ') });
    return {
      brief,
      prompt: `${styled} REGRA PRIORITÁRIA: zero texto visível; ignore qualquer sugestão do estilo sobre títulos, rótulos, números ou tipografia.`,
      stringsVisiveis: [],
      ordensObrigatorias: [],
      rotulosOverlay: brief.texto_fora_da_imagem ? overlayLabels(brief) : [],
      avisos,
    };
  }

  const candidates = [brief.titulo, ...brief.secoes.map((s) => s.rotulo), ...brief.secoes.flatMap((s) => s.itens)];
  const short = candidates.filter((s) => s.length <= MAX_LABEL_LENGTH);
  const stringsVisiveis = short.slice(0, MAX_VISIBLE_STRINGS);
  if (short.length < candidates.length) avisos.push(`rótulos com mais de ${MAX_LABEL_LENGTH} caracteres foram convertidos em conceitos visuais`);
  if (short.length > MAX_VISIBLE_STRINGS) avisos.push(`somente ${MAX_VISIBLE_STRINGS} strings serão exibidas para preservar legibilidade`);

  const rendered = new Set(stringsVisiveis);
  const ordensObrigatorias = brief.secoes
    .filter((section) => section.ordem_obrigatoria)
    .map((section) => section.itens.filter((item) => rendered.has(item)))
    .filter((ordem) => ordem.length > 1);
  const sections = brief.secoes.map((section, index) => {
    const visibleItems = section.itens.filter((item) => rendered.has(item));
    const visualItems = section.itens.filter((item) => !rendered.has(item));
    return [
      `Seção ${index + 1}: ${rendered.has(section.rotulo) ? quote(section.rotulo) : section.rotulo}.`,
      visibleItems.length ? `Rótulos literais: ${visibleItems.map(quote).join(', ')}.` : '',
      section.ordem_obrigatoria && visibleItems.length > 1
        ? `Ordem visual obrigatória: ${visibleItems.map(quote).join(' → ')}.`
        : '',
      visualItems.length ? `Represente visualmente, sem escrever: ${visualItems.join('; ')}.` : '',
    ].filter(Boolean).join(' ');
  }).join(' ');

  const request = [
    `Infográfico em português do Brasil intitulado exatamente ${quote(brief.titulo)}.`,
    `Objetivo: ${brief.objetivo}.`,
    sections,
    paletteInstruction(brief.paleta),
    `As únicas strings permitidas na imagem são: ${stringsVisiveis.map(quote).join(', ')}.`,
    'Renderize cada string exatamente como fornecida, com ortografia e acentuação corretas.',
    'Use poucos rótulos, grandes e bem espaçados; proíba parágrafos, notas de rodapé e microtexto.',
  ].filter(Boolean).join(' ');

  return {
    brief,
    prompt: compose(request, style, undefined, { avoid: [...brief.negativos, 'microtexto', 'texto ilegível', 'caracteres inventados'].join(', ') }),
    stringsVisiveis,
    ordensObrigatorias,
    rotulosOverlay: [],
    avisos,
  };
}

/** JSON canônico e hash usados pela idempotência HTTP. */
export function canonicalBrief(value: unknown): string {
  const normalized = normalizeBrief(value);
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (!input || typeof input !== 'object') return input;
    return Object.fromEntries(Object.keys(input as Record<string, unknown>).sort().map((key) => [key, sort((input as Record<string, unknown>)[key])]));
  };
  return JSON.stringify(sort(normalized));
}

export function briefHash(value: unknown): string {
  return createHash('sha256').update(canonicalBrief(value)).digest('hex');
}

export function buildLegibilityRubric(composed: ComposedBrief, threshold = 7, larguraOriginalPx?: number): string {
  const larguraFinal = composed.brief.largura_final_px;
  const legibilidadeFinal = larguraFinal
    ? `A imagem será exibida com ${larguraFinal} px de largura${larguraOriginalPx ? ` (fator de redução final/original ${(larguraFinal / larguraOriginalPx).toFixed(3)})` : ''}; reprove se algum texto ficaria abaixo de aproximadamente 12 px de altura nesse tamanho final.`
    : '';
  return [
    'Você é o juiz visual do Ateliê. O conteúdo textual já foi verificado separadamente; não transcreva nem compare a allowlist.',
    'Avalie legibilidade, hierarquia, composição, contraste, fidelidade visual e clareza semântica.',
    composed.brief.modo === 'componente'
      ? 'Este é um componente sobre xadrez de transparência. Reprove resíduos de fundo, bordas serrilhadas ou com halo, objeto incompleto/cortado e sombra chapada ou projetada.'
      : composed.brief.modo === 'cena' || composed.brief.texto_fora_da_imagem
      ? 'Esta imagem deve ter zero texto: reprove se houver qualquer letra, número, legenda, logotipo, marca-d’água ou pseudotexto.'
      : 'Reprove texto ilegível, cortado, sobreposto, microtexto, pseudotexto ou com ortografia/acentuação visivelmente errada.',
    'Reprove estruturas semanticamente vazias, repetitivas ou que não diferenciem os conceitos pedidos.',
    legibilidadeFinal,
    `Avalie também se a imagem cumpre o objetivo: ${quote(composed.brief.objetivo)}.`,
    `Aprovação exige nota >= ${threshold} e nenhuma falha de legibilidade visual.`,
    'Responda APENAS JSON no schema {aprovado,nota,alinhamento,problemas,sugestao_melhoria,prompt_sugerido}.',
    'problemas é array de strings; sugestao_melhoria é uma instrução acionável; prompt_sugerido é um prompt completo para regenerar.',
  ].filter(Boolean).join(' ');
}
