import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { createWindowOptions } from './window-options';

function createMainWindow(): void {
  const window = new BrowserWindow(
    createWindowOptions({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDirectory: import.meta.dirname,
    }),
  );

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
