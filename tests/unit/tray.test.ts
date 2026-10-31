// @vitest-environment node

import type { Menu } from 'electron';
import { describe, expect, test, vi } from 'vitest';
import {
  createTrayController,
  type TrayController,
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

  test('existing before-quit cleanup runs once across the real quit sequence', () => {
    const closeServices = vi.fn();
    let cleanupStarted = false;
    let controller!: TrayController;
    const onQuit = vi.fn(() => {
      controller.handleBeforeQuit();
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      closeServices();
    });
    const harness = createHarness({ onQuit });
    controller = harness.controller;

    controller.quit();
    controller.quit();
    onQuit();

    expect(closeServices).toHaveBeenCalledTimes(1);
  });
});
