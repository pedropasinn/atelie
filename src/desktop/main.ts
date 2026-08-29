// Casca Electron do Ateliê. O motor (src/lib/*) e o servidor local (src/server/*)
// rodam IN-PROCESS no processo main; a janela (Chromium) só carrega a UI web
// servida pelo Fastify em 127.0.0.1:<porta efêmera>. Nada de OPENAI_API_KEY aqui:
// a geração é via CLIs do usuário (Codex e, opcionalmente, Claude), spawnadas pelo motor.
import { app, BrowserWindow, Menu, Tray, shell, nativeImage, session as electronSession } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Detecta WSL (Linux rodando dentro do Windows). */
function isWSL(): boolean {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME) return true;
  try {
    return fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

// Sob WSLg o Chromium renderiza por GPU EMULADA (software) → janela travada/lenta
// e o sandbox falha (sem bus de sessão). Desligar a aceleração de hardware deixa a
// UI mais fluida NESSE caso. Em Windows/macOS nativos NÃO mexemos (a GPU real é o
// que deixa rápido). Precisa rodar ANTES de app.whenReady.
if (isWSL()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

// Diretório deste bundle. Em produção/dev o main empacotado vive em
// `dist-electron/main.cjs`; a UI compilada, em `../ui/dist` ao lado.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.join(HERE, '..', 'ui', 'dist');
const PRELOAD = path.join(HERE, 'preload.cjs');

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverUrl = '';
let closeServer: (() => Promise<void>) | null = null;
let serverToken: string | undefined;

/** Sobe o servidor local reusando o motor. Chamado após app.whenReady. */
async function startLocalServer(): Promise<string> {
  // ANTES de importar/subir o server: em produção não há `node` garantido na PATH.
  // O motor spawna `node <wrapper.cjs>`; apontamos para o próprio Electron rodando
  // como Node puro (ELECTRON_RUN_AS_NODE=1 é injetado no spawn por lib/nodeBin.ts).
  process.env.ATELIE_NODE_BIN = process.execPath;
  // Onde a UI compilada está, para o Fastify servi-la (o server empacotado não
  // consegue derivar isso sozinho — ver src/server/server.ts).
  process.env.ATELIE_UI_DIST = UI_DIST;

  // Import dinâmico: garante que o env acima já está setado quando o grafo do
  // server (e do motor) é inicializado.
  const [{ startServer }, { loadLocalToken }] = await Promise.all([import('../server/server'), import('../server/v1')]);
  serverToken = loadLocalToken();
  const srv = await startServer(undefined, { token: serverToken }); // porta efêmera, bind 127.0.0.1
  closeServer = srv.close;
  return srv.url;
}

function createWindow(url: string): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Ateliê',
    backgroundColor: '#002060', // navy da marca — evita flash branco no load
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Passa url + versão ao preload (sandbox lê via process.argv).
      additionalArguments: [`--atelie-url=${url}`, `--atelie-version=${app.getVersion()}`],
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Links externos (target=_blank / window.open) abrem no navegador do sistema,
  // nunca em nova janela Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:\/\//i.test(u)) shell.openExternal(u);
    return { action: 'deny' };
  });

  void mainWindow.loadURL(url);
}

function createTray(url: string): void {
  // Ícone vazio (1x1) — MVP sem asset de marca embarcado. O menu é o que importa.
  const icon = nativeImage.createEmpty();
  try {
    tray = new Tray(icon);
  } catch {
    tray = null; // alguns ambientes Linux sem bandeja — segue sem tray
  }
  const menu = Menu.buildFromTemplate([
    {
      label: 'Abrir Ateliê',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.focus();
        } else {
          createWindow(url);
        }
      },
    },
    { label: 'Abrir no navegador', click: () => void shell.openExternal(url) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
  tray?.setToolTip('Ateliê');
  tray?.setContextMenu(menu);
}

async function bootstrap(): Promise<void> {
  serverUrl = await startLocalServer();
  // O renderer não recebe o segredo. O processo main injeta o mesmo Bearer nas
  // requisições HTTP e no handshake WebSocket destinados ao servidor local.
  if (serverToken) {
    electronSession.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: [`${serverUrl}/*`] },
      (details, callback) => callback({
        requestHeaders: { ...details.requestHeaders, Authorization: `Bearer ${serverToken}` },
      }),
    );
  }
  createWindow(serverUrl);
  createTray(serverUrl);

  // Auto-update só em produção e best-effort: sem feed publicado é no-op silencioso.
  if (app.isPackaged) {
    try {
      const { autoUpdater } = await import('electron-updater');
      await autoUpdater.checkForUpdatesAndNotify();
    } catch {
      /* sem feed / offline — ignora */
    }
  }
}

// Instância única: a 2ª invocação foca a janela existente e sai.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (serverUrl) {
      createWindow(serverUrl);
    }
  });

  app.whenReady().then(bootstrap).catch((err) => {
    console.error('Falha ao iniciar o Ateliê:', err?.stack || String(err));
    app.quit();
  });

  // macOS: recria a janela ao clicar no dock sem janelas abertas.
  app.on('activate', () => {
    if (!mainWindow && serverUrl) createWindow(serverUrl);
  });

  // Fecha o server ao sair (uma vez).
  app.on('will-quit', () => {
    if (closeServer) {
      const c = closeServer;
      closeServer = null;
      void c().catch(() => {});
    }
  });

  // Fechar todas as janelas encerra o app (exceto no macOS, convenção da plataforma).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
