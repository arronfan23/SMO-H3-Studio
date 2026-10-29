import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import {
  WINDOW_RESIZE_DIRECTIONS,
  type WindowResizeDirection,
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

// Invisible edge hot zones driving main-process resizing. Physical cursor
// positions come from screen.getCursorScreenPoint() in the main process, so
// fractional-DPI drift in React clientX/Y never reaches the window bounds.
export function WindowResizeHandles() {
  const activeDirection = useRef<WindowResizeDirection | null>(null);
  const framePending = useRef(false);

  const handlePointerDown =
    (direction: WindowResizeDirection) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0) {
        return;
      }
      const bridge = windowBridge();
      if (!bridge) {
        return;
      }
      const target = event.currentTarget;
      capturePointer(target, event.pointerId);
      void bridge
        .beginResize(direction)
        .then((begun) => {
          if (begun) {
            activeDirection.current = direction;
          } else {
            releasePointer(target, event.pointerId);
          }
        })
        .catch(() => {
          releasePointer(target, event.pointerId);
        });
    };

  const handlePointerMove = (): void => {
    if (activeDirection.current === null || framePending.current) {
      return;
    }
    framePending.current = true;
    requestAnimationFrame(() => {
      framePending.current = false;
      const direction = activeDirection.current;
      if (direction !== null) {
        void windowBridge()?.resize(direction).catch(() => undefined);
      }
    });
  };

  const handlePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (activeDirection.current === null) {
      return;
    }
    activeDirection.current = null;
    releasePointer(event.currentTarget, event.pointerId);
    void windowBridge()?.endResize().catch(() => undefined);
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
