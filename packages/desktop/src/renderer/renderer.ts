import type { Edl, EdlEntry, Overlay, SegmentEntry } from '@pve/core';

interface Snapshot {
  edl: Edl;
  durationSec: number;
  digestText: string;
  tokens: number;
  timeline: string[];
  sourcePath: string | null;
  mediaUrl: string | null;
}
interface Check { name: string; ok: boolean; required: boolean; detail: string }
interface PveApi {
  systemCheck(): Promise<{ lines: Check[] }>;
  openFile(): Promise<string | null>;
  samplePath(): Promise<string | null>;
  initialFile(): Promise<string | null>;
  import(path: string): Promise<{ ok: boolean; error?: string } & Partial<Snapshot>>;
  onImportProgress(cb: (p: { stage: string; pct: number }) => void): () => void;
  prompt(i: string): Promise<{ ok: boolean; rejected?: boolean; errors?: string[]; interpretation?: string } & Partial<Snapshot>>;
  undo(): Promise<Snapshot | null>;
  redo(): Promise<Snapshot | null>;
  setSpeed(id: string, speed: number): Promise<Snapshot | null>;
  outbound(i: string): Promise<{ network: boolean; text: string }>;
  setBackend(kind: string, config: unknown): Promise<{ ok: boolean; name?: string; network?: boolean; error?: string }>;
  addOverlay(o: unknown): Promise<Snapshot | null>;
  updateOverlay(id: string, patch: unknown, label: string): Promise<Snapshot | null>;
  removeOverlay(id: string): Promise<Snapshot | null>;
  export(out: string | null, overlayPngs: Record<string, string>): Promise<{ ok: boolean; output?: string; bytes?: number; seconds?: number; warn?: string; error?: string }>;
}
declare global { interface Window { pve: PveApi } }
const pve = window.pve;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const EMOJIS = ['🔥', '✨', '✅', '👉', '❤️', '😂', '🎯', '⭐'];

let current: Snapshot | null = null;
let selectedOverlay: string | null = null;

// ---- output-timeline math (mirrors @pve/core outputSpans) ------------------
interface SpanItem { id: string; kind: 'segment' | 'card'; outStart: number; outEnd: number; seg?: SegmentEntry }
function computeSpans(edl: Edl): { items: SpanItem[]; total: number } {
  const items: SpanItem[] = [];
  let t = 0;
  for (const e of edl.entries) {
    const len = e.kind === 'card' ? e.durationSec : (e.sourceEnd - e.sourceStart) / e.speed;
    items.push({ id: e.id, kind: e.kind, outStart: t, outEnd: t + len, seg: e.kind === 'segment' ? e : undefined });
    t += len;
  }
  return { items, total: t };
}
function overlaySpan(edl: Edl, ov: Overlay, spans: SpanItem[]): { start: number; end: number } | null {
  if (ov.anchor.mode === 'output') return { start: ov.anchor.start, end: ov.anchor.start + ov.anchor.duration };
  const s = spans.find((x) => x.id === ov.anchor.segmentId);
  return s ? { start: s.outStart, end: s.outEnd } : null;
}

// ---- preview engine --------------------------------------------------------
const video = () => $('preview') as HTMLVideoElement;
let playhead = 0;
let playing = false;
let raf = 0;
let lastTs = 0;

/** Draw the current (hidden) video frame onto the visible canvas, letterboxed. */
function drawFrame() {
  const v = video();
  const cv = $('previewCanvas') as HTMLCanvasElement;
  const st = $('stage');
  const W = st.clientWidth, H = st.clientHeight;
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  if (v.videoWidth && v.readyState >= 2) {
    const s = Math.min(W / v.videoWidth, H / v.videoHeight);
    const w = v.videoWidth * s, h = v.videoHeight * s;
    try { ctx.drawImage(v, (W - w) / 2, (H - h) / 2, w, h); } catch { /* frame not ready */ }
  }
}

/** Continuously mirror the decoded video frame onto the canvas — the reliable
 * way to keep the preview live regardless of paused seeks or compositor quirks. */
let paintStarted = false;
function startPaintLoop() {
  if (paintStarted) return;
  paintStarted = true;
  const loop = () => { drawFrame(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

function totalDur(): number {
  return current ? computeSpans(current.edl).total : 0;
}
function segAt(t: number): SpanItem | null {
  if (!current) return null;
  const { items } = computeSpans(current.edl);
  return items.find((it) => t >= it.outStart && t < it.outEnd) ?? items[items.length - 1] ?? null;
}
function syncVideoTo(t: number) {
  const it = segAt(t);
  const splash = $('cardSplash');
  const v = video();
  if (!it) return;
  if (it.kind === 'card') {
    v.pause();
    const card = current!.edl.entries.find((e) => e.id === it.id) as Extract<EdlEntry, { kind: 'card' }>;
    splash.textContent = card?.text ?? '';
    splash.hidden = false;
    return;
  }
  splash.hidden = true;
  const seg = it.seg!;
  const expected = seg.sourceStart + (t - it.outStart) * seg.speed;
  if (Math.abs(v.currentTime - expected) > 0.25) v.currentTime = expected;
  v.playbackRate = clamp(seg.speed, 0.0625, 16);
}
function tick(ts: number) {
  if (!playing) return;
  const dt = (ts - lastTs) / 1000;
  lastTs = ts;
  playhead += dt;
  const total = totalDur();
  if (playhead >= total) { playhead = total; stop(); return; }
  const it = segAt(playhead);
  const v = video();
  if (it?.kind === 'segment') { if (v.paused) v.play().catch(() => {}); syncVideoTo(playhead); }
  else { v.pause(); syncVideoTo(playhead); }
  drawFrame();
  paintPlayhead();
  raf = requestAnimationFrame(tick);
}
function playPause() { playing ? stop() : start(); }
function start() {
  if (!current) return;
  if (playhead >= totalDur() - 0.05) playhead = 0;
  playing = true;
  $('playBtn').textContent = '⏸';
  lastTs = performance.now();
  const it = segAt(playhead);
  if (it?.kind === 'segment') video().play().catch(() => {});
  raf = requestAnimationFrame(tick);
}
function stop() {
  playing = false;
  $('playBtn').textContent = '▶';
  cancelAnimationFrame(raf);
  video().pause();
}
function seek(t: number) {
  playhead = clamp(t, 0, totalDur());
  syncVideoTo(playhead);
  drawFrame();
  paintPlayhead();
}
function paintPlayhead() {
  const total = totalDur();
  ($('scrub') as HTMLInputElement).value = String(total ? (playhead / total) * 1000 : 0);
  $('tc').textContent = `${fmt(playhead)} / ${fmt(total)}`;
  updateOverlayVisibility();
}

// ---- overlay layer (live, draggable) --------------------------------------
function renderOverlayLayer(s: Snapshot) {
  const layer = $('overlayLayer');
  layer.innerHTML = '';
  const stageH = $('stage').clientHeight || 300;
  for (const ov of s.edl.overlays) {
    const el = document.createElement('div');
    el.className = `ov${ov.box ? ' box' : ''}${ov.id === selectedOverlay ? ' selected' : ''}`;
    el.dataset.id = ov.id;
    el.textContent = ov.content;
    el.style.left = `${ov.x * 100}%`;
    el.style.top = `${ov.y * 100}%`;
    el.style.fontSize = `${ov.size * stageH}px`;
    if (ov.color) el.style.color = ov.color;
    attachDrag(el, ov);
    layer.appendChild(el);
  }
  updateOverlayVisibility();
}
function updateOverlayVisibility() {
  if (!current) return;
  const spans = computeSpans(current.edl).items;
  const byId = new Map(current.edl.overlays.map((o) => [o.id, o]));
  for (const el of Array.from($('overlayLayer').children) as HTMLElement[]) {
    const ov = byId.get(el.dataset.id!);
    if (!ov) continue;
    const w = overlaySpan(current.edl, ov, spans);
    el.style.display = w && playhead >= w.start - 0.01 && playhead < w.end ? '' : 'none';
  }
}
function attachDrag(el: HTMLElement, ov: Overlay) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    selectOverlay(ov.id);
    const rect = $('stage').getBoundingClientRect();
    el.classList.add('dragging');
    let nx = ov.x, ny = ov.y;
    const move = (ev: MouseEvent) => {
      nx = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      ny = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      el.style.left = `${nx * 100}%`;
      el.style.top = `${ny * 100}%`;
    };
    const up = async () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      el.classList.remove('dragging');
      const snap = await pve.updateOverlay(ov.id, { x: nx, y: ny }, 'move overlay');
      if (snap) apply(snap, { keepPlayhead: true });
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
function selectOverlay(id: string | null) {
  selectedOverlay = id;
  if (current) { renderOverlayLayer(current); renderOverlayTrack(current); renderOverlayPanel(current); }
}

// ---- overlay track + sidebar list -----------------------------------------
function renderOverlayTrack(s: Snapshot) {
  const track = $('overlayTrack');
  track.innerHTML = '';
  const { items, total } = computeSpans(s.edl);
  for (const ov of s.edl.overlays) {
    const w = overlaySpan(s.edl, ov, items);
    if (!w || !total) continue;
    const pill = document.createElement('div');
    pill.className = `ov-pill${ov.id === selectedOverlay ? ' selected' : ''}`;
    pill.style.left = `${(w.start / total) * 100}%`;
    pill.style.width = `${Math.max(3, ((w.end - w.start) / total) * 100)}%`;
    pill.textContent = ov.kind === 'emoji' ? ov.content : ov.content.slice(0, 14);
    pill.onclick = () => { selectOverlay(ov.id); seek(w.start + 0.05); };
    track.appendChild(pill);
  }
}
function renderOverlayPanel(s: Snapshot) {
  $('overlayPanel').hidden = s.edl.overlays.length === 0;
  const list = $('overlayList');
  list.innerHTML = '';
  const { items } = computeSpans(s.edl);
  for (const ov of s.edl.overlays) {
    const w = overlaySpan(s.edl, ov, items)!;
    const item = document.createElement('div');
    item.className = `ov-item${ov.id === selectedOverlay ? ' selected' : ''}`;
    const anchored = ov.anchor.mode === 'segment';
    item.innerHTML = `
      <div class="ov-content">
        <input type="text" value="${escapeHtml(ov.content)}" data-id="${ov.id}" class="ov-text" />
        <button class="ov-del" data-id="${ov.id}" title="Delete">✕</button>
      </div>
      <div class="ov-timing">
        ${anchored
          ? `<span class="ov-anchored">rides with clip · ${fmt(w.start)}–${fmt(w.end)}</span>`
          : `start <input type="number" step="0.1" min="0" value="${w.start.toFixed(1)}" data-id="${ov.id}" class="ov-start" />s
             dur <input type="number" step="0.1" min="0.2" value="${(w.end - w.start).toFixed(1)}" data-id="${ov.id}" class="ov-dur" />s`}
      </div>`;
    item.onclick = (e) => { if (!(e.target as HTMLElement).matches('input,button')) selectOverlay(ov.id); };
    list.appendChild(item);
  }
  // wire inputs
  list.querySelectorAll<HTMLInputElement>('.ov-text').forEach((inp) => {
    inp.onchange = async () => { const s2 = await pve.updateOverlay(inp.dataset.id!, { content: inp.value }, 'edit text'); if (s2) apply(s2, { keepPlayhead: true }); };
  });
  list.querySelectorAll<HTMLButtonElement>('.ov-del').forEach((btn) => {
    btn.onclick = async () => { const s2 = await pve.removeOverlay(btn.dataset.id!); if (s2) { selectedOverlay = null; apply(s2, { keepPlayhead: true }); } };
  });
  const retime = async (id: string) => {
    const startEl = list.querySelector<HTMLInputElement>(`.ov-start[data-id="${id}"]`);
    const durEl = list.querySelector<HTMLInputElement>(`.ov-dur[data-id="${id}"]`);
    if (!startEl || !durEl) return;
    const s2 = await pve.updateOverlay(id, { anchor: { mode: 'output', start: Number(startEl.value), duration: Number(durEl.value) } }, 'retime overlay');
    if (s2) apply(s2, { keepPlayhead: true });
  };
  list.querySelectorAll<HTMLInputElement>('.ov-start,.ov-dur').forEach((inp) => { inp.onchange = () => retime(inp.dataset.id!); });
}

async function addTextOverlay() {
  const snap = await pve.addOverlay({ kind: 'text', content: 'New text', x: 0.5, y: 0.5, size: 0.07, color: '#ffffff', box: true, anchor: { mode: 'output', start: Math.round(playhead * 10) / 10, duration: 3 } });
  if (snap) { selectNewest(snap); apply(snap, { keepPlayhead: true }); }
}
async function addEmojiOverlay(emoji: string) {
  const snap = await pve.addOverlay({ kind: 'emoji', content: emoji, x: 0.5, y: 0.4, size: 0.14, box: false, anchor: { mode: 'output', start: Math.round(playhead * 10) / 10, duration: 3 } });
  if (snap) { selectNewest(snap); apply(snap, { keepPlayhead: true }); }
}
function selectNewest(s: Snapshot) { selectedOverlay = s.edl.overlays[s.edl.overlays.length - 1]?.id ?? null; }

// ---- timeline / edl / history / checks ------------------------------------
function renderTimeline(s: Snapshot) {
  const tl = $('timeline');
  tl.innerHTML = '';
  const totalSource = s.edl.entries.reduce((a, e) => a + (e.kind === 'segment' ? e.sourceEnd - e.sourceStart : 2), 0);
  for (const e of s.edl.entries) {
    const div = document.createElement('div');
    if (e.kind === 'card') { div.className = 'block card'; div.innerHTML = `<span class="lbl">▤</span>`; }
    else {
      const span = e.sourceEnd - e.sourceStart;
      div.className = `block ${e.class === 'key' ? 'key' : 'fast'}`;
      div.style.flex = String(span / totalSource);
      div.innerHTML = `<span class="spd">${e.speed}×</span>${e.pinned ? '<span class="pin">📌</span>' : ''}<span class="lbl">${e.label ? escapeHtml(e.label) : ''}</span>`;
    }
    tl.appendChild(div);
  }
  $('ruler').innerHTML = `<span>0:00</span><span>${fmt(totalDur())}</span>`;
}
function renderEdl(s: Snapshot) {
  const wrap = $('edl');
  wrap.innerHTML = '';
  for (const e of s.edl.entries) {
    const row = document.createElement('div');
    row.id = `row-${e.id}`;
    if (e.kind === 'card') {
      row.className = 'row key';
      row.innerHTML = `<span class="dot"></span><span class="idx">▤</span><span class="time"></span><span class="lbl"><span class="cardtag">CARD</span> ${escapeHtml(e.text)}</span><span></span><span></span>`;
      wrap.appendChild(row); continue;
    }
    const seg = e as SegmentEntry;
    row.className = `row ${seg.class === 'key' ? 'key' : 'fast'}`;
    row.innerHTML = `
      <span class="dot"></span><span class="idx">#${seg.index}</span>
      <span class="time">${fmt(seg.sourceStart)}–${fmt(seg.sourceEnd)}</span>
      <span class="lbl">${seg.label ? escapeHtml(seg.label) : '<span class="muted">—</span>'}</span>
      <select data-id="${seg.id}">${[1, 2, 4, 6, 8, 10, 12, 16].map((v) => `<option value="${v}" ${v === seg.speed ? 'selected' : ''}>${v}×</option>`).join('')}</select>
      <span class="pin">${seg.pinned ? '📌' : ''}</span>`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll<HTMLSelectElement>('select').forEach((sel) => {
    sel.onchange = async () => { const snap = await pve.setSpeed(sel.dataset.id!, Number(sel.value)); if (snap) apply(snap); };
  });
}
function renderHistory(s: Snapshot) {
  $('history').innerHTML = s.timeline.map((t, i) => `<li class="${i === s.timeline.length - 1 ? 'current' : ''}">${escapeHtml(t)}</li>`).join('');
}

// ---- apply a snapshot ------------------------------------------------------
function apply(s: Snapshot, opts: { keepPlayhead?: boolean } = {}) {
  current = s;
  $('fileName').textContent = s.sourcePath ? s.sourcePath.split('/').pop()! : 'no file';
  $('workspace').hidden = false;
  $('emptyState').hidden = true;
  (['undoBtn', 'redoBtn', 'exportBtn'] as const).forEach((id) => (($(id) as HTMLButtonElement).disabled = false));
  const v = video();
  if (s.mediaUrl && v.getAttribute('src') !== s.mediaUrl) { v.setAttribute('src', s.mediaUrl); }
  if (!opts.keepPlayhead) playhead = 0;
  renderTimeline(s);
  renderOverlayLayer(s);
  renderOverlayTrack(s);
  renderOverlayPanel(s);
  renderEdl(s);
  renderHistory(s);
  seek(playhead);
}

// ---- import / prompt / export ---------------------------------------------
const STAGE_LABEL: Record<string, string> = {
  scan: 'Scanning container (activity + scene cuts)',
  transcribe: 'Transcribing audio (whisper)',
  visual: 'Analyzing frames',
  caption: 'Captioning keyframes',
  segment: 'Segmenting',
  done: 'Done',
};
async function importPath(path: string) {
  // Show the persistent importing panel (not a transient toast) so it's always
  // clear whether processing is happening.
  $('emptyState').hidden = true;
  $('importError').hidden = true;
  $('workspace').hidden = true;
  $('importing').hidden = false;
  $('impStage').textContent = 'starting';
  ($('impFill') as HTMLElement).style.width = '3%';

  const off = pve.onImportProgress(({ stage, pct }) => {
    $('impStage').textContent = STAGE_LABEL[stage] ?? stage;
    ($('impFill') as HTMLElement).style.width = `${pct}%`;
  });

  let res;
  try {
    res = await pve.import(path);
  } finally {
    off();
  }
  $('importing').hidden = true;

  if (!res.ok) {
    // Persistent, dismissible error with the real reason.
    $('importError').hidden = false;
    if (!current) $('emptyState').hidden = true;
    $('importErrorMsg').textContent = res.error || 'unknown error';
    return;
  }
  apply(res as Snapshot);
  const v = video();
  if ((res as Snapshot).mediaUrl) { v.setAttribute('src', (res as Snapshot).mediaUrl!); v.load(); }
  startPaintLoop();
  $('outbound').textContent = (res as Snapshot).digestText || '';
  toast(`Imported ${path.split('/').pop()}`);
}
async function applyInstruction() {
  const input = $('cmd') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !current) return;
  const res = await pve.prompt(text);
  const interp = $('interpretation');
  if (!res.ok) { interp.className = 'interpretation err'; interp.textContent = res.rejected ? `Rejected: ${(res.errors || []).join('; ')}` : (res as { error?: string }).error || 'failed'; return; }
  interp.className = 'interpretation';
  interp.textContent = `→ ${res.interpretation}`;
  input.value = '';
  apply(res as Snapshot, { keepPlayhead: true });
}

/** Rasterize one overlay to a transparent PNG data URL via canvas (no freetype). */
function rasterizeOverlay(ov: Overlay, frameH: number): string {
  const scale = 2;
  const fontPx = ov.size * frameH;
  const pad = fontPx * 0.28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const font = `600 ${fontPx}px system-ui, -apple-system, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(ov.content).width;
  const w = Math.ceil(textW + pad * 2);
  const h = Math.ceil(fontPx * 1.35 + (ov.box ? pad : 0));
  canvas.width = w * scale; canvas.height = h * scale;
  ctx.scale(scale, scale);
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (ov.box) { ctx.fillStyle = 'rgba(0,0,0,0.5)'; roundRect(ctx, 0, 0, w, h, pad * 0.5); ctx.fill(); }
  ctx.fillStyle = ov.color || '#ffffff';
  ctx.fillText(ov.content, w / 2, h / 2);
  return canvas.toDataURL('image/png');
}
function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
async function doExport() {
  if (!current) return;
  toast('Rendering… (single ffmpeg encode)');
  const frameH = video().videoHeight || 720;
  const pngs: Record<string, string> = {};
  for (const ov of current.edl.overlays) pngs[ov.id] = rasterizeOverlay(ov, frameH);
  const r = await pve.export(null, pngs);
  if (!r.ok) return toast(r.error || 'render failed', true);
  toast(`✓ Exported ${r.output!.split('/').pop()} — ${(r.bytes! / 1e6).toFixed(1)} MB in ${r.seconds!.toFixed(1)}s`);
}

async function refreshOutbound(text: string) {
  if (!text.trim()) return;
  const o = await pve.outbound(text);
  $('outboundStatus').textContent = o.network ? '⚠️ Remote backend — this text WOULD be sent.' : 'Local mode — 0 bytes leave. (Preview of what a remote backend would send.)';
  $('outbound').textContent = o.text;
}
async function renderChecks() {
  const rep = await pve.systemCheck();
  $('checks').innerHTML = rep.lines.map((l) => {
    const cls = l.ok ? 'ok' : l.required ? 'bad' : 'opt';
    const mark = l.ok ? '✓' : l.required ? '✗' : '○';
    return `<li><span class="${cls}">${mark}</span> ${escapeHtml(l.name)} <span style="opacity:.6">— ${escapeHtml(l.detail)}</span></li>`;
  }).join('');
}

// ---- misc -----------------------------------------------------------------
let toastTimer: number | undefined;
function toast(msg: string, err = false) {
  const t = $('toast'); t.textContent = msg; t.className = `toast${err ? ' err' : ''}`; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => (t.hidden = true), 3400);
}
function escapeHtml(s: string) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!); }

// ---- wire up --------------------------------------------------------------
$('openBtn').onclick = async () => { const p = await pve.openFile(); if (p) importPath(p); };
$('applyBtn').onclick = applyInstruction;
$('cmd').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') applyInstruction(); });
$('cmd').addEventListener('input', (e) => refreshOutbound((e.target as HTMLInputElement).value));
$('undoBtn').onclick = async () => { const s = await pve.undo(); if (s) apply(s, { keepPlayhead: true }); };
$('redoBtn').onclick = async () => { const s = await pve.redo(); if (s) apply(s, { keepPlayhead: true }); };
$('exportBtn').onclick = doExport;
$('importErrorDismiss').onclick = () => {
  $('importError').hidden = true;
  if (!current) $('emptyState').hidden = false;
};
$('playBtn').onclick = playPause;
$('scrub').addEventListener('input', (e) => { stop(); seek((Number((e.target as HTMLInputElement).value) / 1000) * totalDur()); });
$('addText').onclick = addTextOverlay;
$('stage').addEventListener('mousedown', (e) => { const id = (e.target as HTMLElement).id; if (id === 'previewCanvas' || id === 'overlayLayer') selectOverlay(null); });
// Repaint the canvas whenever the decode source produces a new frame.
for (const ev of ['seeked', 'loadeddata', 'canplay']) video().addEventListener(ev, drawFrame);

// ---- backend selector ------------------------------------------------------
$('backendSel').addEventListener('change', () => {
  const kind = ($('backendSel') as HTMLSelectElement).value;
  $('ollamaCfg').hidden = kind !== 'ollama';
  $('remoteCfg').hidden = kind !== 'remote';
});
$('applyBackend').onclick = async () => {
  const kind = ($('backendSel') as HTMLSelectElement).value;
  const config: Record<string, string> = {};
  if (kind === 'ollama') config.model = ($('ollamaModel') as HTMLInputElement).value.trim();
  if (kind === 'remote') {
    config.apiBase = ($('remoteBase') as HTMLInputElement).value.trim();
    config.model = ($('remoteModel') as HTMLInputElement).value.trim();
    config.apiKey = ($('remoteKey') as HTMLInputElement).value;
  }
  const r = await pve.setBackend(kind, config);
  if (!r.ok) return toast(r.error || 'could not set backend', true);
  const scope = r.network ? 'remote' : 'local';
  $('backendStatus').className = `be-status${r.network ? ' net' : ''}`;
  $('backendStatus').textContent = `Active: ${r.name} (${scope})`;
  const badge = document.querySelector('.brand .mode');
  if (badge) badge.textContent = `${scope} · ${r.name}`;
  toast(`Backend: ${r.name}`);
};

(async () => {
  await renderChecks();
  const emojiRow = $('emojiRow');
  for (const em of EMOJIS) { const b = document.createElement('button'); b.textContent = em; b.onclick = () => addEmojiOverlay(em); emojiRow.appendChild(b); }
  const sample = await pve.samplePath();
  if (sample) { const btn = $('sampleBtn') as HTMLButtonElement; btn.hidden = false; btn.onclick = () => importPath(sample); }
  // Auto-import a file passed on the command line (open-with / drag-to-dock).
  const initial = await pve.initialFile();
  if (initial) importPath(initial);
})();
