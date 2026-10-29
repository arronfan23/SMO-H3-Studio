import { ipcMain, screen as electronScreen } from 'electron';
import { z } from 'zod';

export const WINDOW_CONTROL_CHANNELS = [
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'window:is-maximized',
] as const;

type WindowControlChannel = (typeof WINDOW_CONTROL_CHANNELS)[number];

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Structural subset of BrowserWindow so unit tests can drive a plain stub.
export interface WindowControlsTarget {
  readonly webContents: unknown;
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  close(): void;
  isMaximized(): boolean;
  isDestroyed(): boolean;
  getBounds(): WindowBounds;
  setBounds(bounds: WindowBounds): void;
  once(event: 'closed', listener: () => void): unknown;
}

export interface WindowControlsScreen {
  getPrimaryDisplay(): { workArea: WindowBounds };
}

export interface WindowControlsOptions {
  transparent?: boolean;
  screen?: WindowControlsScreen;
}

const emptyPayload = z.object({}).strict();

export function registerWindowControls(
  window: WindowControlsTarget,
  options: WindowControlsOptions = {},
): void {
  // Windows cannot maximize a transparent (layered) window natively: IsZoomed
  // always reports false and the window spills over the taskbar. Track the
  // maximized state app-side and resize to the work area instead.
  const useWorkAreaMaximize =
    process.platform === 'win32' && options.transparent === true;
  const screen = options.screen ?? electronScreen;
  let customMaximized = false;
  let savedBounds: WindowBounds | null = null;

  const isMaximized = (): boolean =>
    useWorkAreaMaximize ? customMaximized : window.isMaximized();

  const toggleMaximize = (): boolean => {
    if (!useWorkAreaMaximize) {
      if (window.isMaximized()) {
        window.unmaximize();
      } else {
        window.maximize();
      }
      return window.isMaximized();
    }
    if (customMaximized) {
      if (savedBounds !== null) {
        window.setBounds(savedBounds);
        savedBounds = null;
      }
      customMaximized = false;
    } else {
      savedBounds = window.getBounds();
      window.setBounds(screen.getPrimaryDisplay().workArea);
      customMaximized = true;
    }
    return customMaximized;
  };

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
  register('window:toggle-maximize', toggleMaximize);
  register('window:close', () => window.close());
  register('window:is-maximized', isMaximized);

  window.once('closed', () => {
    customMaximized = false;
    savedBounds = null;
    for (const channel of WINDOW_CONTROL_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  });
}
