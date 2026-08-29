# Ateliê v3 — estado consolidado

Este documento registra o desenho implementado sem anunciar integrações inexistentes.
A geração usa exclusivamente o provedor `codex` com `gpt-image-2`; qualquer outro id
é recusado de forma explícita. Os juízes implementados são Claude e Codex, conforme
as flags de capacidade e as configurações locais.

## Contratos preservados

- `GenProviderId` contém somente `codex`.
- Geração, edição referenciada e transparência passam pelo wrapper
  `gpt-image-2-skill` e registram o provedor/modelo efetivamente usados.
- `--gen-provider codex` é aceito; qualquer valor desconhecido encerra com erro.
- `--judge-mode painel|unico` e `--judge-models` aceitam apenas juízes disponíveis.
- Tamanho é enviado por flag; dimensão real é lida do PNG e registrada no manifest.
- Custos são estimativas configuráveis, nunca apresentados como cobrança observada.

## Próximas extensões

Um novo provedor só pode entrar com adapter funcional, testes de geração e erro,
capability flags honestas e proveniência do modelo real. Não haverá fallback
silencioso para outro provedor.
