import { app, BrowserWindow, dialog } from 'electron';
import {
  createRendererLoadFailureMessage,
  loadRenderer,
  selectRendererTarget,
} from './renderer';
import { createWindowOptions } from './window-options';

function reportRendererLoadFailure(error: unknown): void {
  console.error('[SMO.H3 Studio] 界面加载失败', error);
  dialog.showErrorBox(
    'SMO.H3 Studio 启动失败',
    createRendererLoadFailureMessage(error),
  );
}

async function createMainWindow(): Promise<void> {
  const window = new BrowserWindow(
    createWindowOptions({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDirectory: import.meta.dirname,
    }),
  );

  const target = selectRendererTarget({
    isPackaged: app.isPackaged,
    rendererUrl: process.env.ELECTRON_RENDERER_URL,
    moduleDirectory: import.meta.dirname,
  });
  await loadRenderer(window, target, reportRendererLoadFailure);
}

void app
  .whenReady()
  .then(() => {
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createMainWindow().catch(reportRendererLoadFailure);
      }
    });

    return createMainWindow();
  })
  .catch(reportRendererLoadFailure);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
