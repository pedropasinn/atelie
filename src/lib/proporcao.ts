export type OrientacaoImagem = 'square' | 'portrait' | 'landscape';

export interface VerificacaoProporcao {
  ok: boolean;
  orientacao_pedida: OrientacaoImagem | null;
  orientacao_real: OrientacaoImagem;
  proporcao_pedida?: number;
  proporcao_real: number;
  motivo: string;
}

function orientacao(largura: number, altura: number): OrientacaoImagem {
  return largura === altura ? 'square' : largura > altura ? 'landscape' : 'portrait';
}

/**
 * Confere a orientação dos aliases e a razão largura/altura de tamanhos WxH.
 * Tamanhos sem proporção explícita (como 2K) são aceitos sem impor geometria.
 */
export function verificarProporcao(
  tamanhoPedido: string,
  dimensoes: { largura: number; altura: number },
  tolerancia = 0.05,
): VerificacaoProporcao {
  const tamanho = tamanhoPedido.trim().toLowerCase();
  const proporcaoReal = dimensoes.largura / dimensoes.altura;
  const orientacaoReal = orientacao(dimensoes.largura, dimensoes.altura);
  const aliases: Record<string, OrientacaoImagem> = {
    landscape: 'landscape',
    wide: 'landscape',
    portrait: 'portrait',
    square: 'square',
  };
  const orientacaoPedida = aliases[tamanho];

  if (orientacaoPedida) {
    const ok = orientacaoPedida === orientacaoReal;
    return {
      ok,
      orientacao_pedida: orientacaoPedida,
      orientacao_real: orientacaoReal,
      proporcao_real: proporcaoReal,
      motivo: ok ? 'orientação compatível' : 'orientação divergente',
    };
  }

  const match = /^(\d+)x(\d+)$/.exec(tamanho);
  if (match) {
    const larguraPedida = Number(match[1]);
    const alturaPedida = Number(match[2]);
    if (larguraPedida > 0 && alturaPedida > 0) {
      const proporcaoPedida = larguraPedida / alturaPedida;
      const limite = Number.isFinite(tolerancia) && tolerancia >= 0 ? tolerancia : 0.05;
      const desvioRelativo = Math.abs(proporcaoReal - proporcaoPedida) / proporcaoPedida;
      const ok = desvioRelativo <= limite;
      return {
        ok,
        orientacao_pedida: orientacao(larguraPedida, alturaPedida),
        orientacao_real: orientacaoReal,
        proporcao_pedida: proporcaoPedida,
        proporcao_real: proporcaoReal,
        motivo: ok ? 'proporção dentro da tolerância' : 'proporção fora da tolerância',
      };
    }
  }

  return {
    ok: true,
    orientacao_pedida: null,
    orientacao_real: orientacaoReal,
    proporcao_real: proporcaoReal,
    motivo: 'tamanho não impõe proporção',
  };
}
