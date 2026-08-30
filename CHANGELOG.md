# Changelog

## 0.2.3 — 2026-08-30

- trilha de **componente** (`modo: "componente"`): geração de objeto único em fundo liso (chroma `#00FF41` por
  padrão), remoção de fundo por `scripts/remover_fundo.py` (motores `rembg` isnet-general-use, `cor-solida`
  determinístico e `nenhum` para alpha nativo), validação determinística (alpha, borda transparente, margem,
  componentes conexos em 8-conectividade, halo fora da faixa antialias, objeto da cor do fundo, objeto pequeno
  demais) e juízes de conteúdo/visual sobre composição xadrez; original preservado, artefato final com alpha;
  `fundo` no recibo; remoção obrigatória indisponível ou reprovada nunca entrega o original como `artifact.png`;
- bridge Node → Python com resolução de script (`ATELIE_FUNDO_SCRIPT`, `resourcesPath`, repo), timeout
  `ATELIE_FUNDO_TIMEOUT_MS` (120 s), ambiente mínimo, fail-closed; script incluído em `extraResources`;
- runtime Python via `ATELIE_FUNDO_PYTHON` ou `.venv-fundo/` (rembg 2.0.81); ~2–5 s por imagem na CPU após o
  primeiro carregamento do modelo (download único de 179 MB).

## 0.2.2 — 2026-08-30

- verifica a proporção real do PNG contra o tamanho pedido (`verificarProporcao`); `proporcao_estrita` (padrão em explicações)
  reprova e itera com `FORMATO OBRIGATÓRIO`; em cenas só avisa; recibo grava `tamanho_solicitado` e `proporcao`;
- separa o juiz de conteúdo do juiz visual: o VLM apenas transcreve o texto visível e `compararConteudo` decide em código
  (rótulo ausente, texto extra não autorizado, ordem obrigatória, texto em cena) com veto que a nota visual não compensa;
- `texto_extra_permitido`, `largura_final_px` (legibilidade no tamanho de inserção) e `ordem_obrigatoria` no brief;
- recibo de proveniência ganha `conteudo` e `visual` por tentativa (campos aditivos);
- a normalização adiciona defaults ao JSON canônico; por isso o `brief_hash` e a chave de idempotência diferem dos gerados por 0.2.1;
- motivação: benchmark externo de 30/08 (fig1/fig3 saíram 1024×1536 com `--size landscape`; texto inventado em 3 de 6 figuras).

## 0.2.1 — 2026-08-29

- corrige idempotência de jobs falhos com retry transitório configurável, `retry`,
  `force` e expiração por TTL;
- canonicaliza `estilo`/`estilos`, valida estilos antes da fila e recusa provedores
  desconhecidos sem fallback silencioso;
- completa a proveniência com versão, dimensões PNG reais, duração por tentativa e
  custo estimado por tabela configurável;
- protege `/api/*` e `/api/ws` com o mesmo token da API v1 e tolera DELETE JSON vazio;
- adiciona `texto_fora_da_imagem` e `rotulos_overlay` para composição determinística
  de texto em HTML/SVG;
- corrige as proporções do adapter Macrostudio e inclui `examples/` no typecheck.

## 0.2.0 — 2026-08-29

- adiciona motor in-process e SDK TypeScript exportado por `atelie/sdk`;
- adiciona API HTTP v1 com jobs persistentes, idempotência, fila, cancelamento e token local opcional;
- adiciona brief estruturado para explicações e cenas, composição com rótulos controlados e juiz de legibilidade;
- adiciona recibos `atelie.provenance/v1` com SHA-256, prompts, parâmetros, vereditos e métricas;
- adiciona `--brief` e `--serve --port`, preservando `--run` e as rotas desktop;
- documenta integrações propostas com AgentHub e Macrostudio.
