import { fireEvent, render, waitFor } from '@testing-library/react';
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

    fireEvent.pointerMove(handle, { pointerId: 1, screenX: 130, screenY: 240 });
    await waitFor(() =>
      expect(bridge.resize).toHaveBeenCalledWith('se', { x: 130, y: 240 }),
    );

    fireEvent.pointerUp(handle, { pointerId: 1 });
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
});
