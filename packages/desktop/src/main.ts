import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import {
  HeuristicBackend,
  Session,
  buildOutboundText,
  digestToPrompt,
  estimateTokens,
  type Edl,
} from '@pve/core';
import { FfmpegImporter, renderToFile, runSystemChecks } from '@pve/import';

// ---- session state (one imported file at a time) --------------------------
let session: Session | null = null;
let sourcePath: string | null = null;
const backend = new HeuristicBackend();
const importer = new FfmpegImporter();

/** Serializable snapshot the renderer draws from. */
function snapshot(): {
  edl: Edl;
  durationSec: number;
  digestText: string;
  tokens: number;
  timeline: string[];
  sourcePath: string | null;
} | null {
  if (!session) return null;
  const digestText = digestToPrompt(session.digest);
  return {
    edl: session.edl,
    durationSec: session.analysis.durationSec,
    digestText,
    tokens: estimateTokens(digestText),
    timeline: session.timeline(),
    sourcePath,
  };
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    backgroundColor: '#0f1115',
    title: 'Prompt Video Editor',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true },
  });
  win.loadFile(join(__dirname, 'index.html'));
}

// ---- IPC ------------------------------------------------------------------
ipcMain.handle('system:check', async () => runSystemChecks());

ipcMain.handle('file:open', async () => {
  const res = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi'] }],
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('session:import', async (_e, path: string) => {
  try {
    const analysis = await importer.analyze(path);
    session = new Session(analysis);
    sourcePath = path;
    return { ok: true, ...snapshot()! };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('session:prompt', async (_e, instruction: string) => {
  if (!session) return { ok: false, error: 'no file imported' };
  const res = await session.prompt(instruction, backend);
  if (!res.ok) {
    return { ok: false, rejected: true, errors: res.errors.map((x) => x.reason), interpretation: res.interpretation };
  }
  return { ok: true, interpretation: res.interpretation, ...snapshot()! };
});

ipcMain.handle('session:undo', async () => {
  if (!session) return null;
  const label = session.undo();
  return { label, ...snapshot()! };
});

ipcMain.handle('session:redo', async () => {
  if (!session) return null;
  const label = session.redo();
  return { label, ...snapshot()! };
});

ipcMain.handle('session:setSpeed', async (_e, entryId: string, speed: number) => {
  if (!session) return null;
  session.setSpeed(entryId, speed);
  return snapshot();
});

ipcMain.handle('session:outbound', async (_e, instruction: string) => {
  // Heuristic/local mode sends NOTHING. We still show exactly what a remote
  // backend WOULD transmit, so the privacy guarantee is inspectable.
  if (!session) return { network: false, text: '' };
  const text = buildOutboundText({
    digest: session.digest,
    edl: session.edl,
    history: [],
    instruction,
    tools: {} as never,
  });
  return { network: backend.network, text };
});

ipcMain.handle('session:export', async (_e, outPath: string | null) => {
  if (!session || !sourcePath) return { ok: false, error: 'no file imported' };
  const out = outPath || sourcePath.replace(/\.(mp4|mov|mkv|webm|m4v|avi)$/i, '.edit.mp4');
  try {
    let warn = '';
    const r = await renderToFile(session.edl, {
      input: sourcePath,
      output: out,
      quality: 'match',
      encoder: 'videotoolbox',
      onWarn: (w) => (warn = w),
    });
    return { ok: true, output: r.output, bytes: r.bytes, seconds: r.seconds, warn };
  } catch (err) {
    return { ok: false, error: (err as Error).message.split('\n')[0] };
  }
});

/** If a sample clip exists, tell the renderer so it can offer a one-click load. */
ipcMain.handle('sample:path', async () => {
  const p = join(process.cwd(), 'samples', 'buildlog.mp4');
  return existsSync(p) ? p : null;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
