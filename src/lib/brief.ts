import { createHash } from 'node:crypto';

import type { StyleDef } from '../styles/catalog.types';
import { compose } from './promptComposer';

export type BriefMode = 'explicacao' | 'cena';
export type BriefQuality = 'low' | 'medium' | 'high';

export interface BriefSection {
  rotulo: string;
  itens: string[];
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
  secoes: BriefSection[];
  legendas_curtas: boolean;
  idioma: 'pt-BR';
  tamanho: string;
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

/** Valida e preenche defaults sem aceitar campos de credencial. */
export function normalizeBrief(value: unknown): StructuredBrief {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('brief inválido: esperado um objeto JSON');
  const raw = value as Record<string, unknown>;
  const modo: BriefMode = raw.modo === 'cena' ? 'cena' : 'explicacao';
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
    return { rotulo: requiredString(s.rotulo, `secoes[${index}].rotulo`), itens: stringArray(s.itens) };
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
  const titulo = requiredString(raw.titulo, 'titulo');
  if (titulo.length > MAX_LABEL_LENGTH) {
    throw new Error(`brief inválido: "titulo" pode ter no máximo ${MAX_LABEL_LENGTH} caracteres para permanecer legível`);
  }
  return {
    titulo,
    objetivo: requiredString(raw.objetivo, 'objetivo'),
    modo,
    provedor: 'codex',
    estilos,
    texto_fora_da_imagem: modo === 'explicacao' && raw.texto_fora_da_imagem === true,
    secoes,
    legendas_curtas: raw.legendas_curtas !== false,
    idioma: 'pt-BR',
    tamanho: typeof raw.tamanho === 'string' && raw.tamanho.trim() ? raw.tamanho.trim() : '2K',
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
  const sections = brief.secoes.map((section, index) => {
    const visibleItems = section.itens.filter((item) => rendered.has(item));
    const visualItems = section.itens.filter((item) => !rendered.has(item));
    return [
      `Seção ${index + 1}: ${rendered.has(section.rotulo) ? quote(section.rotulo) : section.rotulo}.`,
      visibleItems.length ? `Rótulos literais: ${visibleItems.map(quote).join(', ')}.` : '',
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

export function buildLegibilityRubric(composed: ComposedBrief, threshold = 7): string {
  const textRule = composed.brief.modo === 'cena' || composed.brief.texto_fora_da_imagem
    ? 'A imagem deve conter ZERO texto. Reprove se houver letras, números, pseudotexto, logotipo ou marca-d’água.'
    : `Confira literalmente estas strings: ${composed.stringsVisiveis.map(quote).join(', ')}. Reprove se qualquer uma estiver ilegível, ausente quando central, com ortografia/acentuação errada ou se houver pseudotexto/microtexto não pedido.`;
  return [
    'Você é o juiz de legibilidade e fidelidade visual do Ateliê.',
    textRule,
    `Avalie também se a imagem cumpre o objetivo: ${quote(composed.brief.objetivo)}.`,
    `Aprovação exige nota >= ${threshold} e nenhuma falha de legibilidade ou ortografia.`,
    'Responda APENAS JSON no schema {aprovado,nota,alinhamento,problemas,sugestao_melhoria,prompt_sugerido}.',
    'problemas é array de strings; sugestao_melhoria é uma instrução acionável; prompt_sugerido é um prompt completo para regenerar.',
  ].join(' ');
}
