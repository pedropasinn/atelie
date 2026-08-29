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
