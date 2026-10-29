// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { ipcMainHandle, ipcMainRemoveHandler } = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  ipcMainRemoveHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandle, removeHandler: ipcMainRemoveHandler },
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));

import {
  registerWindowControls,
  WINDOW_CONTROL_CHANNELS,
  type WindowBounds,
  type WindowControlsOptions,
} from '../../src/main/window-controls';

type IpcHandler = (event: { sender: unknown }, payload: unknown) => unknown;

function createWindowStub() {
  const listeners = new Map<string, Array<() => void>>();
  const state = {
    maximized: false,
    destroyed: false,
    bounds: { x: 120, y: 80, width: 1280, height: 820 } as WindowBounds,
  };
  const webContents = { id: 1 };
  return {
    webContents,
    minimize: vi.fn(),
    maximize: vi.fn(() => {
      state.maximized = true;
    }),
    unmaximize: vi.fn(() => {
      state.maximized = false;
    }),
    close: vi.fn(),
    isMaximized: vi.fn(() => state.maximized),
    isDestroyed: vi.fn(() => state.destroyed),
    getBounds: vi.fn(() => ({ ...state.bounds })),
    setBounds: vi.fn((bounds: WindowBounds) => {
      state.bounds = { ...bounds };
    }),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    }),
    emitClosed() {
      state.destroyed = true;
      for (const listener of listeners.get('closed') ?? []) {
        listener();
      }
    },
  };
}

function createHarness(options: WindowControlsOptions = {}) {
  const windowStub = createWindowStub();
  registerWindowControls(windowStub, options);
  const handlers = new Map<string, IpcHandler>(
    ipcMainHandle.mock.calls.map(([channel, handler]) => [
      channel as string,
      handler as IpcHandler,
    ]),
  );
  const invoke = async (
    channel: string,
    payload: unknown = {},
    sender: unknown = windowStub.webContents,
  ): Promise<unknown> => {
    const handler = handlers.get(channel);
    expect(handler, `handler for ${channel}`).toBeDefined();
    return handler!({ sender }, payload);
  };
  return { windowStub, handlers, invoke };
}

beforeEach(() => {
  ipcMainHandle.mockClear();
  ipcMainRemoveHandler.mockClear();
});

describe('window controls IPC', () => {
  test('registers exactly the four whitelisted channels', () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()].sort()).toEqual(
      [...WINDOW_CONTROL_CHANNELS].sort(),
    );
    expect([...WINDOW_CONTROL_CHANNELS].sort()).toEqual([
      'window:close',
      'window:is-maximized',
      'window:minimize',
      'window:toggle-maximize',
    ]);
  });

  test.each([
    'window:minimize',
    'window:toggle-maximize',
    'window:close',
    'window:is-maximized',
  ])('rejects %s from a foreign webContents', async (channel) => {
    const { invoke } = createHarness();

    await expect(invoke(channel, {}, { id: 999 })).rejects.toThrow(
      /unauthorized|sender/i,
    );
  });

  test.each([
    'window:minimize',
    'window:toggle-maximize',
    'window:close',
    'window:is-maximized',
  ])('rejects %s with extra payload fields', async (channel) => {
    const { invoke } = createHarness();

    await expect(invoke(channel, { shell: true })).rejects.toThrow();
  });

  test('minimize, close, and isMaximized call the BrowserWindow methods', async () => {
    const { windowStub, invoke } = createHarness();

    await expect(invoke('window:minimize')).resolves.toBeUndefined();
    expect(windowStub.minimize).toHaveBeenCalledTimes(1);

    await expect(invoke('window:is-maximized')).resolves.toBe(false);
    expect(windowStub.isMaximized).toHaveBeenCalled();

    await expect(invoke('window:close')).resolves.toBeUndefined();
    expect(windowStub.close).toHaveBeenCalledTimes(1);
  });

  test('toggle-maximize flips the window and returns the latest state', async () => {
    const { windowStub, invoke } = createHarness();

    await expect(invoke('window:toggle-maximize')).resolves.toBe(true);
    expect(windowStub.maximize).toHaveBeenCalledTimes(1);
    expect(windowStub.unmaximize).not.toHaveBeenCalled();

    await expect(invoke('window:toggle-maximize')).resolves.toBe(false);
    expect(windowStub.unmaximize).toHaveBeenCalledTimes(1);
  });

  test('uses native maximize for a non-transparent window', async () => {
    const { windowStub, invoke } = createHarness({ transparent: false });

    await expect(invoke('window:toggle-maximize')).resolves.toBe(true);
    expect(windowStub.maximize).toHaveBeenCalledTimes(1);
    expect(windowStub.setBounds).not.toHaveBeenCalled();

    await expect(invoke('window:is-maximized')).resolves.toBe(true);

    await expect(invoke('window:toggle-maximize')).resolves.toBe(false);
    expect(windowStub.unmaximize).toHaveBeenCalledTimes(1);
    expect(windowStub.setBounds).not.toHaveBeenCalled();
  });

  test('removes all four handlers once the window is closed', () => {
    const { windowStub } = createHarness();

    windowStub.emitClosed();

    expect(
      ipcMainRemoveHandler.mock.calls.map(([channel]) => channel).sort(),
    ).toEqual([...WINDOW_CONTROL_CHANNELS].sort());
  });
});

describe('transparent window work-area maximization', () => {
  const workArea: WindowBounds = { x: 0, y: 0, width: 2194, height: 1176 };
  const screen = { getPrimaryDisplay: vi.fn(() => ({ workArea })) };
  const options: WindowControlsOptions = { transparent: true, screen };

  beforeEach(() => {
    screen.getPrimaryDisplay.mockClear();
  });

  test('maximizes to the work area without calling native maximize', async () => {
    const { windowStub, invoke } = createHarness(options);

    await expect(invoke('window:toggle-maximize')).resolves.toBe(true);
    expect(windowStub.maximize).not.toHaveBeenCalled();
    expect(windowStub.unmaximize).not.toHaveBeenCalled();
    expect(windowStub.setBounds).toHaveBeenCalledTimes(1);
    expect(windowStub.setBounds).toHaveBeenLastCalledWith(workArea);

    await expect(invoke('window:is-maximized')).resolves.toBe(true);
    expect(windowStub.isMaximized).not.toHaveBeenCalled();
  });

  test('restores the saved bounds on the second toggle', async () => {
    const { windowStub, invoke } = createHarness(options);
    const originalBounds = windowStub.getBounds();

    await invoke('window:toggle-maximize');
    await expect(invoke('window:toggle-maximize')).resolves.toBe(false);

    expect(windowStub.setBounds).toHaveBeenCalledTimes(2);
    expect(windowStub.setBounds).toHaveBeenNthCalledWith(1, workArea);
    expect(windowStub.setBounds).toHaveBeenNthCalledWith(2, originalBounds);
    expect(windowStub.getBounds()).toEqual(originalBounds);

    await expect(invoke('window:is-maximized')).resolves.toBe(false);
  });

  test('saves fresh bounds on every maximize cycle', async () => {
    const { windowStub, invoke } = createHarness(options);

    await invoke('window:toggle-maximize');
    await invoke('window:toggle-maximize');
    const movedBounds: WindowBounds = { x: 40, y: 30, width: 960, height: 640 };
    windowStub.setBounds(movedBounds);
    windowStub.setBounds.mockClear();

    await invoke('window:toggle-maximize');
    await invoke('window:toggle-maximize');

    expect(windowStub.setBounds).toHaveBeenNthCalledWith(2, movedBounds);
  });

  test('still rejects foreign senders and strict-violating payloads', async () => {
    const { invoke } = createHarness(options);

    await expect(
      invoke('window:toggle-maximize', {}, { id: 999 }),
    ).rejects.toThrow(/unauthorized|sender/i);
    await expect(
      invoke('window:is-maximized', { extra: true }),
    ).rejects.toThrow();
  });
});
