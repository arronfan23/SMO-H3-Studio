import { contextBridge, ipcRenderer } from 'electron';
import type { SmoApi } from '../shared/ipc';

const api: SmoApi = {
  avatars: {
    list: () => ipcRenderer.invoke('avatars:list', {}),
    create: (input) => ipcRenderer.invoke('avatars:create', input),
  },
  jobs: {
    start: (request) => ipcRenderer.invoke('jobs:start', request),
    cancel: (id) => ipcRenderer.invoke('jobs:cancel', id === undefined ? {} : { id }),
  },
  files: {
    selectImage: () => ipcRenderer.invoke('files:selectImage', {}),
    selectAudio: () => ipcRenderer.invoke('files:selectAudio', {}),
    mediaUrl: (path) => ipcRenderer.invoke('files:mediaUrl', { path }),
  },
  llm: {
    saveProfile: (credentials) => ipcRenderer.invoke('llm:saveProfile', credentials),
    getProfile: () => ipcRenderer.invoke('llm:getProfile', {}),
    listModels: () => ipcRenderer.invoke('llm:listModels', {}),
    testModel: () => ipcRenderer.invoke('llm:testModel', {}),
    polish: (request) => ipcRenderer.invoke('llm:polish', request),
  },
  comfy: {
    health: () => ipcRenderer.invoke('comfy:health', {}),
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
