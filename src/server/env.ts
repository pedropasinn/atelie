import { WRAPPER_CJS } from '../config';
import { doctor, authInspect } from '../lib/imageBackend';
import { loadSettings, saveSettings } from '../lib/settings';
import { run } from '../lib/runner';
import { nodeBin, nodeSpawnEnv } from '../lib/nodeBin';

// Checador de ambiente dos DOIS modos de auth (login das CLIs + chaves de API).
// NÃO gera imagem nem consome tokens: só sonda binários com timeout curto.

export interface CliStatus {
  id: 'codex' | 'claude';
  nome: string;
  instalada: boolean;
  versao?: string;
  autenticada: boolean;
  detalhe: string;
  remediacao?: string[];
  capacidades: string[];
}

export interface ApiKeyStatus {
  provider: 'openai' | 'anthropic' | 'google';
  presente: boolean;
  origem: 'env' | 'settings' | 'ausente';
}

export interface Environment {
  clis: CliStatus[];
  apiKeys: ApiKeyStatus[];
  authMode: string;
}

interface RunProbe {
  ran: boolean; // o processo abriu e fechou (não deu ENOENT/timeout)
  ok: boolean; // saiu com código 0
  stdout: string;
  stderr: string;
}

/** Roda um binário com timeout curto; ENOENT/timeout viram `ran:false` (sem lançar). */
async function tryRun(bin: string, args: string[], timeoutMs = 5000, env?: NodeJS.ProcessEnv): Promise<RunProbe> {
  try {
    const { code, stdout, stderr } = await run(bin, args, { timeoutMs, env }).done;
    return { ran: true, ok: code === 0, stdout, stderr };
  } catch {
    return { ran: false, ok: false, stdout: '', stderr: '' };
  }
}

function firstLine(s: string): string | undefined {
  const t = s.split('\n').map((l) => l.trim()).find(Boolean);
  return t || undefined;
}

/** Tenta extrair a versão do wrapper (`--version`), tolerando JSON ou texto puro. */
async function codexVersion(): Promise<string | undefined> {
  const p = await tryRun(nodeBin(), [WRAPPER_CJS, '--json', '--version'], 5000, nodeSpawnEnv());
  if (!p.ran) return undefined;
  const out = (p.stdout || p.stderr).trim();
  if (!out) return undefined;
  try {
    const j = JSON.parse(out);
    const v = j?.version ?? j?.data?.version;
    if (typeof v === 'string' && v.trim()) return v.trim();
  } catch {
    /* não é JSON — cai no texto cru abaixo */
  }
  // Evita devolver um fragmento estrutural de JSON (ex.: a linha "{") como se fosse versão.
  const line = firstLine(out);
  if (!line || /^[{}[\]]/.test(line)) return undefined;
  return line;
}

async function checkCodex(): Promise<CliStatus> {
  const [d, a, versao] = await Promise.all([doctor(), authInspect(), codexVersion()]);
  // instalada = o wrapper roda e resolve o provider codex; autenticada = auth do Codex pronta.
  const instalada = d.resolved === 'codex' || d.ok;
  const autenticada = a.codexReady;
  const detalhe = !instalada
    ? 'wrapper gpt-image-2 não resolveu o provider codex (verifique o caminho do WRAPPER_CJS)'
    : autenticada
      ? 'codex resolvido e autenticado (login ChatGPT ok)'
      : 'codex resolvido, mas sem auth pronta';
  const status: CliStatus = {
    id: 'codex',
    nome: 'Codex (gpt-image-2)',
    instalada,
    autenticada,
    detalhe,
    capacidades: ['geração', 'juiz-codex'],
  };
  if (versao) status.versao = versao;
  if (!autenticada) status.remediacao = ['Faça login no Codex/ChatGPT (ex.: `codex login`) e tente de novo.'];
  return status;
}

async function checkClaude(): Promise<CliStatus> {
  const v = await tryRun('claude', ['--version']);
  const instalada = v.ran;
  // Não há check de login barato garantido; NÃO geramos nada. Se o binário existe,
  // consideramos autenticada e deixamos o `detalhe` honesto sobre a limitação.
  const autenticada = instalada;
  const status: CliStatus = {
    id: 'claude',
    nome: 'Claude Code',
    instalada,
    autenticada,
    detalhe: instalada
      ? 'binário presente; login não é verificável sem consumir tokens (assumido ok)'
      : 'claude não encontrado na PATH',
    capacidades: ['juiz-claude', 'add-style', 'cânone-série'],
  };
  const versao = instalada ? firstLine(v.stdout || v.stderr) : undefined;
  if (versao) status.versao = versao;
  if (!instalada) status.remediacao = ['Instale o Claude Code e rode `claude login`.'];
  return status;
}

/** Chave presente no env OU nas settings (nunca devolve o valor). */
function keyStatus(
  provider: ApiKeyStatus['provider'],
  envVal: string | undefined,
  settingVal: string | null,
): ApiKeyStatus {
  if (envVal && envVal.trim()) return { provider, presente: true, origem: 'env' };
  if (settingVal && settingVal.trim()) return { provider, presente: true, origem: 'settings' };
  return { provider, presente: false, origem: 'ausente' };
}

/**
 * Desliga nas settings as CLIs que não estão instaladas na máquina. Roda no boot.
 *
 * Sem isso, numa instalação sem o Claude Code o painel de juízes continuaria
 * chamando o juiz Claude a cada imagem: `safeJudgeOne` engole o erro, mas o
 * usuário veria metade do painel falhando para sempre. Só DESLIGA — reativar é
 * decisão do usuário nas Configurações, senão sobrescreveríamos a escolha dele.
 */
export async function desligarClisAusentes(): Promise<string[]> {
  const settings = loadSettings();
  const claude = await checkClaude();
  const desligadas: string[] = [];
  if (!claude.instalada && settings.enabledClis?.claude !== false) {
    saveSettings({ ...settings, enabledClis: { ...settings.enabledClis, claude: false } });
    desligadas.push('claude');
  }
  return desligadas;
}

export async function checkEnvironment(): Promise<Environment> {
  const settings = loadSettings();
  const [codex, claude] = await Promise.all([checkCodex(), checkClaude()]);
  const apiKeys: ApiKeyStatus[] = [
    keyStatus('openai', process.env.OPENAI_API_KEY, settings.openaiApiKey),
    keyStatus('anthropic', process.env.ANTHROPIC_API_KEY, settings.anthropicApiKey),
    keyStatus('google', process.env.GOOGLE_API_KEY, settings.googleApiKey),
  ];
  return { clis: [codex, claude], apiKeys, authMode: settings.authMode };
}
