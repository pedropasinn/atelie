# Ateliê — uso via CLI (para o agente / linha de comando)

Comando global: **`atelie`** (`~/.local/bin/atelie` → roda `src/cli.tsx` via tsx). Funciona de qualquer diretório;
todos os caminhos são absolutos (sessões em `~/.atelie/`). Sempre use `--json` para saída máquina-legível.

## Receitas

```bash
# motor integrável: brief estruturado e API HTTP v1
atelie --brief brief.json --json
atelie --serve --port 4177

# saúde do backend + auth do Codex
atelie --doctor

# listar estilos (id/nome/grupo/origem) e sessões
atelie --list-styles --json
atelie --sessions --json
atelie --session <id> --json

# GERAR + JULGAR (fluxo principal). versions = versões POR estilo.
atelie --run --prompt "<pedido>" --styles fotorrealista,watercolor --versions 2 --json

# opções do --run:
#   --gen-provider codex             (único provedor; outro id falha explicitamente)
#   --judge-mode painel|unico        (painel=Claude+Codex; unico=1 juiz)
#   --judge-models "claude:sonnet,codex:gpt-5.4"
#   --size 2K|WxH|square|portrait|landscape|wide   (dica no codex)
#   --quality low|medium|high
#   --refs a.png,b.png               (consistência/style-transfer via codex edit)
#   --avoid "texto, marca dagua"     (negativos)
#   --iterate <N>                    (auto-melhora até aprovar ou N rondas, usando o veredito)
atelie --run --prompt "logo de coruja" --styles logo-icone --versions 1 --judge-mode unico --json

# CONTINUAR uma sessão (nova iteração)
atelie --continue <id> --iterate 1 --json

# ADICIONAR estilo (Claude autora um StyleDef; --save grava em ~/.atelie/styles.json)
atelie --add-style --desc "<descrição do estilo>" [--images a.png,b.png] [--save] --json

# BATCH: um pedido JSON por linha → uma sessão por linha
#   linha ex.: {"request":"...","styles":["fotorrealista"],"versionsPerStyle":1,"quality":"low"}
atelie --batch pedidos.jsonl --json

# CONTACT-SHEET (galeria HTML autocontida da sessão; abre no navegador)
atelie --contact-sheet <id>

# debug pontual
atelie --gen-one --style pixel-art --prompt "..." --quality low       # gera 1 e imprime o caminho
atelie --judge-file <png> --request "..." [--style <id>] [--model sonnet]
```

O SDK TypeScript está em `atelie/sdk`; o contrato HTTP e o schema do brief estão em
`docs/API-V1.md`. Testes e integrações devem injetar fakes para `generate`,
`transcribe` e `judge` no `criarMotor`, sem gerar imagens reais nem chamar VLMs.

No brief estruturado, use `largura_final_px` quando souber a largura de exibição. Uma
seção pode declarar `ordem_obrigatoria: true`; nesse caso, seus itens precisam aparecer
na ordem informada. Texto fora de `stringsVisiveis` reprova a tentativa por default.
Somente em `modo: "explicacao"`, `texto_extra_permitido: true` libera extras. Em
`modo: "cena"` ou com `texto_fora_da_imagem: true`, qualquer texto continua proibido.

O motor chama primeiro o transcritor de conteúdo, que devolve apenas
`{textos: string[]}`. A comparação e o veto são determinísticos. O juiz visual recebe a
imagem apenas depois de o conteúdo passar e considera a legibilidade em
`largura_final_px`, com referência mínima de aproximadamente 12 px de altura para
texto. Cada item de `manifest.vereditos` mantém o veredito compatível e acrescenta
`conteudo` e `visual`; `visual: null` indica que o veto encerrou a tentativa antes da
avaliação visual.

## Forma do JSON de `--run`
`{sessionId, dir, request, versionsPerStyle, iterations:[{iteration, durationMs, results:[{styleId,index,pngPath,ok,verdict:{nota,aprovado,alinhamento,problemas[],sugestao_melhoria,prompt_sugerido,painel?:[{provider,model,nota,aprovado}]}}], best}], best:{styleId,pngPath,nota}, durationMs}`.
Progresso/log com cronômetro vai no **stderr**; o JSON vai no **stdout**.

Notas: o painel padrão faz 2 chamadas de juiz por imagem (custo/tempo); use `--judge-mode unico` para rápido/barato.
`codex exec` está quebrado no ambiente → juiz-codex usa o backend `responses` (transparente para o usuário).
