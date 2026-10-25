import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld(
  'smo',
  Object.freeze({ productName: 'SMO.H3 Studio' }),
);
