import type { PromptSlots } from '../types';
import type { StyleDef } from '../styles/catalog.types';
import { renderTemplate } from '../styles/catalog.types';

/** Heurística simples, sem LLM: o pedido inteiro vira o sujeito. */
export function buildSlots(request: string): PromptSlots {
  return { subject: request, scene: '', extra: '' };
}

/** Frase-núcleo do pedido (corta na 1ª vírgula/ponto, limita ~60 chars). */
export function subjectAnchor(request: string): string {
  const core = request.split(/[,.;\n]/)[0].trim();
  const anchor = core.length ? core : request.trim();
  return anchor.length > 60 ? anchor.slice(0, 60).trim() : anchor;
}

/**
 * Encapsula o pedido no template do estilo.
 * - Iteração 1 (sem judgeCtx): sujeito = pedido do usuário.
 * - Iteração k>1: se houver `prompt_sugerido`, ele vira a base do sujeito
 *   (re-encapsulada no template — o juiz não conhece estilo/flags); se não
 *   mencionar a âncora, prefixa "mantendo <anchor>, " (evita deriva de sujeito);
 *   por fim acrescenta " AJUSTE: <sugestao_melhoria>".
 * - `opts.avoid` (negativos): anexa " Avoid: <neg>." ao FINAL, sem mexer no sujeito.
 * - `opts.size` (dimensão): aceito por assinatura, mas NÃO altera o texto — a dimensão
 *   é passada por flag ao codex, não pelo prompt composto.
 */
export function compose(
  request: string,
  style: StyleDef,
  judgeCtx?: { sugestao_melhoria: string; prompt_sugerido: string; anchor: string },
  opts?: { avoid?: string; size?: string },
): string {
  const slots = buildSlots(request);
  let out: string;

  if (!judgeCtx) {
    slots.subject = request;
    out = renderTemplate(style.template, slots);
  } else {
    let base = judgeCtx.prompt_sugerido?.trim() ? judgeCtx.prompt_sugerido.trim() : request;
    if (judgeCtx.anchor && !base.toLowerCase().includes(judgeCtx.anchor.toLowerCase())) {
      base = `mantendo ${judgeCtx.anchor}, ${base}`;
    }
    slots.subject = base;
    out = renderTemplate(style.template, slots);
    const ajuste = judgeCtx.sugestao_melhoria?.trim();
    if (ajuste) out = `${out} AJUSTE: ${ajuste}`;
  }

  const avoid = opts?.avoid?.trim();
  if (avoid) out = `${out} Avoid: ${avoid}.`;
  return out;
}
