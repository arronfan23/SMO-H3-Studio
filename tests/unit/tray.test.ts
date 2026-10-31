// @vitest-environment node

import type { Menu } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import {
  createTrayController,
  type TrayLike,
} from '../../src/main/tray';

function createWindowStub() {
  const state = { destroyed: false };
  const closeListeners: Array<(event: { preventDefault(): void }) => void> = [];

  return {
    isDestroyed: vi.fn(() => state.destroyed),
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    on: vi.fn(
      (
        event: 'close',
        listener: (event: { preventDefault(): void }) => void,
      ) => {
        if (event === 'close') {
          closeListeners.push(listener);
        }
      },
    ),
    destroy() {
      state.destroyed = true;
    },
    emitClose() {
      const event = { preventDefault: vi.fn() };
      for (const listener of closeListeners) {
        listener(event);
      }
      return event;
    },
  };
}

type WindowStub = ReturnType<typeof createWindowStub>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createHarness({ onQuit = vi.fn() }: { onQuit?: () => void } = {}) {
  const window = createWindowStub();
  const replacementWindow = createWindowStub();
  let clickListener: () => void = () => undefined;
  const tray: TrayLike = {
    on: vi.fn((event: 'click', listener: () => void) => {
      if (event === 'click') {
        clickListener = listener;
      }
    }),
    setContextMenu: vi.fn(),
  };
  const createWindow = vi.fn(async () => replacementWindow);
  const onError = vi.fn();
  const controller = createTrayController({
    window,
    tray,
    menu: {} as Menu,
    createWindow,
    onQuit,
    onError,
  });

  return {
    window,
    replacementWindow,
    controller,
    createWindow,
    onQuit,
    onError,
    clickTray: async () => clickListener(),
  };
}

describe('tray lifecycle', () => {
  test('closing the window hides it without quitting or stopping services', () => {
    const { window, onQuit, createWindow } = createHarness();

    const event = window.emitClose();

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(window.hide).toHaveBeenCalledTimes(1);
    expect(onQuit).not.toHaveBeenCalled();
    expect(createWindow).not.toHaveBeenCalled();
  });

  test.each(['tray click', 'open command'] as const)(
    'restores the existing window from %s',
    async (action) => {
      const { window, controller, createWindow, clickTray } = createHarness();

      if (action === 'tray click') {
        await clickTray();
      } else {
        await controller.open();
      }

      expect(window.show).toHaveBeenCalledTimes(1);
      expect(window.focus).toHaveBeenCalledTimes(1);
      expect(createWindow).not.toHaveBeenCalled();
    },
  );

  test('creates and attaches to a new window when the old one is destroyed', async () => {
    const {
      window,
      replacementWindow,
      createWindow,
      clickTray,
    } = createHarness();
    window.destroy();

    await clickTray();

    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(replacementWindow.show).toHaveBeenCalledTimes(1);
    expect(replacementWindow.focus).toHaveBeenCalledTimes(1);
    const event = replacementWindow.emitClose();
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(replacementWindow.hide).toHaveBeenCalledTimes(1);
  });

  test('shares one window creation across concurrent open commands', async () => {
    const {
      window,
      replacementWindow,
      controller,
      createWindow,
    } = createHarness();
    const creation = createDeferred<WindowStub>();
    createWindow.mockReturnValue(creation.promise);
    window.destroy();

    const first = controller.open();
    const second = controller.open();

    expect(second).toBe(first);
    expect(createWindow).toHaveBeenCalledTimes(1);
    creation.resolve(replacementWindow);
    await Promise.all([first, second]);
    expect(replacementWindow.show).toHaveBeenCalledTimes(1);
  });

  test('shares one window creation across tray and menu open commands', async () => {
    const {
      window,
      replacementWindow,
      controller,
      createWindow,
      clickTray,
    } = createHarness();
    const creation = createDeferred<WindowStub>();
    createWindow.mockReturnValue(creation.promise);
    window.destroy();

    const fromTray = clickTray();
    const fromMenu = controller.open();

    expect(createWindow).toHaveBeenCalledTimes(1);
    creation.resolve(replacementWindow);
    await Promise.all([fromTray, fromMenu]);
    expect(replacementWindow.show).toHaveBeenCalledTimes(1);
  });

  test('retries window creation after a failed open', async () => {
    const {
      window,
      replacementWindow,
      controller,
      createWindow,
    } = createHarness();
    const failure = new Error('window creation failed');
    createWindow
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(replacementWindow);
    window.destroy();

    await expect(controller.open()).rejects.toBe(failure);
    await controller.open();

    expect(createWindow).toHaveBeenCalledTimes(2);
    expect(replacementWindow.show).toHaveBeenCalledTimes(1);
    expect(replacementWindow.focus).toHaveBeenCalledTimes(1);
  });

  test('does not show or reopen a window when quit happens during creation', async () => {
    const {
      window,
      replacementWindow,
      controller,
      createWindow,
      onQuit,
    } = createHarness();
    const creation = createDeferred<WindowStub>();
    createWindow.mockReturnValue(creation.promise);
    window.destroy();

    const opening = controller.open();
    controller.quit();
    creation.resolve(replacementWindow);
    await opening;
    await controller.open();

    expect(onQuit).toHaveBeenCalledTimes(1);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(replacementWindow.show).not.toHaveBeenCalled();
    expect(replacementWindow.focus).not.toHaveBeenCalled();
  });

  test('does not show or attach to a recreated window that is already destroyed', async () => {
    const {
      window,
      replacementWindow,
      controller,
      createWindow,
    } = createHarness();
    const creation = createDeferred<WindowStub>();
    createWindow.mockReturnValue(creation.promise);
    window.destroy();
    replacementWindow.destroy();

    const opening = controller.open();
    creation.resolve(replacementWindow);
    await opening;

    expect(replacementWindow.on).not.toHaveBeenCalled();
    expect(replacementWindow.show).not.toHaveBeenCalled();
    expect(replacementWindow.focus).not.toHaveBeenCalled();
  });

  test('requests quit only once across repeated exit commands', () => {
    const { controller, onQuit } = createHarness();

    controller.quit();
    controller.quit();

    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  test('does not quit directly when all windows are closed', () => {
    const { controller, onQuit } = createHarness();

    controller.handleWindowAllClosed();

    expect(onQuit).not.toHaveBeenCalled();
  });

  test('before-quit permits window closure without requesting another quit', () => {
    const { window, controller, onQuit } = createHarness();

    controller.handleBeforeQuit();
    controller.handleBeforeQuit();
    const event = window.emitClose();

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(window.hide).not.toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

});

describe('main process quit wiring', () => {
  test('index before-quit closes services once and quits after cleanup', async () => {
    vi.resetModules();
    const listeners = new Map<
      string,
      Array<(event: { preventDefault(): void }) => void>
    >();
    const sequence: string[] = [];
    const closing = createDeferred<void>();
    const close = vi.fn(() => {
      sequence.push('close:start');
      return closing.promise;
    });
    const app = {
      isPackaged: false,
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn(
        (
          event: string,
          listener: (event: { preventDefault(): void }) => void,
        ) => {
          listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        },
      ),
      quit: vi.fn(() => {
        sequence.push('quit');
      }),
    };
    const allWindows: unknown[] = [];
    class BrowserWindowMock {
      static getAllWindows = vi.fn(() => allWindows);

      constructor() {
        Object.assign(this, createWindowStub());
        allWindows.push(this);
      }
    }
    class TrayMock {
      on = vi.fn();
      setContextMenu = vi.fn();
      setToolTip = vi.fn();
    }

    try {
      vi.doMock('electron', () => ({
        app,
        BrowserWindow: BrowserWindowMock,
        dialog: { showErrorBox: vi.fn() },
        Menu: { buildFromTemplate: vi.fn(() => ({})) },
        protocol: {},
        Tray: TrayMock,
      }));
      vi.doMock('../../src/main/bootstrap', () => ({
        bootstrapApplication: vi.fn(
          async ({ createMainWindow }: { createMainWindow: () => Promise<void> }) => {
            await createMainWindow();
            return { close };
          },
        ),
      }));
      vi.doMock('../../src/main/media', () => ({
        registerPrivilegedMediaScheme: vi.fn(),
      }));
      vi.doMock('../../src/main/renderer', () => ({
        createRendererLoadFailureMessage: vi.fn(() => 'renderer failed'),
        loadRenderer: vi.fn(async () => undefined),
        selectRendererTarget: vi.fn(() => ({})),
      }));
      vi.doMock('../../src/main/window-options', () => ({
        createWindowOptions: vi.fn(() => ({ icon: 'smo.ico' })),
      }));
      vi.doMock('../../src/main/window-controls', () => ({
        registerWindowControls: vi.fn(),
      }));

      await import('../../src/main/index');
      await vi.waitFor(() => {
        expect(listeners.get('before-quit')).toHaveLength(1);
      });
      const beforeQuit = listeners.get('before-quit')![0];
      const firstEvent = { preventDefault: vi.fn() };
      const repeatedEvent = { preventDefault: vi.fn() };

      beforeQuit(firstEvent);
      beforeQuit(repeatedEvent);

      expect(firstEvent.preventDefault).toHaveBeenCalledTimes(1);
      expect(repeatedEvent.preventDefault).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(app.quit).not.toHaveBeenCalled();

      sequence.push('close:finish');
      closing.resolve(undefined);
      await vi.waitFor(() => {
        expect(app.quit).toHaveBeenCalledTimes(1);
      });
      beforeQuit({ preventDefault: vi.fn() });

      expect(close).toHaveBeenCalledTimes(1);
      expect(sequence).toEqual(['close:start', 'close:finish', 'quit']);
    } finally {
      vi.doUnmock('electron');
      vi.doUnmock('../../src/main/bootstrap');
      vi.doUnmock('../../src/main/media');
      vi.doUnmock('../../src/main/renderer');
      vi.doUnmock('../../src/main/window-options');
      vi.doUnmock('../../src/main/window-controls');
      vi.resetModules();
    }
  });
});
