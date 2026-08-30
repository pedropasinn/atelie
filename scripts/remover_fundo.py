#!/usr/bin/env python3
"""Remove e valida fundo de componentes raster, emitindo um resultado JSON auditável."""

from __future__ import annotations

import argparse
import io
import json
import math
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

try:
    from scipy import ndimage
except ImportError:  # fallback funcional para instalações mínimas
    ndimage = None


def argumentos() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Remove e valida fundo de um PNG.")
    parser.add_argument("--entrada", required=True)
    parser.add_argument("--saida", required=True)
    parser.add_argument("--motor", choices=("rembg", "cor-solida", "nenhum"), default="rembg")
    parser.add_argument("--modelo", default="isnet-general-use")
    parser.add_argument("--composicao")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--tolerancia-cor", type=float, default=30.0)
    parser.add_argument("--fracao-transparente-min", type=float, default=0.10)
    parser.add_argument("--fracao-transparente-max", type=float, default=0.95)
    parser.add_argument("--borda-transparente-min", type=float, default=0.95)
    parser.add_argument("--margem-minima-pct-min", type=float, default=1.5)
    parser.add_argument("--fracao-maior-componente-min", type=float, default=0.85)
    parser.add_argument("--halo-max", type=float, default=0.05)
    return parser.parse_args()


def flood_fundo(rgb: np.ndarray, tolerancia: float) -> np.ndarray:
    altura, largura, _ = rgb.shape
    anel_y = max(1, int(math.ceil(altura * 0.02)))
    anel_x = max(1, int(math.ceil(largura * 0.02)))
    borda = np.concatenate((
        rgb[:anel_y].reshape(-1, 3), rgb[-anel_y:].reshape(-1, 3),
        rgb[:, :anel_x].reshape(-1, 3), rgb[:, -anel_x:].reshape(-1, 3),
    )).astype(np.float32)
    cor = np.median(borda, axis=0)
    distancia_quadrada = np.zeros((altura, largura), dtype=np.float32)
    for canal in range(3):
        delta = rgb[:, :, canal].astype(np.float32)
        delta -= cor[canal]
        np.square(delta, out=delta)
        distancia_quadrada += delta
    candidato = distancia_quadrada <= tolerancia * tolerancia
    sementes = np.zeros((altura, largura), dtype=bool)
    sementes[0] = candidato[0]
    sementes[-1] = candidato[-1]
    sementes[:, 0] = candidato[:, 0]
    sementes[:, -1] = candidato[:, -1]
    if ndimage is not None:
        estrutura = np.array(((0, 1, 0), (1, 1, 1), (0, 1, 0)), dtype=bool)
        fundo = ndimage.binary_propagation(sementes, structure=estrutura, mask=candidato)
    else:
        fundo = sementes.copy()
        plano_candidato = candidato.ravel()
        plano_fundo = fundo.ravel()
        fila: deque[int] = deque(np.flatnonzero(plano_fundo).tolist())
        while fila:
            indice = fila.popleft()
            y, x = divmod(indice, largura)
            for vizinho in (indice - largura if y else -1, indice + largura if y + 1 < altura else -1,
                            indice - 1 if x else -1, indice + 1 if x + 1 < largura else -1):
                if vizinho >= 0 and plano_candidato[vizinho] and not plano_fundo[vizinho]:
                    plano_fundo[vizinho] = True
                    fila.append(vizinho)
    return fundo


def remover(imagem: Image.Image, motor: str, modelo: str, tolerancia: float) -> tuple[Image.Image, bool, dict[str, np.ndarray] | None]:
    tinha_alpha = "A" in imagem.getbands() or "transparency" in imagem.info
    if motor == "nenhum":
        return imagem.convert("RGBA") if tinha_alpha else imagem.copy(), tinha_alpha, None
    if motor == "cor-solida":
        rgba = imagem.convert("RGBA")
        dados = np.asarray(rgba).copy()
        fundo = flood_fundo(dados[:, :, :3], tolerancia)
        dados[fundo, 3] = 0
        return Image.fromarray(dados, "RGBA"), True, {"fundo": fundo}

    from rembg import new_session, remove as rembg_remove

    entrada = io.BytesIO()
    imagem.save(entrada, format="PNG")
    saida = rembg_remove(entrada.getvalue(), session=new_session(modelo))
    return Image.open(io.BytesIO(saida)).convert("RGBA"), True, None


def componentes(mascara: np.ndarray) -> list[int]:
    altura, largura = mascara.shape
    if ndimage is not None:
        rotulos, quantidade = ndimage.label(mascara, structure=np.ones((3, 3), dtype=np.uint8))
        if not quantidade:
            return []
        return np.bincount(rotulos.ravel(), minlength=quantidade + 1)[1:].astype(int).tolist()
    visitado = np.zeros_like(mascara, dtype=bool)
    tamanhos: list[int] = []
    for y0, x0 in np.argwhere(mascara):
        if visitado[y0, x0]:
            continue
        total = 0
        fila = [(int(y0), int(x0))]
        visitado[y0, x0] = True
        while fila:
            y, x = fila.pop()
            total += 1
            for ny, nx in ((y + dy, x + dx) for dy in (-1, 0, 1) for dx in (-1, 0, 1) if dy or dx):
                if 0 <= ny < altura and 0 <= nx < largura and mascara[ny, nx] and not visitado[ny, nx]:
                    visitado[ny, nx] = True
                    fila.append((ny, nx))
        tamanhos.append(total)
    return tamanhos


def dilatar(mascara: np.ndarray, raio: int) -> np.ndarray:
    """Dilata uma máscara pelo raio em pixels, incluindo diagonais."""
    if raio <= 0:
        return mascara.copy()
    altura, largura = mascara.shape
    acolchoada = np.pad(mascara, raio, mode="constant", constant_values=False)
    resultado = np.zeros_like(mascara)
    for dy in range(-raio, raio + 1):
        for dx in range(-raio, raio + 1):
            resultado |= acolchoada[
                raio + dy:raio + dy + altura,
                raio + dx:raio + dx + largura,
            ]
    return resultado


def fecho_convexo(mascara: np.ndarray) -> np.ndarray:
    """Máscara do fecho convexo; bbox erodida é o fallback sem scipy.ndimage."""
    altura, largura = mascara.shape
    if not mascara.any():
        return np.zeros_like(mascara)
    if ndimage is not None:
        contorno = mascara & ~ndimage.binary_erosion(mascara, structure=np.ones((3, 3), dtype=bool))
        pontos = np.argwhere(contorno)
        if len(pontos) >= 3:
            if len(pontos) > 20_000:
                pontos = pontos[::math.ceil(len(pontos) / 20_000)]
            try:
                ordenados = sorted((int(x), int(y)) for y, x in pontos)
                def cruz(o: tuple[int, int], a: tuple[int, int], b: tuple[int, int]) -> int:
                    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
                inferior: list[tuple[int, int]] = []
                superior: list[tuple[int, int]] = []
                for ponto in ordenados:
                    while len(inferior) >= 2 and cruz(inferior[-2], inferior[-1], ponto) <= 0:
                        inferior.pop()
                    inferior.append(ponto)
                for ponto in reversed(ordenados):
                    while len(superior) >= 2 and cruz(superior[-2], superior[-1], ponto) <= 0:
                        superior.pop()
                    superior.append(ponto)
                vertices = inferior[:-1] + superior[:-1]
                pil = Image.new("1", (largura, altura), 0)
                ImageDraw.Draw(pil).polygon(vertices, fill=1)
                return np.asarray(pil, dtype=bool)
            except Exception:
                pass
    linhas = np.flatnonzero(mascara.any(axis=1))
    colunas = np.flatnonzero(mascara.any(axis=0))
    resultado = np.zeros_like(mascara)
    erosao = max(1, int(round(min(altura, largura) * 0.02)))
    topo, base = int(linhas[0]) + erosao, int(linhas[-1]) - erosao
    esquerda, direita = int(colunas[0]) + erosao, int(colunas[-1]) - erosao
    if topo <= base and esquerda <= direita:
        resultado[topo:base + 1, esquerda:direita + 1] = True
    return resultado


def metricas_alpha(imagem: Image.Image, tinha_alpha: bool, contexto_cor: dict[str, np.ndarray] | None = None) -> dict[str, object]:
    rgba = np.asarray(imagem.convert("RGBA"))
    alpha = rgba[:, :, 3]
    altura, largura = alpha.shape
    total = altura * largura
    transparente = alpha < 10
    opaco = alpha >= 245
    semi = (alpha >= 10) & (alpha < 245)
    anel_y = max(1, int(math.ceil(altura * 0.02)))
    anel_x = max(1, int(math.ceil(largura * 0.02)))
    mascara_anel = np.zeros_like(transparente)
    mascara_anel[:anel_y] = True
    mascara_anel[-anel_y:] = True
    mascara_anel[:, :anel_x] = True
    mascara_anel[:, -anel_x:] = True
    objeto = alpha >= 10
    bbox: dict[str, int] | None = None
    margem = 0.0
    linhas = np.flatnonzero(objeto.any(axis=1))
    colunas = np.flatnonzero(objeto.any(axis=0))
    if len(linhas) and len(colunas):
        topo, base = int(linhas[0]), int(linhas[-1])
        esquerda, direita = int(colunas[0]), int(colunas[-1])
        bbox = {
            "x": int(esquerda), "y": int(topo),
            "largura": int(direita - esquerda + 1), "altura": int(base - topo + 1),
        }
        margem = min(
            esquerda / largura, topo / altura,
            (largura - 1 - direita) / largura, (altura - 1 - base) / altura,
        ) * 100.0

    area_objeto = int(objeto.sum())
    limiar_componente = max(1, int(math.ceil(area_objeto * 0.005)))
    tamanhos = [n for n in componentes(objeto) if n >= limiar_componente]
    soma_componentes = sum(tamanhos)
    fracao_maior = max(tamanhos, default=0) / soma_componentes if soma_componentes else 0.0

    faixa_antialias_px = 2
    faixa_antialias = dilatar(opaco, faixa_antialias_px)
    semi_fora_da_faixa = semi & ~faixa_antialias
    halo = float(semi_fora_da_faixa.sum() / area_objeto) if area_objeto else 0.0
    fracao_cor_fundo = 0.0
    if contexto_cor is not None and area_objeto:
        removidos_suspeitos = contexto_cor["fundo"] & transparente & fecho_convexo(objeto)
        fracao_cor_fundo = float(removidos_suspeitos.sum() / area_objeto)
    return {
        "tem_alpha": tinha_alpha,
        "fracao_transparente": float(transparente.sum() / total),
        "fracao_opaca": float(opaco.sum() / total),
        "fracao_semitransparente": float(semi.sum() / total),
        "borda_transparente": float((transparente & mascara_anel).sum() / mascara_anel.sum()),
        "bbox": bbox,
        "margem_minima_pct": float(margem),
        "componentes_conexos": len(tamanhos),
        "fracao_maior_componente": float(fracao_maior),
        "fracao_objeto_cor_de_fundo": fracao_cor_fundo,
        "faixa_antialias_px": faixa_antialias_px,
        "fracao_semitransparente_fora_da_faixa": halo,
        "halo": halo,
    }


def validar(m: dict[str, object], args: argparse.Namespace) -> list[str]:
    problemas: list[str] = []
    if not m["tem_alpha"]:
        problemas.append("sem alpha")
    ft = float(m["fracao_transparente"])
    if ft < args.fracao_transparente_min:
        problemas.append(
            f"fração transparente {ft * 100:.1f}% abaixo de {args.fracao_transparente_min * 100:.1f}%"
        )
    elif ft > args.fracao_transparente_max:
        problemas.append(f"objeto pequeno demais: ocupa {(1.0 - ft) * 100:.1f}% — aumente o objeto")
    borda = float(m["borda_transparente"])
    if borda < args.borda_transparente_min:
        problemas.append(f"fundo residual: borda {borda * 100:.1f}% transparente")
    margem = float(m["margem_minima_pct"])
    if margem < args.margem_minima_pct_min:
        problemas.append(f"objeto cortado: margem {margem:.1f}%")
    maior = float(m["fracao_maior_componente"])
    if maior < args.fracao_maior_componente_min:
        problemas.append(f"fragmentos/resíduos: maior componente {maior * 100:.1f}%")
    halo = float(m["halo"])
    if halo > args.halo_max:
        problemas.append(f"halo excessivo: {halo * 100:.1f}% da área do objeto")
    fracao_cor_fundo = float(m["fracao_objeto_cor_de_fundo"])
    if args.motor == "cor-solida" and fracao_cor_fundo > 0.03:
        problemas.append("objeto contém a cor do fundo; use motor rembg ou outra cor de fundo de geração")
    return problemas


def compor_xadrez(imagem: Image.Image, destino: Path) -> None:
    rgba = imagem.convert("RGBA")
    largura, altura = rgba.size
    bloco = max(8, int(round(min(largura, altura) / 24)))
    yy = np.arange(altura, dtype=np.uint16)[:, None]
    xx = np.arange(largura, dtype=np.uint16)[None, :]
    casas = ((xx // bloco) + (yy // bloco)) & 1
    cinza = np.where(casas[..., None] == 0, 224, 176).astype(np.uint8)
    fundo = np.repeat(cinza, 3, axis=2)
    alpha = np.asarray(rgba)[:, :, 3:4].astype(np.float32) / 255.0
    rgb = np.asarray(rgba)[:, :, :3].astype(np.float32)
    composto = (rgb * alpha + fundo * (1.0 - alpha)).round().astype(np.uint8)
    destino.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(composto, "RGB").save(destino, format="PNG")


def main() -> int:
    args = argumentos()
    try:
        entrada = Image.open(args.entrada)
        saida, tinha_alpha, contexto_cor = remover(entrada, args.motor, args.modelo, args.tolerancia_cor)
        destino = Path(args.saida)
        destino.parent.mkdir(parents=True, exist_ok=True)
        saida.save(destino, format="PNG")
        metricas = metricas_alpha(saida, tinha_alpha, contexto_cor)
        problemas = validar(metricas, args)
        if args.composicao:
            compor_xadrez(saida, Path(args.composicao))
        resultado = {
            "ok": not problemas,
            "motor": args.motor,
            "modelo": args.modelo,
            "metricas": {k: v for k, v in metricas.items() if k != "tem_alpha"},
            "problemas": problemas,
        }
        if args.json:
            print(json.dumps(resultado, ensure_ascii=False, separators=(",", ":")))
        else:
            print("aprovado" if resultado["ok"] else "; ".join(problemas))
        return 0
    except Exception as exc:  # erro operacional; validações normais continuam com exit 0
        resultado = {"ok": False, "motor": args.motor, "modelo": args.modelo, "metricas": None, "problemas": [str(exc)]}
        if args.json:
            print(json.dumps(resultado, ensure_ascii=False, separators=(",", ":")))
        else:
            print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
