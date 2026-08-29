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

Autenticação é opcional. `ATELIE_TOKEN` pode conter o token literal ou
`@/caminho/para/token`. A alternativa explícita é `ATELIE_TOKEN_FILE`. Arquivos de
token precisam estar em modo `0600`; outra permissão impede a inicialização. Envie:

```http
Authorization: Bearer <token>
```

O health check não exige token. Nenhuma resposta inclui token, chaves de API ou
credenciais das CLIs. O logger HTTP está desativado e mensagens de erro persistidas
passam por redação de padrões de credencial.

## Brief

```json
{
  "titulo": "A FÁBRICA DE CÓDIGO",
  "objetivo": "Mostrar cinco estações e a trilha auditável.",
  "modo": "explicacao",
  "estilo": "infografico-bento",
  "secoes": [{ "rotulo": "PEDIDO", "itens": ["limites", "testes", "risco"] }],
  "legendas_curtas": true,
  "idioma": "pt-BR",
  "tamanho": "2K",
  "qualidade": "medium",
  "negativos": ["marca-d’água"],
  "refs": [],
  "paleta": { "acento": "#00F0FF", "tinta": "#002060" },
  "iteracoes": 1
}
```

- `modo`: `explicacao` produz infográfico com texto controlado; `cena` proíbe texto.
- `estilo` ou `estilos` é obrigatório. Um artefato final é produzido por estilo.
- `iteracoes` é o número de novas tentativas depois da primeira geração.
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

### `GET /v1/jobs/{id}`

Retorna `status` (`queued`, `running`, `completed`, `failed`, `cancelled`),
`progresso`, `resultado.artefatos`, `veredito` e erro saneado quando houver. Cada
artefato inclui seu recibo de proveniência.

### `DELETE /v1/jobs/{id}`

Cancela item enfileirado ou aborta geração/julgamento em curso. Jobs terminais são
idempotentes e permanecem inalterados.

### `GET /v1/jobs/{id}/artifact/{n}`

Entrega o PNG final; `n` começa em `1`. O arquivo é resolvido pelo registro do job,
sem aceitar caminho fornecido pelo cliente.

### `GET /v1/styles`

Lista catálogo, defaults e modos aceitos.

### `GET /v1/health`

Health leve, sem sondar CLIs nem consumir tokens.

## Recibo de proveniência

Cada pasta `artifact-NNN/` contém `artifact.png`, tentativas e `manifest.json` no
schema `atelie.provenance/v1`: prompt final, estilo, provedor/modelo, parâmetros,
histórico de vereditos, SHA-256 e bytes do PNG, duração e custo quando o provedor o
informar. Referências externas entram somente como basename e SHA-256, nunca como
caminho absoluto.
