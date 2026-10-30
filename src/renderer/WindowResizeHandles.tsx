import { useEffect, useRef } from 'react';
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
  const endRequested = useRef(false);
  const hasMoved = useRef(false);
  const captureTarget = useRef<Element | null>(null);
  const captureLost = useRef(false);
  const framePending = useRef(false);

  const sendEndResize = (): void => {
    void windowBridge()?.endResize().catch(() => undefined);
  };

  const finishWithFinalResize = (
    direction: WindowResizeDirection,
    operation: number,
  ): void => {
    const cursor = latestCursor.current ?? undefined;
    void windowBridge()
      ?.resize(direction, cursor)
      .catch(() => undefined)
      .finally(() => {
        if (operation !== operationId.current) return;
        sessionOpen.current = false;
        endRequested.current = false;
        hasMoved.current = false;
        latestCursor.current = null;
        sendEndResize();
      });
  };

  const handlePointerDown =
    (direction: WindowResizeDirection) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      if (ownerPointerId.current !== null || sessionOpen.current) {
        return;
      }
      const bridge = windowBridge();
      if (!bridge) {
        return;
      }
      const target = event.currentTarget;
      capturePointer(target, event.pointerId);
      captureTarget.current = target;
      captureLost.current = false;
      ownerPointerId.current = event.pointerId;
      const operation = ++operationId.current;
      latestCursor.current = { x: event.screenX, y: event.screenY };
      endRequested.current = false;
      hasMoved.current = false;
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
            if (!begun) {
              sessionOpen.current = false;
              endRequested.current = false;
              hasMoved.current = false;
              latestCursor.current = null;
            } else if (endRequested.current && hasMoved.current) {
              // Preserve the last pointer position before closing a session
              // whose pointerup arrived while begin was still pending.
              finishWithFinalResize(direction, operation);
            } else {
              sendEndResize();
            }
            return;
          }
          if (begun) {
            activeDirection.current = direction;
          } else {
            sessionOpen.current = false;
            ownerPointerId.current = null;
            endRequested.current = false;
            hasMoved.current = false;
            latestCursor.current = null;
            captureTarget.current = null;
            captureLost.current = false;
            releasePointer(target, event.pointerId);
          }
        })
        .catch(() => {
          if (operation !== operationId.current) {
            return;
          }
          sessionOpen.current = false;
          ownerPointerId.current = null;
          endRequested.current = false;
          hasMoved.current = false;
          latestCursor.current = null;
          captureTarget.current = null;
          captureLost.current = false;
          releasePointer(target, event.pointerId);
        });
    };

  const handlePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.pointerId !== ownerPointerId.current) {
      return;
    }
    if (event.buttons === 0) return;
    latestCursor.current = { x: event.screenX, y: event.screenY };
    hasMoved.current = true;
    if (activeDirection.current === null || framePending.current) {
      return;
    }
    framePending.current = true;
    const operation = operationId.current;
    requestAnimationFrame(() => {
      framePending.current = false;
      if (operation !== operationId.current) return;
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
    const operation = operationId.current;
    const direction = activeDirection.current;
    const shouldFlushFinalMove = sessionOpen.current && hasMoved.current;
    ownerPointerId.current = null;
    activeDirection.current = null;
    const eventTarget = event.currentTarget;
    if (!captureLost.current) {
      releasePointer(
        eventTarget instanceof Element ? eventTarget : captureTarget.current,
        event.pointerId,
      );
    }
    captureTarget.current = null;
    captureLost.current = false;
    if (!sessionOpen.current) {
      latestCursor.current = null;
      hasMoved.current = false;
      endRequested.current = false;
      return;
    }
    endRequested.current = true;
    if (shouldFlushFinalMove) {
      if (direction !== null) finishWithFinalResize(direction, operation);
      return;
    }
    sessionOpen.current = false;
    endRequested.current = false;
    hasMoved.current = false;
    latestCursor.current = null;
    sendEndResize();
  };

  const handleLostPointerCapture = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.pointerId === ownerPointerId.current) captureLost.current = true;
  };

  useEffect(() => {
    const handleWindowPointerMove = (event: Event): void => {
      const pointerEvent = event as PointerEvent;
      if (pointerEvent.pointerId !== ownerPointerId.current) return;
      handlePointerMove(pointerEvent as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const handleWindowPointerEnd = (event: PointerEvent): void => {
      if (event.pointerId !== ownerPointerId.current) return;
      handlePointerEnd(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const handleWindowBlur = (): void => {
      const pointerId = ownerPointerId.current;
      if (pointerId === null) return;
      handlePointerEnd({
        pointerId,
        currentTarget: captureTarget.current,
      } as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerrawupdate', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerEnd);
    window.addEventListener('pointercancel', handleWindowPointerEnd);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerrawupdate', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerEnd);
      window.removeEventListener('pointercancel', handleWindowPointerEnd);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, []);

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
          onLostPointerCapture={handleLostPointerCapture}
        />
      ))}
    </>
  );
}
