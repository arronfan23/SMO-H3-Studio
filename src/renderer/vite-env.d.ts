/// <reference types="vite/client" />

import type { SmoApi } from '../shared/ipc';

declare global {
  interface Window {
    smo: SmoApi;
  }
}

export {};
