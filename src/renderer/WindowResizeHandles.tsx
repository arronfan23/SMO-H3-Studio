import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  WINDOW_RESIZE_DIRECTIONS,
  type WindowResizeDirection,
  type WindowScreenPoint,
} from '../shared/ipc';

function windowBridge(): Window['smo']['window'] | undefined {
  return typeof window === 'undefined' ? undefined : window.smo?.window;
}

function capturePointer(target: Element, pointerId: number): void {
  if (typeof target.setPointerCapture !== 'function') {
    return;
  }
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // jsdom and torn-down pointers cannot capture; dragging still works.
  }
}

function releasePointer(target: Element | null, pointerId: number): void {
  if (
    target === null ||
    typeof target.releasePointerCapture !== 'function'
  ) {
    return;
  }
  try {
    target.releasePointerCapture(pointerId);
  } catch {
    // Releasing an uncaptured pointer throws; safe to ignore.
  }
}

// Invisible edge hot zones driving main-process resizing. Each pointer event
// reports screenX/screenY (screen DIPs, the same space as Electron window
// bounds), so fractional-DPI drift in clientX/Y never reaches the bounds and
// synthetic input works without moving the real OS cursor.
export function WindowResizeHandles() {
  const activeDirection = useRef<WindowResizeDirection | null>(null);
  // True from sending begin-resize until end-resize is sent, so a pointerup
  // arriving before the begin IPC resolves cannot leak a main-process session.
  const sessionOpen = useRef(false);
  // The single pointer that owns the current (or pending) session; every
  // event from any other pointer is ignored. operationId invalidates stale
  // begin resolves so they can never disturb a newer session.
  const ownerPointerId = useRef<number | null>(null);
  const operationId = useRef(0);
  const latestCursor = useRef<WindowScreenPoint | null>(null);
  const framePending = useRef(false);

  const sendEndResize = (): void => {
    void windowBridge()?.endResize().catch(() => undefined);
  };

  const handlePointerDown =
    (direction: WindowResizeDirection) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      if (ownerPointerId.current !== null) {
        return;
      }
      const bridge = windowBridge();
      if (!bridge) {
        return;
      }
      const target = event.currentTarget;
      capturePointer(target, event.pointerId);
      ownerPointerId.current = event.pointerId;
      const operation = ++operationId.current;
      latestCursor.current = { x: event.screenX, y: event.screenY };
      sessionOpen.current = true;
      void bridge
        .beginResize(direction, latestCursor.current)
        .then((begun) => {
          if (operation !== operationId.current) {
            // A newer operation owns the session now; a stale resolve must
            // never end or reconfigure it.
            return;
          }
          if (ownerPointerId.current !== event.pointerId) {
            // Released before begin resolved: never enter the dragging state,
            // and close the session the main process may have just opened.
            if (begun) {
              sendEndResize();
            }
            return;
          }
          if (begun) {
            activeDirection.current = direction;
          } else {
            sessionOpen.current = false;
            ownerPointerId.current = null;
            releasePointer(target, event.pointerId);
          }
        })
        .catch(() => {
          if (operation !== operationId.current) {
            return;
          }
          sessionOpen.current = false;
          ownerPointerId.current = null;
          releasePointer(target, event.pointerId);
        });
    };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.pointerId !== ownerPointerId.current) {
      return;
    }
    latestCursor.current = { x: event.screenX, y: event.screenY };
    if (activeDirection.current === null || framePending.current) {
      return;
    }
    framePending.current = true;
    requestAnimationFrame(() => {
      framePending.current = false;
      const direction = activeDirection.current;
      if (direction !== null) {
        void windowBridge()
          ?.resize(direction, latestCursor.current ?? undefined)
          .catch(() => undefined);
      }
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.pointerId !== ownerPointerId.current) {
      return;
    }
    ownerPointerId.current = null;
    activeDirection.current = null;
    latestCursor.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    if (!sessionOpen.current) {
      return;
    }
    sessionOpen.current = false;
    sendEndResize();
  };

  return (
    <>
      {WINDOW_RESIZE_DIRECTIONS.map((direction) => (
        <div
          key={direction}
          className={`window-resize-handle window-resize-${direction}`}
          aria-hidden="true"
          onPointerDown={handlePointerDown(direction)}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      ))}
    </>
  );
}
