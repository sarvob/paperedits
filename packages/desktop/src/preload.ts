import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the sandboxed renderer and the engine in the main
 * process. Every method is an explicit, typed IPC call — the renderer has no
 * Node access and cannot reach the filesystem or network on its own.
 */
contextBridge.exposeInMainWorld('pve', {
  systemCheck: () => ipcRenderer.invoke('system:check'),
  openFile: () => ipcRenderer.invoke('file:open'),
  samplePath: () => ipcRenderer.invoke('sample:path'),
  import: (path: string) => ipcRenderer.invoke('session:import', path),
  prompt: (instruction: string) => ipcRenderer.invoke('session:prompt', instruction),
  undo: () => ipcRenderer.invoke('session:undo'),
  redo: () => ipcRenderer.invoke('session:redo'),
  setSpeed: (entryId: string, speed: number) => ipcRenderer.invoke('session:setSpeed', entryId, speed),
  outbound: (instruction: string) => ipcRenderer.invoke('session:outbound', instruction),
  export: (outPath?: string | null) => ipcRenderer.invoke('session:export', outPath ?? null),
});
