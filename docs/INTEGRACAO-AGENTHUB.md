# Integração com o AgentHub

O AgentHub trata uma geração como trabalho externo auditável: cria o job, acompanha
`GET /v1/jobs/{id}`, baixa o PNG e registra o `manifest` devolvido no resultado.
Use `quality: "medium"` por padrão; `high` exige decisão explícita do chamador.

## Fluxo proposto

1. O hub converte a explicação/relatório em brief `modo: "explicacao"` e, de
   preferência, `texto_fora_da_imagem: true`.
2. `POST /v1/jobs` devolve o mesmo job para o mesmo `brief_hash`; uma retentativa de
   rede não duplica custo.
3. O hub registra eventos `atelie.job.requested`, `atelie.job.progress` e
   `atelie.job.completed|failed|cancelled`, usando `job.id` como correlação.
4. Ao concluir, baixa cada `artifact_url`; o `manifest` vira metadado do artefato e
   seu `arquivo.sha256` confere os bytes recebidos.

Mapeamento mínimo sugerido para um artefato do AgentHub:

```json
{
  "kind": "image/png",
  "source": "atelie",
  "external_job_id": "job-…",
  "sha256": "manifest.arquivo.sha256",
  "provenance": "manifest completo"
}
```

## Texto determinístico sobre a camada visual

Com `texto_fora_da_imagem: true`, o Ateliê gera o PNG sem texto e devolve no
manifest uma lista estável para o consumidor compor depois:

```json
{
  "parametros": { "modo": "explicacao", "texto_fora_da_imagem": true },
  "rotulos_overlay": [
    { "id": "titulo", "tipo": "titulo", "texto": "RELATÓRIO EM UMA PÁGINA" },
    { "id": "secao-1", "tipo": "secao", "texto": "ENTRADA", "secao": 1 },
    { "id": "secao-1-item-1", "tipo": "item", "texto": "pedido", "secao": 1 }
  ]
}
```

O AgentHub usa esses valores como fonte de verdade em HTML/SVG: posiciona título,
rótulos, números, setas e dados sobre o PNG, mantendo texto selecionável,
acessível, localizável e corrigível sem regenerar a arte. O campo é uma lista de
conteúdo, não uma promessa de coordenadas; o layout do overlay continua sob
responsabilidade do template do consumidor. O juiz do Ateliê reprova qualquer
texto acidental na camada raster.

## Juiz de conteúdo e juiz visual

Quando o raster contém rótulos, o Ateliê usa `stringsVisiveis` como allowlist. O
primeiro VLM não dá nota: ele apenas transcreve o que vê no JSON
`{textos: string[]}`, em ordem visual de leitura quando necessário. O motor normaliza
caixa, acentos, espaços e pontuação externa, tolera pequenas diferenças de OCR e faz
a comparação em código. Numeração isolada, como `1`, `B1` e `H3`, é registrada à
parte e não conta como texto extra.

Por default, rótulo ausente ou texto fora da allowlist veta uma tentativa em
`modo: "explicacao"`. `texto_extra_permitido: true` libera somente os extras; rótulos
ausentes continuam críticos. Em `modo: "cena"` e com
`texto_fora_da_imagem: true`, qualquer transcrição, inclusive numeração, é crítica.
Uma seção com `ordem_obrigatoria: true` também é vetada quando seus itens aparecem
fora da ordem declarada.

O juiz visual só recebe imagens aprovadas pelo conteúdo. Ele avalia composição,
contraste, clareza semântica e legibilidade, sem refazer a comparação textual. Se o
brief trouxer `largura_final_px`, a rubrica informa a largura de exibição e o fator de
redução; texto com menos de aproximadamente 12 px de altura no tamanho final deve ser
reprovado.

O recibo preserva os campos existentes e acrescenta a separação por tentativa:

```json
{
  "parametros": {
    "largura_final_px": 800,
    "texto_extra_permitido": false
  },
  "vereditos": [
    {
      "conteudo": {
        "aprovado": false,
        "faltantes": ["DECISÃO"],
        "extras": ["RESULTADOS GARANTIDOS"],
        "numeracao": ["1"],
        "ordem_incorreta": [],
        "problemas": [
          "texto não autorizado: RESULTADOS GARANTIDOS",
          "rótulo ausente: DECISÃO"
        ]
      },
      "visual": null
    }
  ]
}
```

`visual: null` informa que o veto de conteúdo impediu a segunda chamada. Na tentativa
seguinte, o prompt recebe a allowlist como proibição explícita e repete os rótulos
obrigatórios ausentes. Uma nota visual alta nunca substitui esse aceite.

## TUI e relatórios

O arquivo canônico continua sendo o PNG. Para embutir no TUI/HTML, o consumidor
gera uma derivação para exibição: preserve proporção, reduza dimensões e comprima
até o payload final ter no máximo **400 KB por figura**. Só então converta para
`data:image/png;base64,…` (ou WebP quando o relatório aceitar). Registre no evento
o SHA-256 do original e, opcionalmente, o da derivação. Não coloque o data URI no
manifest do Ateliê nem no log append-only; ele multiplica o volume em cerca de 33%.

Texto detalhado, tabelas e números permanecem no relatório acessível; rótulos
curtos podem ser compostos como overlay. Se a derivação não alcançar 400 KB sem perder leitura, o
relatório deve referenciar o arquivo como anexo em vez de degradá-lo silenciosamente.

Veja o cliente completo em `examples/agenthub-explicacao.ts` e o contrato HTTP em
`docs/API-V1.md`.
