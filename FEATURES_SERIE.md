# Ateliê — Modalidade "Série" (coerência entre múltiplas imagens)

Nova modalidade para gerar SEQUÊNCIAS coerentes (HQ, storyboard, livro ilustrado): um personagem/estilo
deve se manter consistente de um quadrinho/página para o próximo. Estende o app (v3); obedecer
BUILD_CONTRACT.md, FEATURES_V3.md e a regra de UI (seleção por cor/negrito/fundo, sem borda lateral; sem emojis salvo setas e ✓/✗; pt-BR).

## Mecanismos VERIFICADOS ao vivo (08/07/2026) — a base do design
1. **Consistência de personagem via edição referenciada**: `node <WRAPPER_CJS> --json --json-events --provider codex images edit --ref-image <ANCORA> --prompt "<cena, com 'SAME character/style as reference, keep IDENTICAL'>" --out <p> --size 2K --quality <q> --format png` MANTÉM a identidade do personagem (testado: personagem "Mia" ficou on-model entre a âncora e um painel de ação). ESTE é o mecanismo de geração dos painéis. Aceita MÚLTIPLAS `--ref-image` (repetível, até 16) → passar as âncoras de todos os personagens presentes (+ opcionalmente o painel anterior p/ continuidade). Painéis usam sempre codex.
2. **Juiz de consistência multi-imagem**: um juiz que recebe 2+ imagens (âncora(s) + candidato) e pontua consistência+cena. Testado com claude (bloco de 2 imagens no content) — retornou JSON com drifts REAIS e específicos (shading, proporção, laços, espessura dos óculos) + prompt corretivo. Os juízes implementados aceitam multi-imagem: claude (múltiplos blocos image) e codex (múltiplos input_image no body responses).

## Modelo de dados (src/types.ts)
```ts
export interface Personagem { nome: string; descricao: string; anchorPng?: string }  // descricao = trava visual detalhada
export interface Canon {
  estiloId: string;            // id do catálogo (ou 'custom')
  estiloDescricao: string;     // trava de estilo/linha/paleta, injetada VERBATIM em todo painel
  personagens: Personagem[];
  paleta?: string; mundo?: string;  // travas de paleta/cenário
}
export interface Painel {
  n: number; cena: string; personagens: string[];   // nomes presentes neste painel
  pngPath?: string; prompt?: string;
  consistencia?: number|null; cenaNota?: number|null; drifts?: string[];
  sugestao_melhoria?: string; prompt_sugerido?: string; aprovado?: boolean; tentativas?: number;
}
export interface Serie { id: string; titulo: string; createdAt: string; request: string; canon: Canon; paineis: Painel[] }
```
Screen union ganha: 'serie_menu'|'serie_new'|'serie_anchors'|'serie_panels'|'serie_view'.

## Persistência — `~/.atelie/series/<id>/`
`serie.json` (snapshot), `manifest.jsonl` (append-only: serie_start/anchor/panel/iterate/serie_end), `anchors/<slug-personagem>.png`, `panels/panel-NN.png`, `contact-sheet.html`. Espelhar padrões de state/manifest.ts + lib/sessions.ts. id = `YYYYMMDD-HHMMSS-<rand6>`.

## Módulos novos (src/lib/serie/)
- `store.ts` — criar/carregar/salvar Série + manifest; listSeries()→resumo; loadSerie(id); serieDir/anchorPath/panelPath.
- `canon.ts` —
  - `buildCanonBlock(canon, personagensPresentes: string[]): string` — bloco INVARIANTE: estiloDescricao + descrições dos personagens presentes (verbatim) + paleta/mundo + cláusula "keep the character(s) and art style IDENTICAL to the reference image(s); same face, hair, outfit, colors and line style; only change the pose/action/background". É prefixado ao prompt de TODO painel.
  - `draftCanon(descricao: string, estiloId: string, model?: string): Promise<Canon>` — via Claude (padrão styleGenerator/judge multimodal, aceita imagens opcionais): extrai personagens (nome+descrição visual travável), estiloDescricao e mundo/paleta a partir da descrição livre do usuário. extractJson + validação.
- `anchor.ts` — `generateAnchor(canon, personagem, opts): Promise<{pngPath, meta}>`: `images generate` (codex) de um CHARACTER SHEET (full body, front view, plain white/neutral background, estiloDescricao aplicado) do personagem. Opcional loop de aprovação (juiz padrão) até o usuário/limiar aceitar. Salva em anchors/<slug>.png e grava em canon.personagens[].anchorPng.
- `consistencyJudge.ts` — `judgeConsistency(refs: string[], candidate: string, canon, cena, spec: JudgeSpec): Promise<ConsistencyVerdict>` onde ConsistencyVerdict = {consistencia:0-10|null, cenaNota:0-10|null, drifts:string[], sugestao_melhoria, prompt_sugerido, raw?}. Rubrica: Imagem(ns) 1..k = REFERÊNCIA (âncoras), última = novo painel; avaliar consistência (rosto/cabelo/cor/roupa/óculos/estilo/paleta) e fidelidade à cena; JSON. REUTILIZAR o transporte multi-imagem dos judgeProviders — GENERALIZAR judgeProviders para aceitar uma LISTA de imagens (não só 1): claude→N blocos image; codex→N input_image no body responses. Detectar mime real (âncora pode ser png, painel idem). Coerção/fallback como coerce/fallback.
- `panel.ts` — `generatePanel(serie, painel, opts): Promise<Painel>`: o LOOP DE COERÊNCIA:
  ```
  refs = [anchorPng de cada personagem presente] (+ opts.incluirAnterior? [painelAnterior.pngPath] : [])
  para tentativa em 1..opts.maxTentativas (default 3):
    prompt = buildCanonBlock(canon, painel.personagens) + " CENA: " + painel.cena
             + (feedback ? " AJUSTE (mantendo consistência): " + feedback.sugestao_melhoria
                          + " Diferenças a corrigir vs a referência: " + feedback.drifts.join('; ') : "")
    png = imageBackend.generate(job{ mode:'edit', refs, prompt, outPath }, size, quality)  // edit multi-ref
    v = judgeConsistency(refs_de_personagens, png, canon, painel.cena, judgeSpec)
    grava manifest/painel (consistencia, cenaNota, drifts, prompt)
    se v.consistencia>=consistThreshold E v.cenaNota>=cenaThreshold: aprovado=true; break
    feedback = v   // reforça drifts na próxima tentativa; se aceitar prompt_sugerido, re-encapsular no cânone
  retorna painel com pngPath/vereditos/aprovado
  ```
  Config: `consistThreshold` (default 8), `cenaThreshold` (default 7), `maxTentativas` (default 3), `judgeSpec` (default claude sonnet; painel opcional), `incluirAnterior` (default true).
- `serieRun.ts` (ou dentro de store) — `runSerie(spec, opts): Promise<Serie>` headless: draftCanon (se canon não vier pronto) → generateAnchor por personagem (auto, sem loop interativo, mas com 1 checagem de qualidade) → generatePanel para cada painel do spec, em SEQUÊNCIA (importa a ordem; painel N pode referenciar N-1). Grava tudo. 

## imageBackend — múltiplas referências
Estender GenJob com `refs?: string[]` (além de refPng legado). Em `generate`, para mode 'edit': montar UM `--ref-image <p>` por item de `refs` (fallback: `[refPng]` se refs vazio). O resto igual (o wrapper aceita repetível). NÃO passar --format? edit ACEITA --format (só transparent generate não aceita). Manter --format png no edit.

## CLI (`atelie serie <ação>`, via cli.input posicional do meow)
- `serie new --titulo "..." --estilo <id> [--desc "<descrição livre>"] [--canon canon.json] [--json]` → cria série; se --desc, draftCanon via Claude; imprime o canon (p/ revisão).
- `serie anchor <serieId> [--personagem <nome>] [--json]` → gera âncora(s) do(s) personagem(ns) (todas se sem --personagem).
- `serie panel <serieId> --cena "<ação>" [--personagens a,b] [--json]` → gera 1 painel coerente (loop) e imprime veredito.
- `serie run --spec serie.json [--json]` → série INTEIRA headless (canon+âncoras+painéis). **Principal p/ automação.** JSON de saída:
  `{serieId, dir, canon:{personagens:[{nome,anchorPng}]}, paineis:[{n,cena,pngPath,consistencia,cenaNota,aprovado,drifts}], contactSheet}`.
- `serie list [--json]` · `serie show <id> [--json]` · `serie sheet <id>` (gera contact-sheet da série e imprime caminho).
Formato do `--spec`: `{titulo, estilo, canon?:{estiloDescricao,personagens:[{nome,descricao}],paleta?,mundo?}, desc?, paineis:[{cena, personagens?:[...]}]}`. Se `canon` ausente e `desc` presente → draftCanon.

## Contact-sheet da série
Estender/derivar de contactSheet.ts: seção CÂNONE (âncoras + descrições) no topo, depois os PAINÉIS em ordem com nota de consistência/cena e a cena por baixo. HTML autocontido (base64, mime detectado), anti-injeção (escapar cena/descrições/drifts). Botão [Abrir galeria].

## TUI — modo "Série" (novo item no MainMenu)
- `serie_menu`: Nova série · Séries salvas · voltar.
- `serie_new`: título + descrição livre → draftCanon (spinner "Claude montando a bíblia…") → mostra/edita canon (personagens/estilo/mundo) → confirmar.
- `serie_anchors`: por personagem, gera character sheet; usuário Visualiza, e Aceita/Melhora/Regenera (loop). Só avança quando todas as âncoras aprovadas.
- `serie_panels`: adicionar painel (descrever cena + escolher personagens presentes) → gera com loop de coerência (LogPanel + cronômetro + tentativas visíveis) → mostra ÂNCORA × PAINEL (caminhos + [Visualizar] de cada) + veredito de consistência/drifts → Aceitar / Melhorar (reforça drifts) / Regenerar. Lista os painéis já feitos.
- `serie_view`: contact-sheet da série ([Abrir galeria]) + custo/tempo.
- Continuar série salva (adicionar mais painéis depois).
Config em Configurações: consistThreshold, cenaThreshold, maxTentativas, incluirAnterior, judge da série.

## Testes de regressão (sem rede) em tests/smoke.test.ts
- `buildCanonBlock` inclui estiloDescricao + descrições dos personagens presentes (e NÃO dos ausentes) + a cláusula "IDENTICAL".
- prompt do painel com feedback de drift inclui os drifts e a sugestão.
- montagem de argv do edit com múltiplas `--ref-image` (se helper puro exposto).
- store: criar/salvar/carregar série roundtrip (ATELIE_HOME temp); listSeries encontra.
- contact-sheet da série ESCAPA `<script>` da cena/descrição.
Manter os 53 testes existentes verdes.

## Gates
- `npm test` verde.
- `atelie serie run --spec <mini spec: 1 personagem, 2 painéis, quality low> --json` → gera âncora + 2 painéis coerentes, imprime JSON com consistencia por painel e contactSheet.
