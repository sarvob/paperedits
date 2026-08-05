import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { join, extname } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import {
  HeuristicBackend,
  Session,
  buildOutboundText,
  digestToPrompt,
  estimateTokens,
  type Edl,
} from '@pve/core';
import { FfmpegImporter, renderToFile, runSystemChecks } from '@pve/import';

// Work around a Chromium/macOS compositing bug where <video> decodes fine
// (canvas can read frames) but the hardware overlay layer paints black. Forcing
// software compositing makes the preview render reliably.
app.disableHardwareAcceleration();

// A privileged scheme so the renderer can stream the user's local video into a
// <video> element without disabling web security or widening the file: origin.
protocol.registerSchemesAsPrivileged([
  { scheme: 'pvemedia', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } },
]);

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
    // media URL the renderer can put on a <video> element
    mediaUrl: sourcePath ? `pvemedia://local/${encodeURIComponent(sourcePath)}` : null,
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

ipcMain.handle('overlay:add', async (_e, overlay) => {
  if (!session) return null;
  session.addOverlay(overlay);
  return snapshot();
});
ipcMain.handle('overlay:update', async (_e, id: string, patch, label: string) => {
  if (!session) return null;
  session.updateOverlay(id, patch, label);
  return snapshot();
});
ipcMain.handle('overlay:remove', async (_e, id: string) => {
  if (!session) return null;
  session.removeOverlay(id);
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

ipcMain.handle('session:export', async (_e, outPath: string | null, overlayPngDataUrls: Record<string, string>) => {
  if (!session || !sourcePath) return { ok: false, error: 'no file imported' };
  const out = outPath || sourcePath.replace(/\.(mp4|mov|mkv|webm|m4v|avi)$/i, '.edit.mp4');
  try {
    // The renderer rasterizes each overlay to a PNG data URL (canvas — no ffmpeg
    // text support needed). Persist them to a temp dir and hand paths to render.
    const overlayPngs: Record<string, string> = {};
    if (overlayPngDataUrls && Object.keys(overlayPngDataUrls).length) {
      const dir = await mkdtemp(join(tmpdir(), 'pve-overlays-'));
      for (const [id, dataUrl] of Object.entries(overlayPngDataUrls)) {
        const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
        const p = join(dir, `${id}.png`);
        await writeFile(p, Buffer.from(b64, 'base64'));
        overlayPngs[id] = p;
      }
    }
    let warn = '';
    const r = await renderToFile(session.edl, {
      input: sourcePath,
      output: out,
      quality: 'match',
      encoder: 'videotoolbox',
      overlayPngs,
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

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

app.whenReady().then(() => {
  // Serve the user's local media to the <video> element, honouring HTTP Range
  // requests so the media pipeline can seek/decode (net.fetch(file://) does not
  // give the element a seekable stream, which breaks H.264 decode).
  protocol.handle('pvemedia', async (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
    const contentType = MIME[extname(filePath).toLowerCase()] ?? 'video/mp4';
    const { size } = await fsStat(filePath);
    const range = request.headers.get('Range');
    const base: Record<string, string> = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes' };

    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const start = m ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : size - 1;
      const stream = Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new Response(stream, { headers: { ...base, 'Content-Length': String(size) } });
  });

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
