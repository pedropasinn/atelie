# Integração com o AgentHub

O AgentHub trata uma geração como trabalho externo auditável: cria o job, acompanha
`GET /v1/jobs/{id}`, baixa o PNG e registra o `manifest` devolvido no resultado.
Use `quality: "medium"` por padrão; `high` exige decisão explícita do chamador.

## Fluxo proposto

1. O hub converte a explicação/relatório em brief `modo: "explicacao"`, com rótulos
   curtos e conteúdo denso mantido no corpo textual do relatório.
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

## TUI e relatórios

O arquivo canônico continua sendo o PNG. Para embutir no TUI/HTML, o consumidor
gera uma derivação para exibição: preserve proporção, reduza dimensões e comprima
até o payload final ter no máximo **400 KB por figura**. Só então converta para
`data:image/png;base64,…` (ou WebP quando o relatório aceitar). Registre no evento
o SHA-256 do original e, opcionalmente, o da derivação. Não coloque o data URI no
manifest do Ateliê nem no log append-only; ele multiplica o volume em cerca de 33%.

Texto detalhado, tabelas e números permanecem no relatório acessível; a figura usa
poucos rótulos grandes. Se a derivação não alcançar 400 KB sem perder leitura, o
relatório deve referenciar o arquivo como anexo em vez de degradá-lo silenciosamente.

Veja o cliente completo em `examples/agenthub-explicacao.ts` e o contrato HTTP em
`docs/API-V1.md`.
