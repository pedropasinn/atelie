import { extractJson } from '../jsonx';
import { askImagesRaw } from '../judgeProviders';
import type { Canon, ConsistencyVerdict, JudgeSpec } from '../../types';

/** Veredito de consistência ilegível (o juiz não devolveu JSON válido). */
export function fallbackConsistency(raw: string): ConsistencyVerdict {
  return {
    consistencia: null,
    cenaNota: null,
    drifts: ['juiz de consistência não retornou JSON'],
    sugestao_melhoria: '',
    prompt_sugerido: '',
    raw,
  };
}

function clamp10(v: any): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(10, n)) : null;
}

export function coerceConsistency(parsed: any, raw: string): ConsistencyVerdict {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallbackConsistency(raw);
  const drifts = Array.isArray(parsed.drifts)
    ? parsed.drifts.map((d: any) => String(d)).filter((d: string) => d.trim())
    : parsed.drifts != null
      ? [String(parsed.drifts)]
      : [];
  return {
    consistencia: clamp10(parsed.consistencia ?? parsed.consistency),
    cenaNota: clamp10(parsed.cenaNota ?? parsed.cena_nota ?? parsed.cenanota ?? parsed.scene),
    drifts,
    sugestao_melhoria: parsed.sugestao_melhoria != null ? String(parsed.sugestao_melhoria) : '',
    prompt_sugerido: parsed.prompt_sugerido != null ? String(parsed.prompt_sugerido) : '',
    raw,
  };
}

const SCHEMA =
  'Responda APENAS com JSON no schema {"consistencia":0-10,"cenaNota":0-10,"drifts":[strings],"sugestao_melhoria":"instrução única acionável","prompt_sugerido":"prompt completo reescrito para corrigir os drifts"}. ' +
  'consistencia = fidelidade do personagem/estilo à(s) referência(s) (rosto, cabelo, cor, roupa, óculos/acessórios, linha, paleta). ' +
  'cenaNota = o quanto o painel cumpre a CENA pedida. drifts = diferenças CONCRETAS e específicas vs a referência. Sem texto ao redor do JSON.';

function canonSummary(canon: Canon, cena: string): string {
  const parts: string[] = [];
  if (canon.estiloDescricao?.trim()) parts.push(`ESTILO ALVO: ${canon.estiloDescricao.trim()}.`);
  if (canon.paleta?.trim()) parts.push(`PALETA: ${canon.paleta.trim()}.`);
  parts.push(`CENA PEDIDA: ${cena}.`);
  return parts.join(' ');
}

/** Rubrica p/ claude/codex (veem os bytes): 1..k = referência, última = candidato. */
function buildBytesRubric(canon: Canon, cena: string, k: number): string {
  return [
    'Você é um diretor de arte avaliando a COERÊNCIA de uma série ilustrada.',
    `As primeiras ${k} imagem(ns) são a REFERÊNCIA (âncoras dos personagens); a ÚLTIMA imagem é o NOVO painel a avaliar.`,
    canonSummary(canon, cena),
    'Avalie se o personagem/estilo do novo painel se mantém IDÊNTICO à(s) referência(s) e se a cena foi cumprida; seja crítico e específico.',
    SCHEMA,
  ].join(' ');
}

/**
 * Juiz de consistência multi-imagem: recebe as âncoras (refs) + o painel candidato,
 * pontua consistência (personagem/estilo) e fidelidade à cena, e devolve drifts
 * concretos + sugestão/prompt corretivos. Reusa o transporte multi-imagem
 * (askImagesRaw) — claude usa N blocos image e codex usa N input_image.
 */
export async function judgeConsistency(
  refs: string[],
  candidate: string,
  canon: Canon,
  cena: string,
  spec: JudgeSpec,
  signal?: AbortSignal,
): Promise<ConsistencyVerdict> {
  const images = [...refs, candidate]; // referência(s) primeiro, candidato por último
  const rubric = buildBytesRubric(canon, cena, refs.length);

  let text = await askImagesRaw(spec, images, rubric, signal);
  let parsed = extractJson(text);
  if (parsed == null) {
    // retry 1× reforçando "só JSON"
    text = await askImagesRaw(spec, images, rubric + ' IMPORTANTE: responda somente com o objeto JSON.', signal);
    parsed = extractJson(text);
  }
  return coerceConsistency(parsed, text);
}
