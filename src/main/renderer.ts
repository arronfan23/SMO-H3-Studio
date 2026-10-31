import { join } from 'node:path';

export type RendererTarget = {
  type: 'url' | 'file';
  location: string;
};

export type RendererWindow = {
  loadURL: (url: string) => Promise<void>;
  loadFile: (path: string) => Promise<void>;
};

export function selectRendererTarget({
  isPackaged,
  rendererUrl,
  moduleDirectory,
}: {
  isPackaged: boolean;
  rendererUrl?: string;
  moduleDirectory: string;
}): RendererTarget {
  if (!isPackaged && rendererUrl) {
    return { type: 'url', location: rendererUrl };
  }

  return {
    type: 'file',
    location: join(moduleDirectory, '../renderer/index.html'),
  };
}

export async function loadRenderer(
  window: RendererWindow,
  target: RendererTarget,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    if (target.type === 'url') {
      await window.loadURL(target.location);
    } else {
      await window.loadFile(target.location);
    }
  } catch (error) {
    onFailure(error);
  }
}

export function createRendererLoadFailureMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);

  return `SMO.H3 Studio 界面加载失败。请重新启动应用；若问题持续存在，请检查安装文件是否完整。\n\n错误详情：${detail}`;
}
