import { contextBridge, ipcRenderer } from 'electron';
import type { SmoApi } from '../shared/ipc';

const api: SmoApi = {
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
  },
  files: {
    selectImage: () => ipcRenderer.invoke('files:selectImage', {}),
    selectAudio: () => ipcRenderer.invoke('files:selectAudio', {}),
    mediaUrl: (path) => ipcRenderer.invoke('files:mediaUrl', { path }),
    openFolder: (path) => ipcRenderer.invoke('files:openFolder', { path }),
  },
  llm: {
    saveProfile: (input) => ipcRenderer.invoke('llm:saveProfile', input),
    getProfile: () => ipcRenderer.invoke('llm:getProfile', {}),
    listModels: (input) => ipcRenderer.invoke('llm:listModels', input),
    testModel: (input) => ipcRenderer.invoke('llm:testModel', input),
    polish: (request) => ipcRenderer.invoke('llm:polish', request),
  },
  comfy: {
    health: () => ipcRenderer.invoke('comfy:health', {}),
    open: () => ipcRenderer.invoke('comfy:open', {}),
  },
  hardware: {
    detect: () => ipcRenderer.invoke('hardware:detect', {}),
    apply: (request) => ipcRenderer.invoke('hardware:apply', request),
  },
  works: {
    list: () => ipcRenderer.invoke('works:list', {}),
  },
};

for (const domain of Object.values(api)) {
  Object.freeze(domain);
}
Object.freeze(api);

contextBridge.exposeInMainWorld('smo', api);
