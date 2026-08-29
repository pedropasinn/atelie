import fs from 'fs';
import { loadSettings } from './settings';
import type { Verdict } from '../types';
import { extractJson } from './jsonx';
import { detectImageFormat } from './imageFormat';
import { run } from './runner';

// ── Transporte multimodal compartilhado (juiz e styleGenerator) ────────────
export type ClaudeBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Envia UM turno user (array de blocos) ao `claude -p` em stream-json e devolve
 * o texto acumulado (assistant + result). O texto costuma vir DUPLICADO; o
 * `extractJson` do chamador recorta o 1º objeto balanceado e descarta a cópia.
 */
export async function askClaudeVision(content: ClaudeBlock[], model: string, signal?: AbortSignal): Promise<string> {
  const event = { type: 'user', message: { role: 'user', content } };
  const { stdout } = await run(
    'claude',
    ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--model', model],
    { stdinData: JSON.stringify(event) + '\n', timeoutMs: 180000, signal },
  ).done;

  let text = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
      for (const block of ev.message.content) {
        if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
      }
    } else if (ev.type === 'result' && typeof ev.result === 'string') {
      text += ev.result;
    }
  }
  return text;
}

export function buildRubric(
  request: string,
  style: { nome: string; desc: string },
  threshold: number,
  strict: boolean,
): string {
  const parts = [
    'Você é um diretor de arte rigoroso avaliando uma imagem gerada por IA.',
    `PEDIDO DO USUÁRIO: "${request}".`,
    `ESTILO ALVO: "${style.nome}" — ${style.desc}.`,
    'Avalie o quanto a imagem cumpre o PEDIDO e adere ao ESTILO; seja crítico e específico.',
    `Dê uma nota de 0 a 10 (aprovado = nota >= ${threshold}).`,
    'Responda APENAS com JSON no schema {aprovado, nota, alinhamento, problemas, sugestao_melhoria, prompt_sugerido}, onde: ' +
      'aprovado (booleano), nota (0–10), alinhamento (string), problemas (array de strings), ' +
      'sugestao_melhoria (uma única instrução acionável), prompt_sugerido (prompt completo reescrito, pronto para regenerar).',
  ];
  if (strict) parts.push('IMPORTANTE: responda somente com o objeto JSON, sem texto ao redor.');
  return parts.join(' ');
}

export function fallback(raw: string): Verdict {
  return {
    aprovado: false,
    nota: null,
    alinhamento: '(veredito ilegível)',
    problemas: ['juiz não retornou JSON'],
    sugestao_melhoria: '',
    prompt_sugerido: '',
    raw,
  };
}

export function coerce(parsed: any, raw: string, threshold: number): Verdict {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback(raw);

  let nota: number | null = null;
  const n = Number(parsed.nota);
  if (Number.isFinite(n)) nota = Math.max(0, Math.min(10, n));

  const aprovado =
    typeof parsed.aprovado === 'boolean' ? parsed.aprovado : nota != null && nota >= threshold;

  const problemas = Array.isArray(parsed.problemas)
    ? parsed.problemas.map((p: any) => String(p))
    : parsed.problemas != null
      ? [String(parsed.problemas)]
      : [];

  return {
    aprovado,
    nota,
    alinhamento: parsed.alinhamento != null ? String(parsed.alinhamento) : '',
    problemas,
    sugestao_melhoria: parsed.sugestao_melhoria != null ? String(parsed.sugestao_melhoria) : '',
    prompt_sugerido: parsed.prompt_sugerido != null ? String(parsed.prompt_sugerido) : '',
    raw,
  };
}

export async function judge(
  pngPath: string,
  request: string,
  style: { nome: string; desc: string },
  model: string,
  approveThreshold?: number,
  signal?: AbortSignal,
): Promise<Verdict> {
  const threshold = approveThreshold ?? loadSettings().approveThreshold;
  const b64 = fs.readFileSync(pngPath).toString('base64');
  // Detecta o media_type real em vez de confiar na extensão do arquivo.
  const { mime } = detectImageFormat(pngPath);
  const imgBlock: ClaudeBlock = {
    type: 'image',
    source: { type: 'base64', media_type: mime, data: b64 },
  };

  let text = await askClaudeVision([{ type: 'text', text: buildRubric(request, style, threshold, false) }, imgBlock], model, signal);
  let parsed = extractJson(text);

  if (parsed == null) {
    // retry 1× reforçando "só JSON"
    text = await askClaudeVision([{ type: 'text', text: buildRubric(request, style, threshold, true) }, imgBlock], model, signal);
    parsed = extractJson(text);
  }

  return coerce(parsed, text, threshold);
}
