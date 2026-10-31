import { app, BrowserWindow, dialog, Menu, protocol, Tray } from 'electron';
import { bootstrapApplication } from './bootstrap';
import { registerPrivilegedMediaScheme } from './media';
import {
  createRendererLoadFailureMessage,
  loadRenderer,
  selectRendererTarget,
} from './renderer';
import { createWindowOptions } from './window-options';
import { registerWindowControls } from './window-controls';
import { createTrayController, type TrayController } from './tray';

registerPrivilegedMediaScheme(protocol);

let mainWindow: BrowserWindow | undefined;
let trayController: TrayController | undefined;
let tray: Tray | undefined;

function getWindowOptions() {
  return createWindowOptions({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    moduleDirectory: import.meta.dirname,
  });
}

function reportRendererLoadFailure(error: unknown): void {
  console.error('[SMO.H3 Studio] 界面加载失败', error);
  dialog.showErrorBox(
    'SMO.H3 Studio 启动失败',
    createRendererLoadFailureMessage(error),
  );
}

async function createMainWindow(): Promise<BrowserWindow> {
  const window = new BrowserWindow(getWindowOptions());
  mainWindow = window;
  registerWindowControls(window, { transparent: true });

  const target = selectRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    moduleDirectory: import.meta.dirname,
  });
  await loadRenderer(window, target, reportRendererLoadFailure);
  return window;
}

void app
  .whenReady()
  .then(async () => {
    const services = await bootstrapApplication({
      createMainWindow: async () => {
        await createMainWindow();
      },
    });
    const menu = Menu.buildFromTemplate([
      {
        label: '打开SMO.H3 Studio',
        click: () => {
          void trayController?.open().catch(reportRendererLoadFailure);
        },
      },
      {
        label: '退出程序',
        click: () => trayController?.quit(),
      },
    ]);
    tray = new Tray(getWindowOptions().icon!);
    tray.setToolTip('SMO.H3 Studio');
    trayController = createTrayController({
      window: mainWindow!,
      tray,
      menu,
      createWindow: createMainWindow,
      onQuit: () => app.quit(),
      onError: reportRendererLoadFailure,
    });

    let isQuitting = false;
    app.on('before-quit', (event) => {
      trayController?.handleBeforeQuit();
      if (isQuitting) {
        return;
      }
      event.preventDefault();
      isQuitting = true;
      void services.close().finally(() => app.quit());
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        const opening =
          trayController?.open() ?? createMainWindow().then(() => undefined);
        void opening.catch(reportRendererLoadFailure);
      }
    });
  })
  .catch(reportRendererLoadFailure);

app.on('window-all-closed', () => {
  trayController?.handleWindowAllClosed();
});
