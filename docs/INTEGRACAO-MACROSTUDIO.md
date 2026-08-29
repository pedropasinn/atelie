# Integração com o Macrostudio

Leitura realizada sobre os contratos atuais do Macrostudio. A direção continua
`domínio → aplicação → ports → adapters`; o Ateliê entra como adapter de saída e
não altera `Peca`, Remotion ou o painel de juízes.

## Contrato proposto

Hoje `src/ports/index.ts` expõe `GeradorCriativo` (gera `EditorProject`),
`RenderizadorCriativo`, `ProvedorDeJuizCriativo` e `RepositorioDeProducao`. A imagem
generativa tem semântica diferente de `GeradorCriativo`: ela produz um asset raster
para uma cena, não um projeto editorial. A nova porta plausível é:

```ts
interface GeradorDeImagemParaCena {
  gerarImagemParaCena(cena: CenaParaImagem, estilo: string): Promise<{
    png: Uint8Array;
    atelieJobId: string;
    manifest: unknown;
  }>;
}
```

O adapter de exemplo está em `examples/macrostudio-adapter.ts`. Ele depende apenas
de `atelie/sdk`; nenhuma mudança no Macrostudio é necessária nesta entrega.

## Mapeamento dos nomes reais

- `Peca.suporte` é um `IdSuporte`: `reels`, `corte`, `paisagem`, `card` ou `post`.
  O adapter traduz isso para tamanho/proporção, usando os valores de
  `src/dominio/suporte.ts` (`Suporte.largura`/`altura`) como fonte no consumidor.
- `Papel` e `Paleta`, de `src/dominio/papel.ts`, preservam a regra “cor por papel”.
  O adapter envia `Partial<Record<Papel,string>>` em `brief.paleta`; o prompt recebe
  pares semânticos como `rejeita=#…`, não componentes ou tokens de cenografia.
- A saída deve entrar no repositório como `Asset` com `sourceType: "generated"`,
  `sourceId: atelieJobId`, `status: "ready"` e o manifest em `metadata.provenance`.
- Se a imagem virar saída de uma versão, `RenderOutput.productionManifest` continua
  pertencendo ao render do Macrostudio. O recibo do Ateliê fica aninhado como
  proveniência do asset de origem, sem substituir `ManifestoDeProducao`.

## Suportes e tamanho

| `IdSuporte` | brief `tamanho` | leitura |
|---|---:|---|
| `reels`, `corte` | `1152x2048` | 9:16 exato |
| `paisagem` | `2048x1152` | 16:9 |
| `card` | `1280x1600` | 4:5 exato |
| `post` | `2048x2048` | quadrado |

O wrapper instalado [`gpt-image-2-skill` 0.7.3](https://github.com/Wangnov/gpt-image-2-skill/tree/v0.7.3) aceita `WIDTHxHEIGHT` customizado com
lados múltiplos de 16, razão máxima 3:1 e até 8.294.400 pixels; portanto os tamanhos
acima são pedidos válidos e não convertem 9:16 em 3:4. O backend Codex ainda trata o
tamanho como dica: o adapter deve conferir `manifest.arquivo.dimensoes` e só então
enquadrar no pipeline da peça quando a dimensão final divergir.

## Gate

O brief usa `modo: "cena"`, portanto o juiz do Ateliê reprova texto acidental. Isso
é um gate de geração, não a liberação editorial: o `ProvedorDeJuizCriativo` e a
revisão humana do Macrostudio continuam decidindo se a peça sai. Idempotência é pelo
`brief_hash`; persistir o `atelieJobId` em `Asset.sourceId` permite reconstruir a
proveniência depois de fechar o editor.
