#!/usr/bin/env bash
# Suíte de testes SEM custo de API: tipos + funções puras/fixtures + caminhos de erro do CLI.
# Uso: bash tests/run.sh
set -uo pipefail
cd "$(dirname "$0")/.."
FAIL=0
at() { node --import tsx src/cli.tsx "$@"; }   # CLI local (não depende do global `atelie`)

check() { # nome  exit_esperado  comando...
  local nome="$1" exp="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if [[ "$got" == "$exp" ]]; then echo "  ok   $nome (exit $got)"; else echo "  FALHA $nome (exit $got, esperado $exp)"; FAIL=1; fi
}

echo "── tsc --noEmit"
if npx tsc --noEmit; then echo "  ok   tsc limpo"; else echo "  FALHA tsc"; FAIL=1; fi

echo "── D8: exemplos dentro do projeto TypeScript"
if node_modules/.bin/tsc --showConfig | rg -q '"\./examples/'; then
  echo "  ok   examples/ coberto pelo tsconfig"
else
  echo "  FALHA examples/ fora do tsconfig"
  FAIL=1
fi

echo "── testes de fumaça (funções puras + fixtures de sessão)"
if node --import tsx tests/smoke.test.ts; then :; else FAIL=1; fi

echo "── proporção solicitada + gate do motor fake"
if node --import tsx tests/proporcao.test.ts; then :; else FAIL=1; fi

echo "── parser do login por código de dispositivo (wizard de 1ª execução)"
if node --import tsx tests/codexlogin.test.ts; then :; else FAIL=1; fi

echo "── motor/API/SDK com provedor fake (sem gastar imagens)"
if node --import tsx tests/integration.test.ts; then :; else FAIL=1; fi

echo "── CLI: validação/erros (exit 1) e sucesso (exit 0)"
check "run sem --prompt → erro"        1 at --run --styles fotorrealista --versions 1
check "continue sessão inexistente"    1 at --continue ZZZ-nao-existe
check "session inexistente"            1 at --session ZZZ-nao-existe
check "run estilo inválido → erro"     1 at --run --prompt x --styles nao-existe --versions 1
check "provedor inválido → erro"       1 at --run --prompt x --styles fotorrealista --versions 1 --gen-provider desconhecido
check "gen-one estilo inválido → erro" 1 at --gen-one --style nao-existe --prompt x
check "add-style sem --desc → erro"    1 at --add-style
check "list-styles → ok"               0 at --list-styles --json
check "sessions → ok"                  0 at --sessions --json
check "doctor → ok"                    0 at --doctor

echo
if [[ $FAIL == 0 ]]; then echo "✓ TODOS OS TESTES PASSARAM"; else echo "✗ HÁ FALHAS"; fi
exit $FAIL
