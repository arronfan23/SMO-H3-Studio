import type { Menu } from 'electron';

export interface TrayCloseEvent {
  preventDefault(): void;
}

export interface TrayWindow {
  on(event: 'close', listener: (event: TrayCloseEvent) => void): unknown;
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
}

export interface TrayLike {
  on(event: 'click', listener: () => void): unknown;
  setContextMenu(menu: Menu): void;
}

export interface TrayControllerOptions {
  window: TrayWindow;
  tray: TrayLike;
  menu: Menu;
  createWindow: () => Promise<TrayWindow>;
  onQuit: () => void;
  onError: (error: unknown) => void;
}

export interface TrayController {
  open(): Promise<void>;
  quit(): void;
  handleBeforeQuit(): void;
  handleWindowAllClosed(): void;
}

export function createTrayController({
  window,
  tray,
  menu,
  createWindow,
  onQuit,
  onError,
}: TrayControllerOptions): TrayController {
  let currentWindow = window;
  let isQuitting = false;
  let quitRequested = false;

  const handleClose = (event: TrayCloseEvent): void => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    currentWindow.hide();
  };

  const attachWindow = (target: TrayWindow): void => {
    target.on('close', handleClose);
  };

  const open = async (): Promise<void> => {
    if (currentWindow.isDestroyed()) {
      currentWindow = await createWindow();
      attachWindow(currentWindow);
    }
    currentWindow.show();
    currentWindow.focus();
  };

  const handleBeforeQuit = (): void => {
    isQuitting = true;
  };

  const quit = (): void => {
    if (quitRequested) {
      return;
    }
    quitRequested = true;
    handleBeforeQuit();
    onQuit();
  };

  attachWindow(currentWindow);
  tray.on('click', () => open().catch(onError));
  tray.setContextMenu(menu);

  return {
    open,
    quit,
    handleBeforeQuit,
    handleWindowAllClosed: () => {
      // Registering a listener prevents Electron's default app.quit().
    },
  };
}
