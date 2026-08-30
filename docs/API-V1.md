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
  "secoes": [{ "rotulo": "PEDIDO", "itens": ["limites", "testes", "risco"] }],
  "legendas_curtas": true,
  "idioma": "pt-BR",
  "tamanho": "2K",
  "proporcao_estrita": true,
  "qualidade": "medium",
  "negativos": ["marca-d’água"],
  "refs": [],
  "paleta": { "acento": "#00F0FF", "tinta": "#002060" },
  "iteracoes": 1
}
```

- `modo`: `explicacao` produz infográfico com texto controlado; `cena` proíbe texto.
- `provedor`: opcional, aceita somente `codex`. Qualquer outro id recebe `400
  invalid_brief`; não existe normalização silenciosa.
- `estilo` ou `estilos` é obrigatório. Um artefato final é produzido por estilo.
  As duas formas são canonicalizadas para uma lista ordenada e deduplicada antes
  do `brief_hash`.
- `texto_fora_da_imagem: true` só atua em `explicacao`: pede uma camada visual sem
  texto, aplica o gate de zero texto e devolve `rotulos_overlay` no manifest.
- `iteracoes` é o número de novas tentativas depois da primeira geração.
- `proporcao_estrita` controla o gate das dimensões reais: o default é `true` em
  `explicacao` e `false` em `cena`. Aliases comparam orientação; `WxH` compara a
  razão largura/altura com tolerância relativa de 5%; `2K` e valores sem proporção
  explícita não impõem geometria. Uma divergência estrita reprova a tentativa e
  acrescenta uma instrução obrigatória de formato à próxima geração.
- `qualidade` assume `medium`, que é a política econômica das integrações.
- Em `explicacao`, entram no máximo 12 strings visíveis, cada uma com até 42
  caracteres. Conteúdo excedente vira conceito visual, não microtexto.
- Rótulos entram entre aspas e o juiz reprova ilegibilidade, pseudotexto, ortografia
  ou acentuação incorreta. Em `cena`, qualquer texto reprova.

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
sem aceitar caminho fornecido pelo cliente.

### `GET /v1/styles`

Lista catálogo, defaults e modos aceitos.

### `GET /v1/health`

Health leve, sem sondar CLIs nem consumir tokens.

## Recibo de proveniência

Cada pasta `artifact-NNN/` contém `artifact.png`, tentativas e `manifest.json` no
schema `atelie.provenance/v1`: versão do Ateliê, prompt final, estilo,
provedor/modelo reais, parâmetros, rótulos de overlay, histórico de vereditos com
duração de geração/julgamento, SHA-256, bytes e dimensões lidas do IHDR do PNG.
O recibo também traz `tamanho_solicitado` e `proporcao` na raiz. Cada item de
`vereditos` repete o resultado `proporcao` da tentativa; divergências flexíveis
aparecem em `avisos`, enquanto divergências estritas aparecem em `problemas` e
deixam `aprovado: false`.
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
