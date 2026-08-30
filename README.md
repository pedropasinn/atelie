# Ateliê

Esteira interativa (TUI) de geração de imagens de qualidade com **GPT Image 2**, orquestrada pela
**Codex CLI** (auth do ChatGPT, sem `OPENAI_API_KEY`), com um **juiz Claude multimodal** que vê cada
imagem e um **loop de melhoria** guiado por você.

Consolida as técnicas dos 4 projetos em `../` (garden-skills, GPT-Image2-Skill, gpt-image-2-skill,
awesome-gpt-image) numa galeria de **29 estilos fixos** com templates de prompt prontos.

## Fluxo
1. Você digita o pedido em linguagem natural.
2. Escolhe um ou mais **estilos** da galeria (multi-seleção).
3. Escolhe **N** versões (distribuídas entre os estilos escolhidos em round-robin).
4. As imagens são geradas via Codex (`gpt-image-2`), com progresso ao vivo.
5. O **juiz Claude** vê cada PNG e devolve um veredito: nota, alinhamento, problemas, uma
   `sugestão de melhoria` e um `prompt reescrito`.
6. Você decide se quer melhorar. Se sim, o prompt é recomposto (mantendo o sujeito-âncora) e a
   imagem passa de novo pelo caminho de geração + validação. Loop.

## Instalar (usuário final)

Baixe o instalador da [página de releases](https://github.com/pedropasinn/atelie/releases)
— `Atelie-Setup-<versão>.exe` no Windows — e execute. **Não é preciso instalar Node,
Codex CLI nem nada antes**: o app já vem com o motor de geração e o componente de login.

Na primeira abertura, o Ateliê pede para conectar a conta **ChatGPT**: ele mostra um
código curto e um link; você confirma no navegador e pronto. É a única credencial
obrigatória — é ela que habilita tanto gerar quanto avaliar as imagens.

> O Windows pode exibir um aviso do SmartScreen ("aplicativo não reconhecido"), porque o
> instalador não tem assinatura digital paga. Clique em **Mais informações → Executar assim
> mesmo**.

O **Claude Code** é opcional e só entra em dois recursos: criar estilos novos e o cânone de
série. Sem ele o app gera, avalia e melhora imagens normalmente.

## Requisitos (desenvolvimento)
- `node >= 20`, deps instaladas (`npm install`).
- Login ChatGPT ativo (`~/.codex/auth.json`). Teste: `npm start -- --doctor`.
- O wrapper `gpt-image-2-skill` e o Codex CLI vêm como dependências npm — nada de
  instalação manual.
- `claude` CLI na PATH apenas para o juiz Claude e o `--add-style`.

## Uso
```bash
npm start                 # abre a TUI (precisa de um terminal real — usa raw mode)
```

## Integração

O Ateliê 0.2.1 também é um motor sem UI, consumível por HTTP ou in-process:

```bash
atelie --serve --port 4177
atelie --brief brief.json --json
```

```ts
import { criarCliente, criarMotor } from 'atelie/sdk';

const client = criarCliente({ baseUrl: 'http://127.0.0.1:4177' });
const motor = criarMotor();
```

A API estável oferece `POST /v1/jobs`, consulta de estado/progresso, catálogo de
estilos, health, cancelamento e download dos PNGs. O mesmo `brief_hash` devolve o
mesmo job. Cada artefato recebe um `manifest.json` com prompt final, provedor/modelo,
parâmetros, histórico dos juízes, SHA-256 e métricas disponíveis.

O brief tem dois modos: `explicacao`, para infográficos com no máximo 12 strings
curtas; e `cena`, para imagens sem texto destinadas
a peças. Em `explicacao`, `texto_fora_da_imagem: true` também gera raster sem texto
e devolve rótulos para overlay HTML/SVG. A qualidade padrão é `medium`.

No motor de brief estruturado, o julgamento ocorre em duas etapas. Primeiro, o VLM
apenas transcreve todo o texto visível como `{textos: string[]}`. O código compara essa
transcrição com a allowlist `stringsVisiveis`; rótulo ausente, texto não autorizado ou
ordem obrigatória divergente vetam a tentativa. Em `cena` e com
`texto_fora_da_imagem: true`, qualquer texto transcrito causa veto. O juiz visual só
roda depois desse aceite e avalia composição, clareza semântica e legibilidade. Sua
nota nunca compensa um veto de conteúdo.

`texto_extra_permitido: true` desliga apenas o veto de extras em `explicacao`; o default
é `false`. `ordem_obrigatoria: true` em uma seção exige que seus itens apareçam na
ordem declarada. `largura_final_px` informa a largura real de exibição para o juiz
visual reprovar texto que ficaria abaixo de aproximadamente 12 px. O manifesto grava
`largura_final_px` em `parametros` e, em cada tentativa, os campos aditivos `conteudo`
e `visual`; `visual` vale `null` quando o conteúdo impede sua execução.

Contratos e exemplos:

- [API HTTP v1](docs/API-V1.md)
- [Integração AgentHub](docs/INTEGRACAO-AGENTHUB.md)
- [Integração Macrostudio](docs/INTEGRACAO-MACROSTUDIO.md)
- `examples/agenthub-explicacao.ts` e `examples/macrostudio-adapter.ts`

### Subcomandos de debug (não-interativos)
```bash
npm start -- --doctor
npm start -- --gen-one --style fotorrealista --prompt "um gato de óculos lendo jornal" [--quality low|medium|high]
npm start -- --judge-file <png> --request "um gato de óculos lendo jornal" [--style fotorrealista] [--model sonnet]
```

## Configuração (env)
| Var | Default | Efeito |
|---|---|---|
| `ATELIE_HOME` | `~/.atelie` | raiz de sessões/saídas |
| `ATELIE_JUDGE_MODEL` | `sonnet` | modelo do juiz (visão) |
| `ATELIE_CONCURRENCY` | `0` | jobs de geração em paralelo (`0` = todos de uma vez) |
| `ATELIE_JOB_CONCURRENCY` | `1` | jobs simultâneos na fila HTTP v1 |
| `ATELIE_JOB_TRANSIENT_RETRIES` | `2` | retries automáticos após falha transitória |
| `ATELIE_JOB_RETRY_DELAY_MS` | `250` | intervalo base crescente entre retries |
| `ATELIE_FAILED_JOB_TTL_MS` | `3600000` | TTL de `failed` na idempotência |
| `ATELIE_IMAGE_PRICE_TABLE_JSON` | tabela interna | preços por qualidade/orientação usados só como estimativa |
| `ATELIE_TOKEN` | vazio | token Bearer literal ou `@arquivo` 0600 para `/v1/*`, `/api/*` e WebSocket |
| `ATELIE_TOKEN_FILE` | vazio | caminho explícito de arquivo de token 0600 |
| `ATELIE_AUTO_OPEN` | `1` | abre a pasta publicada ao fim de cada geração (`0` desliga; na CLI, `--no-open`) |

## Saídas
Cada sessão vive em `~/.atelie/sessions/<id>/`:
- `manifest.jsonl` — log append-only (`session_start`/`generate`/`verdict`/`iterate`/`session_end`)
- `session.json` — snapshot para `--resume <id>`
- `iter-NN/<estilo>-<i>.png` — as imagens

## Estilos
29 estilos em `src/styles/catalog.ts` (procedência em `src/styles/PROVENANCE.md`). Cada um tem um
`template` com `{subject}/{scene}/{extra}` e defaults (tamanho/qualidade/aspecto/fundo). Propriedades
de saída (tamanho/fundo/formato) vão sempre em **flags**, nunca no texto do prompt.

## App Desktop

O mesmo motor roda como app desktop (Electron), com a UI web servida em
`127.0.0.1` numa porta efêmera. O processo main do Electron sobe o servidor Fastify
in-process — sem `OPENAI_API_KEY`, a geração continua via CLIs do usuário.

### Rodar em dev
```bash
npm run desktop:dev   # ui:build → desktop:build (esbuild) → electron .
```
Isso compila a UI (`ui/dist`), bundla `src/desktop/*` + servidor + motor para
`dist-electron/main.cjs` e `preload.cjs`, e abre a janela.

Para iterar só no bundle:
```bash
npm run ui:build       # compila a UI
npm run desktop:build  # (re)gera dist-electron/*.cjs
```

### Empacotar (instaladores)
```bash
npm run dist   # ui:build → desktop:build → electron-builder
```
Gera em `release/`: **Windows** NSIS (`.exe`), **macOS** DMG, **Linux** AppImage
(conforme o SO do build). Config em `electron-builder.yml`.

Releases multiplataforma saem via CI: `git tag vX.Y.Z && git push --tags` dispara
`.github/workflows/release.yml`, que builda em Win/Mac/Linux e publica no GitHub
Releases (feed do `electron-updater`). Em produção o app checa update no start
(`checkForUpdatesAndNotify`, no-op enquanto não há release publicada).

### O que vai dentro do pacote
`extraResources` (em `electron-builder.yml`) embute dois binários nativos, por plataforma:

| Recurso | Caminho no pacote | Para quê |
|---|---|---|
| wrapper `gpt-image-2-skill` | `resources/wrapper/node_modules/…` | gerar e julgar imagens |
| `codex` | `resources/codex/bin/codex[.exe]` | **só** o login ChatGPT do wizard |

Ambos vêm de dependências npm com binário por SO/arch, então o CI monta o pacote certo
em cada runner. `src/config.ts` e `src/lib/codexCli.ts` procuram primeiro esses caminhos
sob `process.resourcesPath` e caem para o `node_modules` local em dev. Do Codex CLI
excluímos o `codex-code-mode-host` (~46 MB), que o Ateliê nunca chama.

O `claude` continua sendo BYO: carrega o login do usuário e não faz sentido embutir. Se
não estiver instalado, o servidor o desliga sozinho no boot (`desligarClisAusentes`), e o
painel de juízes roda só com o Codex.

Em produção não há `node` garantido na PATH: o main seta `ATELIE_NODE_BIN` para o
próprio binário do Electron (`process.execPath`) e o motor spawna o wrapper com
`ELECTRON_RUN_AS_NODE=1` (ver `src/lib/nodeBin.ts`). Em dev, sem essa env, usa `node`.

## Notas técnicas (contrato verificado)
Ver `BUILD_CONTRACT.md`. Pontos que importam:
- `--provider codex` é flag **global** (antes do subcomando `images generate`).
- Sob Codex, `--size` continua sendo uma **dica do provedor** (pode não ser honrada exatamente) e `--n` não existe → N versões = N chamadas. No motor de brief, as dimensões reais são verificadas após cada geração: com `proporcao_estrita: true`, divergências reprovam e acionam nova tentativa; com `false`, ficam registradas como aviso no veredito e na proveniência. O default é estrito em `explicacao` e flexível em `cena`.
- Transparência (sticker/logo) usa o subcomando `transparent generate`.
- O juiz costuma duplicar o texto de saída; o parser (`lib/jsonx.ts`) extrai o primeiro `{...}` balanceado.
