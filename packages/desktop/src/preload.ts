import { contextBridge, ipcRenderer } from 'electron';

type ProgressCb = (p: { stage: string; pct: number }) => void;

/**
 * The only bridge between the sandboxed renderer and the engine in the main
 * process. Every method is an explicit, typed IPC call — the renderer has no
 * Node access and cannot reach the filesystem or network on its own.
 */
contextBridge.exposeInMainWorld('pve', {
  systemCheck: () => ipcRenderer.invoke('system:check'),
  openFile: () => ipcRenderer.invoke('file:open'),
  samplePath: () => ipcRenderer.invoke('sample:path'),
  initialFile: () => ipcRenderer.invoke('initial:file'),
  import: (path: string) => ipcRenderer.invoke('session:import', path),
  onImportProgress: (cb: ProgressCb) => {
    const listener = (_e: unknown, p: { stage: string; pct: number }) => cb(p);
    ipcRenderer.on('import:progress', listener);
    return () => ipcRenderer.removeListener('import:progress', listener);
  },
  prompt: (instruction: string) => ipcRenderer.invoke('session:prompt', instruction),
  undo: () => ipcRenderer.invoke('session:undo'),
  redo: () => ipcRenderer.invoke('session:redo'),
  setSpeed: (entryId: string, speed: number) => ipcRenderer.invoke('session:setSpeed', entryId, speed),
  outbound: (instruction: string) => ipcRenderer.invoke('session:outbound', instruction),
  chat: (message: string) => ipcRenderer.invoke('chat:send', message),
  ollamaModels: () => ipcRenderer.invoke('ollama:models'),
  setBackend: (kind: string, config: unknown) => ipcRenderer.invoke('settings:setBackend', kind, config),
  currentBackend: () => ipcRenderer.invoke('backend:current'),
  summarize: (force?: boolean) => ipcRenderer.invoke('session:summarize', !!force),
  highlights: (force?: boolean) => ipcRenderer.invoke('session:highlights', !!force),
  addOverlay: (overlay: unknown) => ipcRenderer.invoke('overlay:add', overlay),
  updateOverlay: (id: string, patch: unknown, label: string) => ipcRenderer.invoke('overlay:update', id, patch, label),
  removeOverlay: (id: string) => ipcRenderer.invoke('overlay:remove', id),
  export: (outPath: string | null, overlayPngs: Record<string, string>) =>
    ipcRenderer.invoke('session:export', outPath ?? null, overlayPngs ?? {}),
});
