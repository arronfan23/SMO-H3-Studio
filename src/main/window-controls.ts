import { ipcMain } from 'electron';
import { z } from 'zod';

export const WINDOW_CONTROL_CHANNELS = [
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'window:is-maximized',
] as const;

type WindowControlChannel = (typeof WINDOW_CONTROL_CHANNELS)[number];

// Structural subset of BrowserWindow so unit tests can drive a plain stub.
export interface WindowControlsTarget {
  readonly webContents: unknown;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
  isMaximized(): boolean;
  isDestroyed(): boolean;
  once(event: 'closed', listener: () => void): unknown;
}

const emptyPayload = z.object({}).strict();

export function registerWindowControls(window: WindowControlsTarget): void {
  const register = (
    channel: WindowControlChannel,
    action: () => unknown,
  ): void => {
    ipcMain.handle(channel, (event, payload: unknown) => {
      if (event.sender !== window.webContents) {
        throw new Error(`Rejected ${channel} from an unauthorized sender`);
      }
      emptyPayload.parse(payload);
      if (window.isDestroyed()) {
        throw new Error('Window is already destroyed');
      }
      return action();
    });
  };

  register('window:minimize', () => window.minimize());
  register('window:toggle-maximize', () => {
    if (window.isMaximized()) {
      window.unmaximize();
    } else {
      window.maximize();
    }
    return window.isMaximized();
  });
  register('window:close', () => window.close());
  register('window:is-maximized', () => window.isMaximized());

  window.once('closed', () => {
    for (const channel of WINDOW_CONTROL_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  });
}
