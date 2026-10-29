import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

function windowBridge(): Window['smo']['window'] | undefined {
  return typeof window === 'undefined' ? undefined : window.smo?.window;
}

export function WindowTitlebar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let mounted = true;
    const sync = async (): Promise<void> => {
      const bridge = windowBridge();
      if (!bridge) {
        return;
      }
      try {
        const state = await bridge.isMaximized();
        if (mounted) {
          setMaximized(state);
        }
      } catch {
        // Keep the last known state when the main process is unreachable.
      }
    };
    void sync();
    window.addEventListener('resize', sync);
    return () => {
      mounted = false;
      window.removeEventListener('resize', sync);
    };
  }, []);

  useEffect(() => {
    document.body.dataset.windowMaximized = maximized ? 'true' : 'false';
    return () => {
      delete document.body.dataset.windowMaximized;
    };
  }, [maximized]);

  const minimize = (): void => {
    void windowBridge()?.minimize();
  };

  const toggleMaximize = async (): Promise<void> => {
    const bridge = windowBridge();
    if (!bridge) {
      return;
    }
    try {
      setMaximized(await bridge.toggleMaximize());
    } catch {
      // Ignore races with window teardown; the next resize resyncs the state.
    }
  };

  const close = (): void => {
    void windowBridge()?.close();
  };

  return (
    <header className="window-titlebar">
      <div className="titlebar-drag" onDoubleClick={() => void toggleMaximize()}>
        <img
          className="titlebar-icon"
          src="./brand/icon.png"
          alt=""
          width={16}
          height={16}
        />
        <span className="titlebar-brand">SMO.H3 Studio</span>
      </div>
      <div className="titlebar-controls">
        <button
          type="button"
          className="titlebar-button"
          title="最小化"
          aria-label="最小化"
          onClick={minimize}
        >
          <Minus size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="titlebar-button"
          title={maximized ? '还原' : '最大化'}
          aria-label={maximized ? '还原' : '最大化'}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? (
            <Copy size={12} aria-hidden="true" />
          ) : (
            <Square size={12} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="titlebar-button titlebar-button-close"
          title="关闭"
          aria-label="关闭"
          onClick={close}
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
