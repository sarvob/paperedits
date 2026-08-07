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
  onImportEnriched: (cb: (snapshot: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => cb(s);
    ipcRenderer.on('import:enriched', listener);
    return () => ipcRenderer.removeListener('import:enriched', listener);
  },
  onSummaryPartial: (cb: (p: { summary: string; coveredSec: number; totalSec: number }) => void) => {
    const listener = (_e: unknown, p: { summary: string; coveredSec: number; totalSec: number }) => cb(p);
    ipcRenderer.on('summary:partial', listener);
    return () => ipcRenderer.removeListener('summary:partial', listener);
  },
  onMetrics: (cb: (m: Record<string, number | string>) => void) => {
    const listener = (_e: unknown, m: Record<string, number | string>) => cb(m);
    ipcRenderer.on('metrics:update', listener);
    return () => ipcRenderer.removeListener('metrics:update', listener);
  },
  metricsGet: () => ipcRenderer.invoke('metrics:get'),
  judgeSummary: () => ipcRenderer.invoke('quality:judge'),
  setGoal: (goal: string | null) => ipcRenderer.invoke('session:goal', goal),
  prompt: (instruction: string) => ipcRenderer.invoke('session:prompt', instruction),
  undo: () => ipcRenderer.invoke('session:undo'),
  redo: () => ipcRenderer.invoke('session:redo'),
  setSpeed: (entryId: string, speed: number) => ipcRenderer.invoke('session:setSpeed', entryId, speed),
  outbound: (instruction: string) => ipcRenderer.invoke('session:outbound', instruction),
  chat: (message: string) => ipcRenderer.invoke('chat:send', message),
  onChatToken: (cb: (t: string) => void) => {
    const listener = (_e: unknown, t: string) => cb(t);
    ipcRenderer.on('chat:token', listener);
    return () => ipcRenderer.removeListener('chat:token', listener);
  },
  ollamaModels: () => ipcRenderer.invoke('ollama:models'),
  setBackend: (kind: string, config: unknown) => ipcRenderer.invoke('settings:setBackend', kind, config),
  currentBackend: () => ipcRenderer.invoke('backend:current'),
  thumbsEnsure: () => ipcRenderer.invoke('thumbs:ensure'),
  summarize: (force?: boolean) => ipcRenderer.invoke('session:summarize', !!force),
  highlights: (force?: boolean) => ipcRenderer.invoke('session:highlights', !!force),
  addOverlay: (overlay: unknown) => ipcRenderer.invoke('overlay:add', overlay),
  updateOverlay: (id: string, patch: unknown, label: string) => ipcRenderer.invoke('overlay:update', id, patch, label),
  removeOverlay: (id: string) => ipcRenderer.invoke('overlay:remove', id),
  export: (outPath: string | null, overlayPngs: Record<string, string>) =>
    ipcRenderer.invoke('session:export', outPath ?? null, overlayPngs ?? {}),
});
