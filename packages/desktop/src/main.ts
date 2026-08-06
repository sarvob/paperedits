import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import { join, extname } from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, stat as fsStat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import {
  AnthropicBackend,
  CascadeBackend,
  HeuristicBackend,
  OllamaBackend,
  RemoteBackend,
  Session,
  buildOutboundText,
  digestToPrompt,
  estimateTokens,
  type Backend,
  type Edl,
  type OutboundGate,
} from '@pve/core';
import { FfmpegImporter, renderToFile, runSystemChecks } from '@pve/import';

// A GUI app launched by double-click inherits a minimal PATH that omits
// /opt/homebrew/bin etc., so ffmpeg/ffprobe/whisper-cli can't be spawned and
// import fails silently. Ensure the common binary dirs are always on PATH.
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin'];
process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(':').filter(Boolean), ...EXTRA_PATHS])].join(':');

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
const importer = new FfmpegImporter();

// The heuristic backend is always available as the fallback; `currentBackend`
// is what the user selected (heuristic / ollama / anthropic / remote).
const heuristicBackend = new HeuristicBackend();
let currentBackend: Backend = heuristicBackend;
let currentBackendDetail = 'heuristic';

/**
 * The chat is the primary way to use the tool, so it must have a real model by
 * default: at startup, use a local Ollama model when one is available instead
 * of the pattern heuristic. The user can still switch in the Intelligence panel.
 */
async function autoSelectBackend(): Promise<void> {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return;
    const data = (await res.json()) as { models?: { name: string }[] };
    const models = (data.models ?? []).map((m) => m.name);
    if (!models.length) return;
    // Prefer the most capable installed model — 7B-class models answer far
    // more reliably than 3B (no scaffold leakage, better ranking).
    const prefs = ['qwen2.5', 'llama3.1', 'mistral', 'llama3.2'];
    const model = prefs.map((p) => models.find((m) => m.startsWith(p))).find(Boolean) ?? models[0]!;
    currentBackend = new OllamaBackend({ model });
    currentBackendDetail = `ollama · ${model}`;
  } catch {
    /* Ollama not running — stay on heuristic */
  }
}

ipcMain.handle('backend:current', () => ({
  name: currentBackend.name,
  detail: currentBackendDetail,
  network: currentBackend.network,
}));

/** Remote sends only after the user approves the exact outbound text.
 * "Always allow" persists for the session so summary+highlights+chat don't
 * each require a click; the outbound pane still shows every payload. */
let alwaysAllowSend = false;
const outboundGate: OutboundGate = async (text) => {
  if (alwaysAllowSend) return true;
  const r = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Send', 'Always allow this session', 'Cancel'],
    defaultId: 0,
    cancelId: 2,
    message: 'Send this text to the remote model?',
    detail: text.length > 3000 ? text.slice(0, 3000) + '\n…(truncated)' : text,
  });
  if (r.response === 1) alwaysAllowSend = true;
  return r.response !== 2;
};

/** Serializable snapshot the renderer draws from. */
function snapshot(): {
  edl: Edl;
  durationSec: number;
  digestText: string;
  tokens: number;
  timeline: string[];
  sourcePath: string | null;
  audioLevels: number[];
  activityPerSec: number[];
  agentPlan: unknown;
  mediaUrl: string | null;
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
    audioLevels: session.analysis.audioLevels ?? [],
    activityPerSec: session.analysis.activityPerSec,
    agentPlan: session.agentPlan,
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

ipcMain.handle('session:import', async (e, path: string) => {
  try {
    const analysis = await importer.analyze(path, {
      onProgress: (stage, pct) => e.sender.send('import:progress', { stage, pct }),
    });
    session = new Session(analysis);
    sourcePath = path;
    return { ok: true, ...snapshot()! };
  } catch (err) {
    // Surface the real reason (missing binary, unreadable file, etc.).
    return { ok: false, error: (err as Error).message.split('\n').slice(0, 3).join(' ') };
  }
});

ipcMain.handle('session:prompt', async (_e, instruction: string) => {
  if (!session) return { ok: false, error: 'no file imported' };

  // Try the selected backend; if it errors or its ops are rejected, fall back to
  // the heuristic so an instruction never silently no-ops on a bad LLM response.
  let res = null as Awaited<ReturnType<Session['prompt']>> | null;
  let note = '';
  try {
    res = await session.prompt(instruction, currentBackend);
  } catch (err) {
    note = (err as Error).message;
  }
  let usedFallback = false;
  if ((!res || !res.ok) && currentBackend !== heuristicBackend) {
    usedFallback = true;
    res = await session.prompt(instruction, heuristicBackend);
  }
  if (!res) return { ok: false, error: note || 'failed' };
  if (!res.ok) {
    return { ok: false, rejected: true, errors: res.errors.map((x) => x.reason), interpretation: res.interpretation };
  }
  return {
    ok: true,
    interpretation: (usedFallback ? '(LLM output unusable → heuristic) ' : '') + res.interpretation,
    usedFallback,
    backendUsed: usedFallback ? 'heuristic' : currentBackend.name,
    ...snapshot()!,
  };
});

ipcMain.handle('ollama:models', async () => {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    if (!res.ok) return { ok: false, models: [] as string[] };
    const data = (await res.json()) as { models?: { name: string }[] };
    return { ok: true, models: (data.models ?? []).map((m) => m.name).sort() };
  } catch {
    return { ok: false, models: [] as string[] };
  }
});

ipcMain.handle('chat:send', async (_e, message: string) => {
  if (!session) return { ok: false, error: 'no file imported' };
  try {
    const res = await session.chat(currentBackend, message, heuristicBackend);
    if (res.kind === 'edit') {
      return { ok: true, kind: 'edit', text: res.interpretation, usedFallback: res.usedFallback, ...snapshot()! };
    }
    return { ok: true, kind: 'answer', text: res.text };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle('settings:setBackend', async (_e, kind: string, config: { model?: string; models?: string[]; host?: string; apiBase?: string; apiKey?: string }) => {
  try {
    if (kind === 'ollama') {
      const models = config.models?.length ? config.models : [config.model || 'llama3.2:3b'];
      currentBackend =
        models.length === 1
          ? new OllamaBackend({ model: models[0]!, host: config.host })
          : new CascadeBackend(models.map((m) => ({ backend: new OllamaBackend({ model: m, host: config.host }), label: m })));
      currentBackendDetail = `ollama · ${models.join(' → ')}`;
    } else if (kind === 'anthropic') {
      if (!config.apiKey) return { ok: false, error: 'API key required' };
      currentBackend = new AnthropicBackend(
        { apiKey: config.apiKey, model: config.model || 'claude-haiku-4-5' },
        outboundGate,
      );
      currentBackendDetail = `anthropic · ${config.model || 'claude-haiku-4-5'}`;
    } else if (kind === 'remote') {
      if (!config.apiBase || !config.model) return { ok: false, error: 'apiBase and model required' };
      const key = config.apiKey || '';
      currentBackend = new RemoteBackend({ apiBase: config.apiBase, model: config.model, getApiKey: async () => key }, outboundGate);
      currentBackendDetail = `remote · ${config.model}`;
    } else {
      currentBackend = heuristicBackend;
      currentBackendDetail = 'heuristic';
    }
    return { ok: true, name: currentBackend.name, network: currentBackend.network };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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

ipcMain.handle('session:summarize', async (_e, force: boolean) => {
  if (!session) return null;
  try {
    return await session.summarize(currentBackend, !!force);
  } catch (err) {
    return { summary: '', moments: [], error: (err as Error).message };
  }
});

ipcMain.handle('session:highlights', async (_e, force: boolean) => {
  if (!session) return null;
  try {
    const h = await session.getHighlights(currentBackend, !!force);
    // Attach segment timing so the UI can seek without recomputing.
    const byId = new Map(session.candidates.map((c) => [c.id, c]));
    return {
      highlights: h.highlights.map((x) => ({
        ...x,
        start: byId.get(x.id)?.start ?? 0,
        end: byId.get(x.id)?.end ?? 0,
      })),
      source: currentBackend.name,
    };
  } catch (err) {
    return { highlights: [], error: (err as Error).message };
  }
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
  return { network: currentBackend.network, text };
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
      hasAudio: session.analysis.hasAudio,
      overlayPngs,
      onWarn: (w) => (warn = w),
    });
    return { ok: true, output: r.output, bytes: r.bytes, seconds: r.seconds, warn };
  } catch (err) {
    return { ok: false, error: (err as Error).message.split('\n')[0] };
  }
});

/**
 * Extract filmstrip thumbnails for the current video (once per file, cached by
 * content hash). Interval adapts to duration so we generate ≤ ~320 frames.
 * The renderer loads them via the pvemedia:// protocol.
 */
ipcMain.handle('thumbs:ensure', async () => {
  if (!session || !sourcePath) return null;
  const hash = session.analysis.fileHash;
  const dur = session.analysis.durationSec;
  const interval = [1, 2, 5, 10, 15, 30].find((i) => dur / i <= 320) ?? 60;
  const dir = join(app.getPath('userData'), 'thumbs', `${hash}-${interval}`);
  const count = Math.max(1, Math.floor(dur / interval));
  if (!existsSync(join(dir, 't0001.jpg'))) {
    await mkdir(dir, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', [
        '-y', '-i', sourcePath!,
        '-vf', `fps=1/${interval},scale=160:-2`,
        '-q:v', '6',
        join(dir, 't%04d.jpg'),
      ]);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg thumbs exited ${code}`))));
      p.on('error', reject);
    });
  }
  return { dir, interval, count };
});

/** If a sample clip exists, tell the renderer so it can offer a one-click load. */
ipcMain.handle('sample:path', async () => {
  const p = join(process.cwd(), 'samples', 'buildlog.mp4');
  return existsSync(p) ? p : null;
});

/** A video path passed on the command line (open-with / drag-to-dock) auto-imports. */
ipcMain.handle('initial:file', async () => {
  const arg = process.argv.find((a) => /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(a) && existsSync(a));
  return arg ?? null;
});

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime',
  '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
};

app.whenReady().then(async () => {
  // Pick the best available brain BEFORE the window loads, so the first
  // summary/highlights/chat all use a real model when one exists.
  await autoSelectBackend();

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
