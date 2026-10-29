// @vitest-environment node

import { beforeEach, describe, expect, test, vi } from 'vitest';

const { ipcMainHandle, ipcMainRemoveHandler } = vi.hoisted(() => ({
  ipcMainHandle: vi.fn(),
  ipcMainRemoveHandler: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcMainHandle, removeHandler: ipcMainRemoveHandler },
  screen: {
    getDisplayMatching: () => ({
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
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
    getMinimumSize: vi.fn(() => [960, 640]),
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

function createScreenMock() {
  const state = {
    cursor: { x: 0, y: 0 },
    workArea: { x: 0, y: 0, width: 2194, height: 1176 },
  };
  return {
    state,
    getDisplayMatching: vi.fn((_bounds: WindowBounds) => ({
      workArea: state.workArea,
    })),
    getCursorScreenPoint: vi.fn(() => ({ ...state.cursor })),
  };
}

beforeEach(() => {
  ipcMainHandle.mockClear();
  ipcMainRemoveHandler.mockClear();
});

describe('window controls IPC', () => {
  test('registers exactly the seven whitelisted channels', () => {
    const { handlers } = createHarness();

    expect([...handlers.keys()].sort()).toEqual(
      [...WINDOW_CONTROL_CHANNELS].sort(),
    );
    expect([...WINDOW_CONTROL_CHANNELS].sort()).toEqual([
      'window:begin-resize',
      'window:close',
      'window:end-resize',
      'window:is-maximized',
      'window:minimize',
      'window:resize',
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

  test('removes all seven handlers once the window is closed', () => {
    const { windowStub } = createHarness();

    windowStub.emitClosed();

    expect(
      ipcMainRemoveHandler.mock.calls.map(([channel]) => channel).sort(),
    ).toEqual([...WINDOW_CONTROL_CHANNELS].sort());
  });
});

describe('window resize sessions', () => {
  test('rejects invalid directions and extra payload fields', async () => {
    const { invoke } = createHarness({ screen: createScreenMock() });

    await expect(
      invoke('window:begin-resize', { direction: 'diagonal' }),
    ).rejects.toThrow();
    await expect(
      invoke('window:begin-resize', { direction: 'e', speed: 2 }),
    ).rejects.toThrow();
    await expect(invoke('window:resize', { direction: '' })).rejects.toThrow();
    await expect(invoke('window:end-resize', { force: true })).rejects.toThrow();
  });

  test('rejects resize channels from a foreign webContents', async () => {
    const { invoke } = createHarness({ screen: createScreenMock() });

    for (const [channel, payload] of [
      ['window:begin-resize', { direction: 'e' }],
      ['window:resize', { direction: 'e' }],
      ['window:end-resize', {}],
    ] as const) {
      await expect(invoke(channel, payload, { id: 999 })).rejects.toThrow(
        /unauthorized|sender/i,
      );
    }
  });

  test.each([
    {
      direction: 'e',
      cursor: { x: 560, y: 410 },
      expected: { x: 120, y: 80, width: 1340, height: 820 },
    },
    {
      direction: 'w',
      cursor: { x: 560, y: 410 },
      expected: { x: 180, y: 80, width: 1220, height: 820 },
    },
    {
      direction: 'n',
      cursor: { x: 500, y: 450 },
      expected: { x: 120, y: 130, width: 1280, height: 770 },
    },
    {
      direction: 'se',
      cursor: { x: 600, y: 450 },
      expected: { x: 120, y: 80, width: 1380, height: 870 },
    },
  ])(
    'resizes from the $direction edge using physical cursor deltas',
    async ({ direction, cursor, expected }) => {
      const screen = createScreenMock();
      const { windowStub, invoke } = createHarness({ screen });

      screen.state.cursor = { x: 500, y: 400 };
      await expect(
        invoke('window:begin-resize', { direction }),
      ).resolves.toBe(true);

      screen.state.cursor = cursor;
      await expect(invoke('window:resize', { direction })).resolves.toBeUndefined();
      expect(windowStub.setBounds).toHaveBeenLastCalledWith(expected);

      await invoke('window:end-resize');
    },
  );

  test('prefers renderer-reported cursor positions over the OS cursor', async () => {
    const screen = createScreenMock();
    const { windowStub, invoke } = createHarness({ screen });

    // Synthetic input (and a frozen OS cursor) still resizes when the
    // renderer reports its own pointer coordinates in screen DIPs.
    await expect(
      invoke('window:begin-resize', {
        direction: 'se',
        cursor: { x: 500, y: 400 },
      }),
    ).resolves.toBe(true);

    await invoke('window:resize', {
      direction: 'se',
      cursor: { x: 545, y: 445 },
    });
    expect(windowStub.setBounds).toHaveBeenLastCalledWith({
      x: 120,
      y: 80,
      width: 1325,
      height: 865,
    });
    expect(screen.getCursorScreenPoint).not.toHaveBeenCalled();

    await invoke('window:end-resize');
  });

  test('clamps the west edge to the minimum width and anchors the right edge', async () => {
    const screen = createScreenMock();
    const { windowStub, invoke } = createHarness({ screen });

    screen.state.cursor = { x: 500, y: 400 };
    await invoke('window:begin-resize', { direction: 'w' });

    // Dragging 500px right would shrink 1280 below the 960 minimum.
    screen.state.cursor = { x: 1000, y: 400 };
    await invoke('window:resize', { direction: 'w' });

    expect(windowStub.setBounds).toHaveBeenLastCalledWith({
      x: 440,
      y: 80,
      width: 960,
      height: 820,
    });
    // Right edge stays at 120 + 1280 = 1400.
    expect(440 + 960).toBe(1400);
  });

  test('clamps the north edge to the minimum height and anchors the bottom edge', async () => {
    const screen = createScreenMock();
    const { windowStub, invoke } = createHarness({ screen });

    screen.state.cursor = { x: 500, y: 400 };
    await invoke('window:begin-resize', { direction: 'n' });

    screen.state.cursor = { x: 500, y: 700 };
    await invoke('window:resize', { direction: 'n' });

    expect(windowStub.setBounds).toHaveBeenLastCalledWith({
      x: 120,
      y: 260,
      width: 1280,
      height: 640,
    });
    // Bottom edge stays at 80 + 820 = 900.
    expect(260 + 640).toBe(900);
  });

  test('refuses to begin a resize while maximized', async () => {
    const screen = createScreenMock();
    const { invoke } = createHarness({ screen });

    await invoke('window:toggle-maximize');
    await expect(
      invoke('window:begin-resize', { direction: 'se' }),
    ).resolves.toBe(false);
  });

  test('refuses a second session and frees the session on end-resize', async () => {
    const screen = createScreenMock();
    const { invoke } = createHarness({ screen });

    await expect(
      invoke('window:begin-resize', { direction: 'e' }),
    ).resolves.toBe(true);
    await expect(
      invoke('window:begin-resize', { direction: 'w' }),
    ).resolves.toBe(false);

    await invoke('window:end-resize');
    await expect(
      invoke('window:begin-resize', { direction: 'w' }),
    ).resolves.toBe(true);
  });

  test('resize without an active session is a no-op', async () => {
    const screen = createScreenMock();
    const { windowStub, invoke } = createHarness({ screen });

    await expect(
      invoke('window:resize', { direction: 'e' }),
    ).resolves.toBeUndefined();
    expect(windowStub.setBounds).not.toHaveBeenCalled();
  });

  test('clears the session when the window is closed', async () => {
    const screen = createScreenMock();
    const { windowStub, invoke } = createHarness({ screen });

    await invoke('window:begin-resize', { direction: 'e' });
    windowStub.emitClosed();

    expect(
      ipcMainRemoveHandler.mock.calls.map(([channel]) => channel).sort(),
    ).toEqual([...WINDOW_CONTROL_CHANNELS].sort());
  });
});

describe('transparent window work-area maximization', () => {
  const screen = createScreenMock();
  const workArea = screen.state.workArea;
  const options: WindowControlsOptions = { transparent: true, screen };

  beforeEach(() => {
    screen.getDisplayMatching.mockClear();
    screen.getDisplayMatching.mockImplementation((_bounds: WindowBounds) => ({
      workArea: screen.state.workArea,
    }));
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

  test('maximizes on the display that currently hosts the window', async () => {
    const primaryWorkArea = { x: 0, y: 0, width: 1920, height: 1040 };
    const secondaryWorkArea = { x: 1920, y: 0, width: 2560, height: 1400 };
    screen.getDisplayMatching.mockImplementation((bounds: WindowBounds) => ({
      workArea:
        bounds.x >= 1920 ? secondaryWorkArea : primaryWorkArea,
    }));
    const { windowStub, invoke } = createHarness(options);

    // Park the window on the secondary display before maximizing.
    windowStub.setBounds({ x: 2000, y: 100, width: 1280, height: 820 });
    windowStub.setBounds.mockClear();

    await expect(invoke('window:toggle-maximize')).resolves.toBe(true);
    expect(screen.getDisplayMatching).toHaveBeenCalledWith({
      x: 2000,
      y: 100,
      width: 1280,
      height: 820,
    });
    expect(windowStub.setBounds).toHaveBeenLastCalledWith(secondaryWorkArea);

    // Restoring still returns to the saved bounds on that display.
    await expect(invoke('window:toggle-maximize')).resolves.toBe(false);
    expect(windowStub.setBounds).toHaveBeenLastCalledWith({
      x: 2000,
      y: 100,
      width: 1280,
      height: 820,
    });
  });

  test('toggle-maximize drops an in-flight resize session', async () => {
    const { windowStub, invoke } = createHarness(options);

    await expect(
      invoke('window:begin-resize', {
        direction: 'se',
        cursor: { x: 500, y: 400 },
      }),
    ).resolves.toBe(true);

    // Maximizing mid-drag must not leave a stale session behind.
    await expect(invoke('window:toggle-maximize')).resolves.toBe(true);
    windowStub.setBounds.mockClear();

    await invoke('window:resize', {
      direction: 'se',
      cursor: { x: 900, y: 900 },
    });
    expect(windowStub.setBounds).not.toHaveBeenCalled();

    // After restoring, a fresh drag starts cleanly from current bounds.
    await invoke('window:toggle-maximize');
    await expect(
      invoke('window:begin-resize', {
        direction: 'se',
        cursor: { x: 500, y: 400 },
      }),
    ).resolves.toBe(true);
    await invoke('window:end-resize');
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
