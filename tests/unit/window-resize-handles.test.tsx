import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { WindowResizeHandles } from '../../src/renderer/WindowResizeHandles';
import type { SmoApi } from '../../src/shared/ipc';

type WindowBridge = SmoApi['window'];

function createWindowBridge() {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => false),
    close: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
    beginResize: vi.fn(async (_direction: string) => true),
    resize: vi.fn(async (_direction: string) => undefined),
    endResize: vi.fn(async () => undefined),
  };
}

describe('WindowResizeHandles', () => {
  let bridge: ReturnType<typeof createWindowBridge>;

  beforeEach(() => {
    bridge = createWindowBridge();
    (window as unknown as { smo: { window: WindowBridge } }).smo = {
      window: bridge as unknown as WindowBridge,
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { smo?: unknown }).smo;
  });

  test('renders eight aria-hidden handles without visible text', () => {
    const { container } = render(<WindowResizeHandles />);
    const handles = container.querySelectorAll('.window-resize-handle');

    expect(handles).toHaveLength(8);
    for (const direction of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
      const handle = container.querySelector(`.window-resize-${direction}`);
      expect(handle).not.toBeNull();
      expect(handle?.getAttribute('aria-hidden')).toBe('true');
      expect(handle?.textContent).toBe('');
    }
  });

  test('runs begin → resize → end through pointer events in order', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-se')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 100,
      screenY: 200,
    });
    await waitFor(() =>
      expect(bridge.beginResize).toHaveBeenCalledWith('se', { x: 100, y: 200 }),
    );

    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, screenX: 130, screenY: 240 });
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('se', { x: 130, y: 240 }),
    );

    fireEvent.pointerUp(handle, { pointerId: 1, screenX: 130, screenY: 240 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));

    const order = [
      bridge.beginResize.mock.invocationCallOrder[0],
      bridge.resize.mock.invocationCallOrder[0],
      bridge.endResize.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
    expect(order[1]).toBeLessThan(order[2]);
  });

  test('does not resize or end when beginResize is declined', async () => {
    bridge.beginResize.mockResolvedValue(false);
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-e')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 300,
      screenY: 400,
    });
    await waitFor(() =>
      expect(bridge.beginResize).toHaveBeenCalledWith('e', { x: 300, y: 400 }),
    );

    fireEvent.pointerMove(handle, { pointerId: 1 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.resize).not.toHaveBeenCalled();
    expect(bridge.endResize).not.toHaveBeenCalled();
  });

  test('ignores non-primary pointer buttons', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-n')!;

    fireEvent.pointerDown(handle, { pointerId: 1, button: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(bridge.beginResize).not.toHaveBeenCalled();
  });

  test('tolerates missing pointer capture APIs (jsdom)', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-w')!;

    fireEvent.pointerDown(handle, {
      pointerId: 7,
      button: 0,
      screenX: 50,
      screenY: 60,
    });
    await waitFor(() =>
      expect(bridge.beginResize).toHaveBeenCalledWith('w', { x: 50, y: 60 }),
    );
    fireEvent.pointerUp(handle, { pointerId: 7 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));
  });

  test('releases the session when pointer up precedes a delayed begin', async () => {
    let resolveBegin: (begun: boolean) => void = () => undefined;
    bridge.beginResize.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBegin = resolve;
        }),
    );
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-se')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 10,
      screenY: 10,
    });
    // Release before begin resolves: end must still be sent (IPC order makes
    // it land after begin in the main process).
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));

    // The late resolve must not enter the dragging state; it ends the session
    // the main process just opened.
    resolveBegin(true);
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(2));

    fireEvent.pointerMove(handle, { pointerId: 1, screenX: 60, screenY: 70 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resize).not.toHaveBeenCalled();
  });

  test('flushes the final moved cursor before ending when begin resolves after pointer up', async () => {
    let resolveBegin: (begun: boolean) => void = () => undefined;
    bridge.beginResize.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolveBegin = resolve;
        }),
    );
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-ne')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 100,
      screenY: 200,
    });
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, screenX: 140, screenY: 150 });
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 0, screenY: 0 });

    expect(bridge.resize).not.toHaveBeenCalled();
    expect(bridge.endResize).not.toHaveBeenCalled();

    resolveBegin(true);
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('ne', { x: 140, y: 150 }),
    );
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));
    expect(bridge.resize.mock.invocationCallOrder[0]).toBeLessThan(
      bridge.endResize.mock.invocationCallOrder[0],
    );
  });

  test('continues tracking raw moves after lost capture and ends only once', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-ne')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 100,
      screenY: 200,
    });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(1));
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, screenX: 145, screenY: 155 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1, screenX: 0, screenY: 0 });
    expect(bridge.endResize).not.toHaveBeenCalled();

    const rawMove = new MouseEvent('pointerrawupdate', {
      bubbles: true,
      buttons: 1,
      screenX: 175,
      screenY: 145,
    });
    Object.defineProperty(rawMove, 'pointerId', { value: 1 });
    fireEvent(window, rawMove);
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 0, screenY: 0 });
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('ne', { x: 175, y: 145 }),
    );
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));
    fireEvent.blur(window);
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 0, screenY: 0 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1, screenX: 0, screenY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.endResize).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(handle, {
      pointerId: 2,
      button: 0,
      screenX: 200,
      screenY: 250,
    });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(2));
    fireEvent.pointerMove(handle, { pointerId: 2, buttons: 1, screenX: 240, screenY: 280 });
    fireEvent.pointerUp(handle, { pointerId: 2, screenX: 0, screenY: 0 });

    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('ne', { x: 240, y: 280 }),
    );
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(2));
  });

  test('settles a lost-capture drag on blur and permits a fresh begin', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-ne')!;

    fireEvent.pointerDown(handle, {
      pointerId: 1,
      button: 0,
      screenX: 100,
      screenY: 200,
    });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(1));
    fireEvent.pointerMove(handle, { pointerId: 1, buttons: 1, screenX: 150, screenY: 160 });
    fireEvent.lostPointerCapture(handle, { pointerId: 1, screenX: 0, screenY: 0 });
    fireEvent.blur(window);

    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('ne', { x: 150, y: 160 }),
    );
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));
    fireEvent.blur(window);
    fireEvent.pointerUp(window, { pointerId: 1, screenX: 0, screenY: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.endResize).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(handle, {
      pointerId: 2,
      button: 0,
      screenX: 220,
      screenY: 260,
    });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(2));
  });

  test('ends exactly once when pointer up follows a resolved begin', async () => {
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-se')!;

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(1));

    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));

    // The session is fully closed: further hovers and a repeated pointerup
    // neither resize nor send another end.
    fireEvent.pointerMove(handle, { pointerId: 1, screenX: 60, screenY: 70 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resize).not.toHaveBeenCalled();
    expect(bridge.endResize).toHaveBeenCalledTimes(1);
  });

  test('ignores a second pointer while the first owns the session', async () => {
    const { container } = render(<WindowResizeHandles />);
    const se = container.querySelector('.window-resize-se')!;
    const nw = container.querySelector('.window-resize-nw')!;

    fireEvent.pointerDown(se, {
      pointerId: 1,
      button: 0,
      screenX: 10,
      screenY: 10,
    });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(1));

    // The second pointer never begins, resizes, or ends anything.
    fireEvent.pointerDown(nw, {
      pointerId: 2,
      button: 0,
      screenX: 20,
      screenY: 20,
    });
    fireEvent.pointerMove(nw, { pointerId: 2, screenX: 30, screenY: 30 });
    fireEvent.pointerUp(nw, { pointerId: 2 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.beginResize).toHaveBeenCalledTimes(1);
    expect(bridge.resize).not.toHaveBeenCalled();
    expect(bridge.endResize).not.toHaveBeenCalled();

    // The owner still drags and ends normally.
    fireEvent.pointerMove(se, { pointerId: 1, buttons: 1, screenX: 40, screenY: 50 });
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('se', { x: 40, y: 50 }),
    );
    fireEvent.pointerUp(se, { pointerId: 1, screenX: 40, screenY: 50 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));
  });

  test('a stale begin resolve never cancels the newer session', async () => {
    const resolvers: Array<(begun: boolean) => void> = [];
    bridge.beginResize.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    const { container } = render(<WindowResizeHandles />);
    const handle = container.querySelector('.window-resize-se')!;

    // First operation: released while its begin is still pending.
    fireEvent.pointerDown(handle, { pointerId: 1, button: 0 });
    fireEvent.pointerUp(handle, { pointerId: 1 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(1));

    // Second operation starts before the first begin resolves.
    fireEvent.pointerDown(handle, { pointerId: 2, button: 0 });
    await waitFor(() => expect(bridge.beginResize).toHaveBeenCalledTimes(2));

    // The stale resolve must neither end the new session nor arm dragging.
    resolvers[0](true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.endResize).toHaveBeenCalledTimes(1);
    fireEvent.pointerMove(handle, { pointerId: 2, screenX: 30, screenY: 40 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.resize).not.toHaveBeenCalled();

    // The current begin resolves; pointer 2 now owns a live session that
    // drags and ends exactly once.
    resolvers[1](true);
    // Flush the resolve microtask so the session is armed before moving.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.pointerMove(handle, { pointerId: 2, buttons: 1, screenX: 50, screenY: 60 });
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('se', { x: 50, y: 60 }),
    );
    fireEvent.pointerUp(handle, { pointerId: 2, screenX: 50, screenY: 60 });
    await waitFor(() => expect(bridge.endResize).toHaveBeenCalledTimes(2));
  });
});
