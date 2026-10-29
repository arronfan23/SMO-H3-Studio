// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { ipcMainHandle, ipcMainRemoveHandler } = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  ipcMainRemoveHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandle, removeHandler: ipcMainRemoveHandler },
}));

import {
  registerWindowControls,
  WINDOW_CONTROL_CHANNELS,
} from '../../src/main/window-controls';

type IpcHandler = (event: { sender: unknown }, payload: unknown) => unknown;

function createWindowStub() {
  const listeners = new Map<string, Array<() => void>>();
  const state = { maximized: false, destroyed: false };
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

function createHarness() {
  const windowStub = createWindowStub();
  registerWindowControls(windowStub);
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

  test('removes all four handlers once the window is closed', () => {
    const { windowStub } = createHarness();

    windowStub.emitClosed();

    expect(
      ipcMainRemoveHandler.mock.calls.map(([channel]) => channel).sort(),
    ).toEqual([...WINDOW_CONTROL_CHANNELS].sort());
  });
});
