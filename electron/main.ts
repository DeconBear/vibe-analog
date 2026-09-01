import { app, BrowserWindow, ipcMain, Menu, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMenu } from './menu.js';
import { registerChatHandlers } from './ipc/chat.js';
import { registerWorkflowHandlers } from './ipc/workflow.js';
import { registerFileHandlers } from './ipc/fileTools.js';
import { registerSettingsHandlers } from './ipc/settings.js';
import { registerWorkspaceHandlers } from './ipc/workspaces.js';
import { generateProjectTechnicalReport, registerProjectHandlers } from './ipc/projects.js';
import { inspectCircuitSkillStatus, registerSkillHandlers } from './ipc/skills.js';
import { closeDesktopAgentService } from './agent/desktopAgentService.js';
import { prewarmKicadSymbolWorker, stopActiveProjectTools } from './agent/circuitProjectCli.js';

let mainWindow: BrowserWindow | null = null;
let quitCleanupStarted = false;
let quitCleanupComplete = false;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function appIconPath(): string {
  // Windows taskbar/window chrome prefer .ico; other platforms use PNG.
  const fileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', fileName)
    : path.join(app.getAppPath(), 'assets', fileName);
}

function createWindow(): void {
  const iconPath = appIconPath();
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'Vibe Analog',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Ensure taskbar/dock icon updates even if the shell cached an older asset.
  if (process.platform === 'win32' || process.platform === 'linux') {
    mainWindow.setIcon(iconPath);
  }

  const menu = buildMenu(mainWindow);
  Menu.setApplicationMenu(menu);
  mainWindow.setMenuBarVisibility(false);

  // Native copy/paste context menu for selected text and editable fields
  // (chat transcript, composer). Skip empty right-clicks so canvas menus win.
  mainWindow.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = [];
    if (params.isEditable) {
      template.push(
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { role: 'selectAll' },
      );
    } else if (params.selectionText?.trim()) {
      template.push({ role: 'copy' });
    }
    if (template.length === 0 || !mainWindow) return;
    Menu.buildFromTemplate(template).popup({ window: mainWindow });
  });

  if (!app.isPackaged && process.env.ACTOVIQ_USE_BUILT_RENDERER !== '1') {
    mainWindow.loadURL(process.env.ACTOVIQ_RENDERER_URL ?? 'http://127.0.0.1:5173');
    // Opt-in only: set ACTOVIQ_DEVTOOLS=1 to open DevTools on startup.
    if (process.env.ACTOVIQ_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function registerIpcHandlers(): void {
  registerChatHandlers(ipcMain, {
    generateTechnicalReport: async ({ projectId, sourceRevision }) => (
      generateProjectTechnicalReport(projectId, sourceRevision)
    ),
  });
  registerWorkflowHandlers(ipcMain);
  registerFileHandlers(ipcMain);
  registerSettingsHandlers(ipcMain);
  registerWorkspaceHandlers(ipcMain);
  registerProjectHandlers(ipcMain);
  registerSkillHandlers(ipcMain);
}

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception in Electron main process:', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in Electron main process:', reason);
});

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.vibeanalog.app');
  }
  registerIpcHandlers();
  void prewarmKicadSymbolWorker().catch((error) => {
    console.warn('KiCad symbol worker prewarm failed:', error);
  });
  void inspectCircuitSkillStatus().catch((error) => {
    console.warn('Circuit skill version check failed:', error);
  });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  app.on('render-process-gone', (_event, _webContents, details) => {
    console.error('Renderer process gone:', details);
  });
  app.on('child-process-gone', (_event, details) => {
    console.error('Child process gone:', details);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupStarted) return;
  quitCleanupStarted = true;
  void Promise.allSettled([
    closeDesktopAgentService(),
    stopActiveProjectTools(),
  ]).finally(() => {
    quitCleanupComplete = true;
    app.quit();
  });
});
