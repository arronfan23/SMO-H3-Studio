import { ipcMain, screen as electronScreen } from 'electron';
import { z } from 'zod';
import {
  WINDOW_RESIZE_DIRECTIONS,
  type WindowResizeDirection,
} from '../shared/ipc';

export const WINDOW_CONTROL_CHANNELS = [
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'window:is-maximized',
  'window:begin-resize',
  'window:resize',
  'window:end-resize',
] as const;

type WindowControlChannel = (typeof WINDOW_CONTROL_CHANNELS)[number];

export interface WindowPoint {
  x: number;
  y: number;
}

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
  getMinimumSize(): number[];
  once(event: 'closed', listener: () => void): unknown;
}

export interface WindowControlsScreen {
  getDisplayMatching(rect: WindowBounds): { workArea: WindowBounds };
  getCursorScreenPoint(): WindowPoint;
}

export interface WindowControlsOptions {
  transparent?: boolean;
  screen?: WindowControlsScreen;
}

const emptyPayload = z.object({}).strict();
const resizePayload = z
  .object({
    direction: z.enum(WINDOW_RESIZE_DIRECTIONS),
    // Renderer-reported pointer position in screen DIPs (same coordinate
    // space as window bounds). Synthetic input never moves the OS cursor,
    // so prefer this over screen.getCursorScreenPoint() when present.
    cursor: z.object({ x: z.number(), y: z.number() }).strict().optional(),
  })
  .strict();

interface ResizeSession {
  direction: WindowResizeDirection;
  startCursor: WindowPoint;
  startBounds: WindowBounds;
}

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
  let resizeSession: ResizeSession | null = null;

  const isMaximized = (): boolean =>
    useWorkAreaMaximize ? customMaximized : window.isMaximized();

  const toggleMaximize = (): boolean => {
    // A stale drag session would keep resizing the (un)maximized window.
    resizeSession = null;
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
      // Maximize on the monitor that currently hosts the window.
      window.setBounds(screen.getDisplayMatching(savedBounds).workArea);
      customMaximized = true;
    }
    return customMaximized;
  };

  const register = <P>(
    channel: WindowControlChannel,
    schema: z.ZodType<P>,
    action: (payload: P) => unknown,
  ): void => {
    ipcMain.handle(channel, (event, rawPayload: unknown) => {
      if (event.sender !== window.webContents) {
        throw new Error(`Rejected ${channel} from an unauthorized sender`);
      }
      const payload = schema.parse(rawPayload);
      if (window.isDestroyed()) {
        throw new Error('Window is already destroyed');
      }
      return action(payload);
    });
  };

  register('window:minimize', emptyPayload, () => window.minimize());
  register('window:toggle-maximize', emptyPayload, toggleMaximize);
  register('window:close', emptyPayload, () => window.close());
  register('window:is-maximized', emptyPayload, isMaximized);

  register('window:begin-resize', resizePayload, ({ direction, cursor }) => {
    if (resizeSession !== null || isMaximized()) {
      return false;
    }
    resizeSession = {
      direction,
      startCursor: cursor ?? screen.getCursorScreenPoint(),
      startBounds: window.getBounds(),
    };
    return true;
  });

  register('window:resize', resizePayload, ({ cursor }) => {
    if (resizeSession === null) {
      return undefined;
    }
    const point = cursor ?? screen.getCursorScreenPoint();
    const dx = point.x - resizeSession.startCursor.x;
    const dy = point.y - resizeSession.startCursor.y;
    const [minWidth, minHeight] = window.getMinimumSize();
    const start = resizeSession.startBounds;
    const next: WindowBounds = { ...start };
    const direction = resizeSession.direction;
    if (direction.includes('e')) {
      next.width = Math.max(minWidth, start.width + dx);
    }
    if (direction.includes('s')) {
      next.height = Math.max(minHeight, start.height + dy);
    }
    if (direction.includes('w')) {
      // Anchor the right edge: width clamps first, then x follows.
      next.width = Math.max(minWidth, start.width - dx);
      next.x = start.x + (start.width - next.width);
    }
    if (direction.includes('n')) {
      next.height = Math.max(minHeight, start.height - dy);
      next.y = start.y + (start.height - next.height);
    }
    window.setBounds(next);
    return undefined;
  });

  register('window:end-resize', emptyPayload, () => {
    resizeSession = null;
  });

  window.once('closed', () => {
    customMaximized = false;
    savedBounds = null;
    resizeSession = null;
    for (const channel of WINDOW_CONTROL_CHANNELS) {
      ipcMain.removeHandler(channel);
    }
  });
}
