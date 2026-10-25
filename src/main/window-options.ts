import { join, resolve } from 'node:path';
import type { BrowserWindowConstructorOptions } from 'electron';

export type WindowEnvironment = {
  isPackaged: boolean;
  resourcesPath: string;
  moduleDirectory: string;
};

export function createWindowOptions({
  isPackaged,
  resourcesPath,
  moduleDirectory,
}: WindowEnvironment): BrowserWindowConstructorOptions {
  const icon = isPackaged
    ? join(resourcesPath, 'resources/brand/icon.ico')
    : resolve(moduleDirectory, '../../resources/brand/icon.ico');

  return {
    title: 'SMO.H3 Studio',
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    icon,
    webPreferences: {
      preload: join(moduleDirectory, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}
