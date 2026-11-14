import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { SmoApi } from '../shared/ipc';
import { parseSanmaoStreamEvent } from '../shared/sanmao';

const api: SmoApi = {
  app: {
    getVersion: () => ipcRenderer.invoke('app:getVersion', {}),
  },
  avatars: {
    list: () => ipcRenderer.invoke('avatars:list', {}),
    create: (input) => ipcRenderer.invoke('avatars:create', input),
    update: (input) => ipcRenderer.invoke('avatars:update', input),
    delete: (id) => ipcRenderer.invoke('avatars:delete', { id }),
  },
  jobs: {
    start: (request) => ipcRenderer.invoke('jobs:start', request),
    retry: (id) => ipcRenderer.invoke('jobs:retry', { id }),
    cancel: (id) => ipcRenderer.invoke('jobs:cancel', id === undefined ? {} : { id }),
    getState: () => ipcRenderer.invoke('jobs:getState', {}),
  },
  speech: {
    getCapabilities: (speechMode) =>
      ipcRenderer.invoke('speech:getCapabilities', { speechMode }),
  },
  components: {
    getState: (id) => ipcRenderer.invoke('components:getState', { id }),
    install: (id) => ipcRenderer.invoke('components:install', { id }),
    cancel: async (id) => {
      await ipcRenderer.invoke('components:cancel', { id });
    },
  },
  files: {
    selectImage: () => ipcRenderer.invoke('files:selectImage', {}),
    selectAudio: () => ipcRenderer.invoke('files:selectAudio', {}),
    authorizeDroppedImage: (file) =>
      ipcRenderer.invoke('files:authorizeDroppedImage', {
        // webUtils only accepts a real File from a drop event, which keeps
        // the renderer from authorizing arbitrary string paths.
        path: webUtils.getPathForFile(
          file as Parameters<typeof webUtils.getPathForFile>[0],
        ),
      }),
    authorizeDroppedAudio: (file) =>
      ipcRenderer.invoke('files:authorizeDroppedAudio', {
        path: webUtils.getPathForFile(
          file as Parameters<typeof webUtils.getPathForFile>[0],
        ),
      }),
    mediaUrl: (path) => ipcRenderer.invoke('files:mediaUrl', { path }),
    openFolder: (path) => ipcRenderer.invoke('files:openFolder', { path }),
  },
  recordings: {
    save: async (blob) =>
      ipcRenderer.invoke('recordings:save', {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mimeType: blob.type,
      }),
    discard: (path) => ipcRenderer.invoke('recordings:discard', { path }),
  },
  llm: {
    saveProfile: (input) => ipcRenderer.invoke('llm:saveProfile', input),
    getProfile: () => ipcRenderer.invoke('llm:getProfile', {}),
    listModels: (input) => ipcRenderer.invoke('llm:listModels', input),
    testModel: (input) => ipcRenderer.invoke('llm:testModel', input),
    polish: (request) => ipcRenderer.invoke('llm:polish', request),
  },
  sanmao: {
    getProfile: () => ipcRenderer.invoke('sanmao:getProfile', {}),
    saveProfile: (input) => ipcRenderer.invoke('sanmao:saveProfile', input),
    testConnection: (input) => ipcRenderer.invoke('sanmao:testConnection', input),
    listModels: (input) => ipcRenderer.invoke('sanmao:listModels', input),
    send: (input) => ipcRenderer.invoke('sanmao:send', input),
    cancel: (replyId) => ipcRenderer.invoke('sanmao:cancel', { replyId }),
    subscribe: (listener) => {
      const receive = (_event: unknown, payload: unknown) => {
        listener(parseSanmaoStreamEvent(payload));
      };
      ipcRenderer.on('sanmao:stream', receive);
      return () => ipcRenderer.off('sanmao:stream', receive);
    },
  },
  comfy: {
    health: () => ipcRenderer.invoke('comfy:health', {}),
    start: () => ipcRenderer.invoke('comfy:start', {}),
    open: () => ipcRenderer.invoke('comfy:open', {}),
  },
  environment: {
    getState: () => ipcRenderer.invoke('environment:getState', {}),
    selectExistingRoot: () =>
      ipcRenderer.invoke('environment:selectExistingRoot', {}),
    importExisting: (input) => ipcRenderer.invoke('environment:import', input),
    detect: (installRoot) =>
      ipcRenderer.invoke(
        'environment:detect',
        installRoot === undefined ? {} : { installRoot },
      ),
    start: (input) => ipcRenderer.invoke('environment:start', input),
    retry: (input) => ipcRenderer.invoke('environment:retry', input),
    cancel: () => ipcRenderer.invoke('environment:cancel', {}),
    validate: () => ipcRenderer.invoke('environment:validate', {}),
  },
  hardware: {
    detect: () => ipcRenderer.invoke('hardware:detect', {}),
    recommend: (input) => ipcRenderer.invoke('hardware:recommend', input),
    reset: (mode) => ipcRenderer.invoke('hardware:reset', { mode }),
    apply: (request) => ipcRenderer.invoke('hardware:apply', request),
  },
  works: {
    delete: (id) => ipcRenderer.invoke('works:delete', { id }),
    list: () => ipcRenderer.invoke('works:list', {}),
    rename: (input) => ipcRenderer.invoke('works:rename', input),
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize', {}),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize', {}),
    close: () => ipcRenderer.invoke('window:close', {}),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized', {}),
    beginResize: (direction, cursor) =>
      ipcRenderer.invoke(
        'window:begin-resize',
        cursor ? { direction, cursor } : { direction },
      ),
    resize: (direction, cursor) =>
      ipcRenderer.invoke(
        'window:resize',
        cursor ? { direction, cursor } : { direction },
      ),
    endResize: () => ipcRenderer.invoke('window:end-resize', {}),
  },
};

for (const domain of Object.values(api)) {
  Object.freeze(domain);
}
Object.freeze(api);

contextBridge.exposeInMainWorld('smo', api);
