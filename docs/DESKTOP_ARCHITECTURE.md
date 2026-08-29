# Ateliê Desktop — Arquitetura de Produto (proposta)

Transformar o Ateliê (motor Node/TS + TUI Ink + CLI headless) num **app desktop instalável, atualizável e
distribuível**. Princípio-mestre: **reaproveitar o motor existente, não reescrever**. Todo o `src/lib/*`
(pipeline, genProviders, judgeProviders, serie/*, sessions, settings, doctor) já é agnóstico de UI e emite
eventos via `onLog`/`onProgress` — a TUI e a CLI são só duas fachadas. A UI web vira a **terceira fachada**
sobre o MESMO motor.

## 1. Stack recomendada — **Electron** (com fase 0 em Node-server+navegador)

Comparação para ESTE projeto (motor 100% Node + CLIs Node/Go):

| Opção | Prós p/ nós | Contras | Veredito |
|---|---|---|---|
| **Electron** ⭐ | Main process É Node → o motor roda **in-process**, sem ponte p/ runtime estranho; `child_process` p/ codex/claude nativo; **electron-updater** (auto-update GitHub) maduro; **electron-builder** gera NSIS/DMG/AppImage; ecossistema enorme | Binário ~110–140MB, mais RAM | **Escolhido** |
| Tauri | Binário ~10MB, seguro | Core é **Rust** ≠ nosso motor Node → teria que embarcar Node como *sidecar* e fazer ponte Rust↔Node (plumbing extra); updater mais manual. Só valeria se reescrevêssemos em Rust (não é o caso) | Rejeitado |
| Node server + navegador do usuário (pkg/nexe) | Mais leve, "abre no navegador" nativo, casa com o pedido "sobe localhost" | Sem janela/tray/auto-update polidos; sente menos "app" | **Fase 0 (MVP)** e fallback |
| Wails(Go)/Flutter/Python(pywebview) | — | Exigem reescrever/pontear o motor Node | Rejeitado |

**Decisão:** MVP como **servidor local Node + UI web** (rápido, entrega valor já, atende "sobe localhost e abre no
navegador"); depois **envelopar em Electron** para instalador + janela + auto-update. Mesmo código de UI e motor
nos dois — o Electron só adiciona a casca de distribuição.

## 2. Arquitetura de componentes

```
┌── Electron (casca desktop) ─────────────────────────────────────────────┐
│  MAIN (Node) — o MOTOR roda aqui in-process:                            │
│   • reusa src/lib/* (pipeline/providers/judges/serie/sessions/doctor)   │
│   • Servidor local Fastify + WebSocket em 127.0.0.1:<porta aleatória>   │
│       REST: /doctor /run /serie /sessions /styles /settings /clis       │
│       WS:   stream de log/progress/tentativas (onLog/onProgress → WS)   │
│   • spawn das CLIs externas (codex/claude) via child_process            │
│   • electron-updater (feed = GitHub Releases)  • tray + deep-link       │
│  RENDERER (Chromium) — UI WEB (React/Vite):                            │
│   • Dashboard, Doctor, Criar, Série, Sessões, Galeria, Config, CLIs     │
│   • fala com o localhost via fetch + WS (mesma origem)                  │
└─────────────────────────────────────────────────────────────────────────┘
     │ spawn                          persistência
     ▼                                     ▼
 codex(wrapper gpt-image-2) · claude            ~/.atelie (sessions/series/settings/styles)
 (CLIs + assinaturas do usuário)
```

Camadas novas a criar (sem tocar no motor):
- `src/server/` — `createServer()` (Fastify+ws) que expõe o motor. Cada rota chama uma função de `lib/` e faz
  stream dos eventos por WS. Um `src/server/bin.ts` (`atelie serve --port`) permite rodar SÓ o servidor (Fase 0).
- `src/desktop/` (Electron) — `main.ts` (sobe o server, cria BrowserWindow apontando p/ o server, tray, updater),
  `preload.ts` (bridge segura). `electron-builder.yml` (targets + publish GitHub).
- `ui/` — app React/Vite (nova pasta). Consome o localhost. Reusa a paleta/branding (#002060/#00F0FF).

## 3. Funcionalidades ↔ desenho

**(1) Inicialização via executável** — instalador (NSIS/DMG/AppImage) coloca atalho; abrir → Electron sobe o
server local (porta efêmera, bind 127.0.0.1) e abre a janela (ou botão "Abrir no navegador" → mesma URL).

**(2) Interface visual da TUI** — a UI web NÃO "espelha" a TUI; ambas são fachadas do motor. Painel ao vivo:
logs com cronômetro (WS de `onLog`), progresso por job/painel (WS de `onProgress`), status, erros, e comandos.
Fluxos Criar/Série/Sessões/Galeria/Config todos via REST. (A TUI Ink continua existindo p/ quem prefere terminal.)

**(3) Verificador de dependências + auth** — evoluir `doctor()/authInspect()` num `checkEnvironment()` que, por CLI,
retorna: instalada? (which/versão), autenticada? (codex `auth inspect` ready / claude logado),
e `remediation` (passo-a-passo). UI: checklist com botões guiados — instalar (mostra comando/copiável), logar
(`claude login`/login do codex em terminal embutido, streamando saída), revalidar. Automatiza o que é seguro
(spawn do login, re-check). codex expira e auto-refresha (já visto).

**(4) Controle por CLI (feature flags)** — mapa de capacidades:
`codex→{geração, juiz-codex}`, `claude→{juiz-claude, add-style, cânone-série}`.
`settings.enabledClis` persiste o estado. Desligar uma CLI → UI desabilita (cinza + tooltip "requer X") os recursos
dependentes e o motor deixa de oferecê-los (os providers já são selecionáveis por settings; basta filtrar pelos
habilitados e avisar). Ex.: sem `claude` somem add-style e cânone.

**(5) Instalável/distribuível** — `electron-builder` gera instaladores; **GitHub Releases** hospeda instaladores +
feed de update. Estrutura: `ui/`, `src/server/`, `src/desktop/`, `docs/`, `.github/workflows/release.yml`
(build multiplataforma em tag → publica). README + CHANGELOG + LICENSE.

**(6) Auto-update** — `electron-updater` com provider `github`. Em nova release (tag), o app detecta, baixa e
oferece/instala (delta quando possível). **Assinatura de código** é obrigatória p/ produto comercial (Windows:
cert OV/EV senão SmartScreen assusta; macOS: notarização). Custo/step a considerar.

## 4. Realidade de produto (pensar como product engineer) — RISCOS

- **BYO-assinatura**: o usuário final precisa de codex(ChatGPT) e, para recursos opcionais, claude instalado e logado. Isso é barreira
  de onboarding e **dependência de ToS de terceiros**. O valor vendável é a **orquestração + motor de
  consistência/série + UX**, não a geração em si.
- **Risco jurídico (o maior)**: revender um produto que "pega carona" na assinatura ChatGPT/Claude do usuário via
  CLI é área cinzenta de ToS. Caminho comercial mais seguro: **modo API-key** (o usuário põe a própria chave
  OpenAI/Anthropic — oficial e pago por ele) OU um backend hospedado por você. Recomendo suportar **modo API-key**
  além do modo CLI, e deixar claro na doc o que é permitido.
- **Multiplataforma**: as CLIs precisam existir no SO alvo. claude (Windows ok), codex (npm cross-platform) e
  wrapper gpt-image-2 (Node + binário Rust com target Windows). **Validar no
  MVP.** Distribuir p/ "usuários comuns" no Windows exige as CLIs nativas no Windows (não WSL).
- **Code signing** custa (~US$100–400/ano Win, US$99/ano Apple).

## 5. Plano de implementação (faseado)

**Fase 0 — MVP (servidor local + UI web) — entrega valor sem casca desktop**
- `src/server/` (Fastify+ws) expondo doctor/run/serie/sessions/styles/settings + WS de eventos.
- `ui/` React/Vite: Dashboard, Doctor (deps+auth com remediação), Criar (gera+julga, logs ao vivo), Sessões+Galeria.
- `atelie serve` sobe tudo; abre no navegador. Reusa 100% do motor.
- Entregável: `npm run serve` → app usável no navegador. Riscos: portas/CORS (mitigado por same-origin localhost).

**Fase 1 — Beta instalável (Electron)**
- `src/desktop/` (main+preload), janela apontando p/ o server, tray, "Abrir no navegador".
- Feature flags por CLI na UI + persistência. Série completa na UI. Config completa.
- `electron-builder` → instaladores Win/Mac/Linux. `release.yml` publica no GitHub.
- Entregável: instalador `.exe`/`.dmg`/`.AppImage` que o usuário instala e abre. Riscos: bundling das CLIs/paths.

**Fase 2 — Comercial**
- **auto-update** (electron-updater + releases assinadas), assinatura de código, onboarding/wizard de 1ª execução.
- **Modo API-key** (alternativa ToS-safe ao modo CLI). Licenciamento (chave/ativação) se for pago.
- Telemetria opt-in, tratamento de erros/relatório, i18n, landing + docs.
- Entregável: produto assinado, auto-atualizável, pronto p/ venda. Riscos: ToS/jurídico, custo de certificados.

## 6. Decisões de arquitetura travadas nesta proposta
- Reusar o motor Node in-process (Electron), não reescrever.
- UI web (React) como fachada sobre servidor localhost (Fastify+WS) — a mesma URL abre no app ou no navegador.
- MVP sem Electron (server+browser) → Electron na Fase 1 → auto-update/assinatura na Fase 2.
- Suportar modo **CLI** (atual) e, na Fase 2, modo **API-key** p/ viabilidade comercial.
