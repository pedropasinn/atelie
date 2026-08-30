# API HTTP v1

A API v1 é a superfície estável para integrações. Ela convive com as rotas legadas
`/api/*` da interface desktop. O servidor escuta somente em `127.0.0.1`.

## Inicialização e segurança

```bash
atelie --serve --port 4177
# ou
npm run serve -- --port 4177
```

`ATELIE_JOB_CONCURRENCY` controla quantos jobs rodam ao mesmo tempo (padrão `1`).
Cada job ainda pode emitir progresso interno do provedor.

Falhas transitórias são repetidas automaticamente conforme
`ATELIE_JOB_TRANSIENT_RETRIES` (padrão `2`, além da primeira execução). O intervalo
base é `ATELIE_JOB_RETRY_DELAY_MS` (padrão `250`) e cresce por tentativa. Jobs
`failed` deixam de bloquear o hash após `ATELIE_FAILED_JOB_TTL_MS` (padrão
`3600000`, uma hora).

Autenticação é opcional. `ATELIE_TOKEN` pode conter o token literal ou
`@/caminho/para/token`. A alternativa explícita é `ATELIE_TOKEN_FILE`. Arquivos de
token precisam estar em modo `0600`; outra permissão impede a inicialização. Envie:

```http
Authorization: Bearer <token>
```

O health check `/v1/health` não exige token. Quando configurado, o mesmo token
protege todas as demais rotas `/v1/*`, as rotas legadas `/api/*` e o handshake de
`/api/ws`. O Electron injeta o Bearer no processo principal sem expor o token ao
renderer. Nenhuma resposta inclui token, chaves de API ou
credenciais das CLIs. O logger HTTP está desativado e mensagens de erro persistidas
passam por redação de padrões de credencial.

## Brief

```json
{
  "titulo": "A FÁBRICA DE CÓDIGO",
  "objetivo": "Mostrar cinco estações e a trilha auditável.",
  "modo": "explicacao",
  "provedor": "codex",
  "estilo": "infografico-bento",
  "texto_fora_da_imagem": true,
  "texto_extra_permitido": false,
  "largura_final_px": 800,
  "secoes": [{ "rotulo": "PEDIDO", "itens": ["limites", "testes", "risco"], "ordem_obrigatoria": true }],
  "legendas_curtas": true,
  "idioma": "pt-BR",
  "tamanho": "2K",
  "proporcao_estrita": true,
  "ortografia_estrita": true,
  "qualidade": "medium",
  "negativos": ["marca-d’água"],
  "refs": [],
  "paleta": { "acento": "#00F0FF", "tinta": "#002060" },
  "iteracoes": 1
}
```

- `modo`: `explicacao` produz infográfico com texto controlado; `cena` proíbe texto;
  `componente` gera um único logo, ícone, sticker ou elemento isolado e valida seu
  recorte antes dos juízes multimodais.
- `provedor`: opcional, aceita somente `codex`. Qualquer outro id recebe `400
  invalid_brief`; não existe normalização silenciosa.
- `estilo` ou `estilos` é obrigatório. Um artefato final é produzido por estilo.
  As duas formas são canonicalizadas para uma lista ordenada e deduplicada antes
  do `brief_hash`.
- `texto_fora_da_imagem: true` só atua em `explicacao`: pede uma camada visual sem
  texto, aplica o gate de zero texto e devolve `rotulos_overlay` no manifest.
- `texto_extra_permitido` desliga somente o veto a strings fora da allowlist; o
  default é `false`. Rótulos obrigatórios continuam sendo verificados.
- `largura_final_px` informa a largura real de exibição ao gate de legibilidade.
- `secoes[].ordem_obrigatoria: true` exige que os itens visíveis da seção apareçam
  na ordem declarada.
- `iteracoes` é o número de novas tentativas depois da primeira geração.
- `proporcao_estrita` controla o gate das dimensões reais: o default é `true` em
  `explicacao` e `false` em `cena`/`componente`. Aliases comparam orientação; `WxH` compara a
  razão largura/altura com tolerância relativa de 5%; `2K` e valores sem proporção
  explícita não impõem geometria. Uma divergência estrita reprova a tentativa e
  acrescenta uma instrução obrigatória de formato à próxima geração.
- `ortografia_estrita` reprova diferenças de letras ou acentos encontradas pelo
  juiz de conteúdo; o default é `true` em `explicacao`/`componente` e `false` em `cena`.
- `qualidade` assume `medium`, que é a política econômica das integrações.
- Em `explicacao`, entram no máximo 12 strings visíveis, cada uma com até 42
  caracteres. Conteúdo excedente vira conceito visual, não microtexto.
- Rótulos entram entre aspas e o juiz reprova ilegibilidade, pseudotexto, ortografia
  ou acentuação incorreta. Em `cena`, qualquer texto reprova.

Um componente pode ser pedido assim:

```json
{
  "titulo": "Marca da coruja",
  "objetivo": "Criar uma coruja geométrica azul",
  "modo": "componente",
  "estilo": "logo-icone",
  "texto_permitido": ["ATELIÊ"],
  "fundo_geracao": "#00FF41",
  "remover_fundo": "obrigatorio",
  "motor_fundo": "rembg",
  "modelo_fundo": "isnet-general-use",
  "limites_fundo": { "margem_minima_pct_min": 2.0, "halo_max": 0.06 },
  "secoes": [],
  "idioma": "pt-BR",
  "qualidade": "medium",
  "negativos": [],
  "refs": [],
  "iteracoes": 1
}
```

O prompt de `componente` exige objeto único, completo, centralizado, com margem,
fundo liso (`#00FF41` por default) e sem sombra projetada. Esse verde-chroma é
saturado, costuma ser renderizado de forma lisa pelo gpt-image-2 e é raro em logos;
o prompt proíbe essa cor no próprio objeto. `texto_permitido` é uma
allowlist: seus itens podem aparecer, mas texto fora dela reprova. `remover_fundo`
aceita `obrigatorio` (default), `opcional` ou `nao`; os motores são `rembg`
(default), `cor-solida` e `nenhum`. Se o estilo já usa `transparent generate`, o
alpha nativo é validado com `nenhum` antes da remoção configurada. Indisponibilidade
em modo obrigatório reprova; em modo opcional gera aviso e preserva o original.
Os limites opcionais correspondem às métricas documentadas no recibo.
`limites_fundo.tolerancia_cor` ajusta o motor `cor-solida`. Esse motor não pode
distinguir pixels do objeto idênticos ao fundo: `fracao_objeto_cor_de_fundo`
reprova remoções suspeitas acima de 3% da área do objeto dentro do fecho convexo,
mas regiões externas indistinguíveis ainda exigem outra cor ou o motor `rembg`.
Sem override, a tentativa exige fração transparente entre 10% e 95%, ao menos 95%
do anel externo transparente, margem mínima de 1,5%, maior componente com ao menos
85% da área relevante e halo de no máximo 5%. `halo` é a quantidade de pixels
semitransparentes (`10 <= alpha < 245`) fora da dilatação de 2 px dos pixels opacos
(`alpha >= 245`), dividida pela área do objeto (`alpha >= 10`). A borda antialias
normal dentro dessa faixa não é penalizada. Componentes menores que 0,5% da área
do objeto são ignorados no gate de fragmentos, com conectividade 8. Acima do teto
de transparência, o diagnóstico informa a ocupação do objeto e pede que ele cresça.

O subprocesso tem timeout de 120 s, configurável por `ATELIE_FUNDO_TIMEOUT_MS`.
O primeiro uso de `rembg` pode baixar o modelo; aumente o timeout ou pré-instale-o.
`ATELIE_FUNDO_SCRIPT` sobrescreve a resolução automática, que também procura em
`resources/fundo/remover_fundo.py`, na raiz do repo e no diretório atual.

Em medição local com CPU, o `rembg` `isnet-general-use` processou o fixture de logo
sintético de 1024×1024 em 4,513 s.

## Endpoints

### `POST /v1/jobs`

Recebe o brief como body. Retorna `202` ao criar e `200` quando o mesmo
`brief_hash` já existe. A idempotência sobrevive a reinícios porque `job.json` é
persistido em `$ATELIE_HOME/jobs/<id>/`.

Também aceita o envelope `{ "brief": {...}, "retry": true }` para criar nova
execução quando a anterior está `failed`/`cancelled`, ou `{ "brief": {...},
"force": true }` para ignorar qualquer estado anterior. `force` pode duplicar
custo. Sem essas flags, `queued`, `running` e `completed` são reutilizados; um
`failed` recente é reutilizado até o TTL e depois expira; `cancelled` não prende o
hash.

### `GET /v1/jobs/{id}`

Retorna `status` (`queued`, `running`, `completed`, `failed`, `cancelled`),
`progresso`, `resultado.artefatos`, `veredito` e erro saneado quando houver. Cada
artefato inclui seu recibo de proveniência.

### `DELETE /v1/jobs/{id}`

Cancela item enfileirado ou aborta geração/julgamento em curso. Jobs terminais são
idempotentes e permanecem inalterados. `Content-Type: application/json` com corpo
vazio é aceito.

### `GET /v1/jobs/{id}/artifact/{n}`

Entrega o PNG final; `n` começa em `1`. O arquivo é resolvido pelo registro do job,
sem aceitar caminho fornecido pelo cliente. Retorna `404` se uma remoção obrigatória
não produziu recorte e, portanto, não existe artefato final.

### `GET /v1/styles`

Lista catálogo, defaults e modos aceitos.

### `GET /v1/health`

Health leve, sem sondar CLIs nem consumir tokens.

## Recibo de proveniência

Cada pasta `artifact-NNN/` contém tentativas e `manifest.json` no
schema `atelie.provenance/v1`: versão do Ateliê, prompt final, estilo,
provedor/modelo reais, parâmetros, rótulos de overlay, histórico de vereditos com
duração de geração/julgamento, SHA-256, bytes e dimensões lidas do IHDR do PNG.
Quando há saída, também contém `artifact.png`, `artefato_final` aponta para ele e
`arquivo` traz seus dados. Se a remoção obrigatória não produzir recorte, ambos
valem `null`, `motivo_sem_artefato_final` explica a ausência e o original opaco
permanece somente como `tentativa-NN-original.png`.
Recibos gravados desde 0.2.2 trazem `tamanho_solicitado` e `proporcao` na raiz;
esses campos são opcionais na leitura porque recibos 0.2.1 em disco não os têm.
Cada item de `vereditos` repete o resultado `proporcao` da tentativa; divergências flexíveis
aparecem em `avisos`, enquanto divergências estritas aparecem em `problemas` e
deixam `aprovado: false`.
Cada tentativa 0.2.2 também pode trazer `conteudo` e `visual`. Em `conteudo`,
`transcricao` contém a lista bruta de todo texto visível que o VLM encontrou, além
de `faltantes`, `extras`, `numeracao`, `repeticoes`, `ortografia`, `ordem_incorreta`
e o juiz usado. `repeticoes` mapeia cada string permitida encontrada mais de uma vez
para sua quantidade total de ocorrências; repetições permitidas não entram em `extras`;
`visual` contém o parecer visual ou `null` quando houve veto textual. O objeto
`parametros` registra `texto_extra_permitido`, `largura_final_px`,
`proporcao_estrita` e `ortografia_estrita`.

Em `modo: "componente"`, cada tentativa e a raiz do manifesto do artefato trazem
`fundo: {solicitado,motor,modelo,removido,alpha_validado,metricas,problemas,arquivo_original_sha256}`.
`metricas` contém `fracao_transparente`, `fracao_opaca`,
`fracao_semitransparente`, `borda_transparente`, `bbox`, `margem_minima_pct`,
`componentes_conexos`, `fracao_maior_componente`, `fracao_objeto_cor_de_fundo`, `faixa_antialias_px`,
`fracao_semitransparente_fora_da_faixa` e `halo` (ou `null` quando o motor está
indisponível). `fracao_semitransparente_fora_da_faixa` e `halo` expressam a mesma
razão auditável definida acima. O PNG gerado fica como `tentativa-NN-original.png`; o recortado,
sua composição xadrez de inspeção e o `artifact.png` com alpha ficam ao lado.

Por consequência, `GET /v1/jobs/{id}` ecoa em
`resultado.artefatos[].manifest.vereditos[].conteudo.transcricao` todo texto visível
da imagem. Trate a resposta como potencialmente sensível e aplique o mesmo controle
de acesso usado para o PNG.
`metricas.custo_usd` é sempre preenchido junto de `custo_tipo` e `custo_fonte`.
No caminho Codex ele é uma **estimativa**, não faturamento observado. A tabela pode
ser substituída por `ATELIE_IMAGE_PRICE_TABLE_JSON`, por exemplo:

```json
{"low":{"square":0.004,"portrait":0.005,"landscape":0.005},"medium":{"square":0.032,"portrait":0.05,"landscape":0.05},"high":{"square":0.11,"portrait":0.165,"landscape":0.165}}
```

Os defaults são um proxy equivalente de API datado de 2026-08-29; a fonte oficial
mantida pela OpenAI é a [página de preços](https://developers.openai.com/api/docs/pricing).
Referências externas entram somente como basename e SHA-256, nunca como caminho
absoluto.
