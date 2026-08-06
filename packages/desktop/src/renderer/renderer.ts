import type { Edl, EdlEntry, Overlay, SegmentEntry } from '@pve/core';

interface Snapshot {
  edl: Edl;
  durationSec: number;
  digestText: string;
  tokens: number;
  timeline: string[];
  sourcePath: string | null;
  mediaUrl: string | null;
  audioLevels: number[];
  activityPerSec: number[];
  agentPlan: PlanItem[] | null;
}
interface Highlight { id: string; title: string; why: string; score: number; start: number; end: number }
interface PlanItem { id: string; speed: number; reason: string }
interface ThumbInfo { dir: string; interval: number; count: number }
interface Check { name: string; ok: boolean; required: boolean; detail: string }
interface PveApi {
  systemCheck(): Promise<{ lines: Check[] }>;
  openFile(): Promise<string | null>;
  samplePath(): Promise<string | null>;
  initialFile(): Promise<string | null>;
  import(path: string): Promise<{ ok: boolean; error?: string } & Partial<Snapshot>>;
  onImportProgress(cb: (p: { stage: string; pct: number }) => void): () => void;
  onImportEnriched(cb: (s: Snapshot) => void): () => void;
  onSummaryPartial(cb: (p: { summary: string; coveredSec: number; totalSec: number }) => void): () => void;
  prompt(i: string): Promise<{ ok: boolean; rejected?: boolean; errors?: string[]; interpretation?: string } & Partial<Snapshot>>;
  undo(): Promise<Snapshot | null>;
  redo(): Promise<Snapshot | null>;
  setSpeed(id: string, speed: number): Promise<Snapshot | null>;
  outbound(i: string): Promise<{ network: boolean; text: string }>;
  chat(message: string): Promise<{ ok: boolean; kind?: 'edit' | 'answer'; text?: string; usedFallback?: boolean; error?: string } & Partial<Snapshot>>;
  ollamaModels(): Promise<{ ok: boolean; models: string[] }>;
  setBackend(kind: string, config: unknown): Promise<{ ok: boolean; name?: string; network?: boolean; error?: string }>;
  currentBackend(): Promise<{ name: string; detail: string; network: boolean }>;
  thumbsEnsure(): Promise<ThumbInfo | null>;
  summarize(force?: boolean): Promise<{ summary: string; moments: { id: string; label: string }[]; error?: string } | null>;
  highlights(force?: boolean): Promise<{ highlights: Highlight[]; source?: string; error?: string } | null>;
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
let momentLabels = new Map<string, string>(); // candidateId → one-line summary
let currentHighlights: Highlight[] = []; // ranked key moments
let agentPlan: PlanItem[] = []; // per-segment agent decisions (plan track)
let thumbs: ThumbInfo | null = null; // filmstrip thumbnails for the source
let zoomFactor = 1; // 1 = fit; ×2 per zoom-in step
let lastPps = 1; // px per output-second at the current zoom (set by renderTracks)

const thumbUrl = (idx: number) =>
  thumbs ? `pvemedia://local/${encodeURIComponent(`${thumbs.dir}/t${String(idx).padStart(4, '0')}.jpg`)}` : '';

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
let audioOn = true; // user's mute toggle; fast sections still auto-mute

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
  // Match export audio semantics: fast sections (>3x) and explicitly muted
  // segments are silent; everything else plays audio (unless the user muted).
  v.muted = !audioOn || seg.speed > 3 || seg.audio === 'mute';
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
  // The single vertical bar that cuts across all tracks.
  const px = playhead * lastPps;
  $('playheadLine').style.left = `${px}px`;
  // Keep the playhead visible while playing (auto-scroll the track view).
  if (playing) {
    const tracks = $('tracks');
    if (px < tracks.scrollLeft || px > tracks.scrollLeft + tracks.clientWidth - 40) {
      tracks.scrollLeft = Math.max(0, px - tracks.clientWidth / 2);
    }
  }
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
  const { items } = computeSpans(s.edl);
  for (const ov of s.edl.overlays) {
    const w = overlaySpan(s.edl, ov, items);
    if (!w) continue;
    const pill = document.createElement('div');
    pill.className = `ov-pill${ov.id === selectedOverlay ? ' selected' : ''}`;
    pill.style.left = `${w.start * lastPps}px`;
    pill.style.width = `${Math.max(14, (w.end - w.start) * lastPps)}px`;
    pill.textContent = ov.kind === 'emoji' ? ov.content : ov.content.slice(0, 14);
    pill.onclick = (ev) => { ev.stopPropagation(); selectOverlay(ov.id); seek(w.start + 0.05); };
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
/** Pick a "nice" ruler step so ticks land every ~90px. */
function niceStep(rough: number): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
  return steps.find((s) => s >= rough) ?? 1800;
}

/**
 * Render the aligned track stack — ruler, clips, audio, overlays — all sharing
 * one horizontal time scale (px/sec), with a single playhead line cutting
 * across every track. Zoom widens the scale so clip contents become legible.
 */
function renderTracks(s: Snapshot) {
  const { items, total } = computeSpans(s.edl);
  const containerW = $('tracks').clientWidth || 800;
  const pps = (containerW / Math.max(0.001, total)) * zoomFactor;
  lastPps = pps;
  const W = Math.max(containerW, Math.ceil(total * pps));
  const inner = $('tracksInner');
  inner.style.width = `${W}px`;

  // Ruler
  const ruler = $('ruler');
  ruler.innerHTML = '';
  const step = niceStep(90 / pps);
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('div');
    tick.className = 'tick';
    tick.style.left = `${t * pps}px`;
    tick.textContent = fmt(t);
    ruler.appendChild(tick);
  }

  // Clips (★ ring on LLM-ranked highlights)
  const clips = $('trackClips');
  clips.innerHTML = '';
  const hlIds = new Set(currentHighlights.map((h) => h.id));
  for (const it of items) {
    const e = s.edl.entries.find((x) => x.id === it.id)!;
    const div = document.createElement('div');
    div.style.left = `${it.outStart * pps}px`;
    div.style.width = `${Math.max(3, (it.outEnd - it.outStart) * pps - 1)}px`;
    if (e.kind === 'card') {
      div.className = 'clip card';
      div.innerHTML = `<span class="c-lbl">▤ ${escapeHtml(e.text)}</span>`;
    } else {
      div.className = `clip ${e.class === 'key' ? 'key' : 'fast'}${hlIds.has(e.candidateId) ? ' hl' : ''}`;
      const moment = momentLabels.get(e.candidateId) || e.label || '';
      div.innerHTML =
        `<span class="c-spd">${e.speed}×${e.pinned ? ' 📌' : ''}</span>` +
        `<span class="c-lbl">${escapeHtml(moment)}</span>`;
      div.title = `${fmt(e.sourceStart)}–${fmt(e.sourceEnd)} · ${e.class} · ${e.speed}×${moment ? ` · ${moment}` : ''}`;
    }
    div.onclick = (ev) => { ev.stopPropagation(); stop(); seek(it.outStart + 0.05); };
    clips.appendChild(div);
  }

  // Audio track — per-pixel loudness sampled through the edit (output time →
  // source time via each segment's speed), so it stays aligned with the clips.
  const cv = $('trackAudio') as HTMLCanvasElement;
  cv.width = W;
  cv.style.width = `${W}px`;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, W, 26);
  ctx.fillStyle = 'rgba(91,140,255,0.75)';
  const levels = s.audioLevels?.length ? s.audioLevels : null;
  let idx = 0;
  for (let x = 0; x < W; x += 2) {
    const outT = x / pps;
    while (idx < items.length - 1 && outT >= items[idx]!.outEnd) idx++;
    const it = items[idx];
    let lvl = 0;
    if (it && outT >= it.outStart && outT < it.outEnd) {
      if (it.seg) {
        const src = it.seg.sourceStart + (outT - it.outStart) * it.seg.speed;
        lvl = levels ? (levels[Math.floor(src)] ?? 0) : (s.activityPerSec[Math.floor(src)] ?? 0) * 0.6;
      } else {
        lvl = 0.12; // card: near-silent bed
      }
    }
    const h = Math.max(1, lvl * 22);
    ctx.fillRect(x, 13 - h / 2, 1.5, h);
  }

  // Filmstrip — whole frames only, side by side. Each slot is a fixed 96px so
  // a frame is always fully visible; how much time one frame spans depends on
  // zoom (shown in the caption). Slots map output-time → source-time through
  // the edit, so the strip stays aligned with the clips above it.
  const film = $('trackFilm');
  film.innerHTML = '';
  if (thumbs) {
    const slotW = 96;
    const slots = Math.floor(W / slotW);
    let fIdx = 0;
    for (let i = 0; i < slots; i++) {
      const x = i * slotW;
      const outT = (x + slotW / 2) / pps;
      while (fIdx < items.length - 1 && outT >= items[fIdx]!.outEnd) fIdx++;
      const it = items[fIdx];
      if (!it || outT < it.outStart || outT >= it.outEnd || !it.seg) continue;
      const src = it.seg.sourceStart + (outT - it.outStart) * it.seg.speed;
      const idx = Math.min(thumbs.count, Math.max(1, Math.floor(src / thumbs.interval) + 1));
      const img = document.createElement('img');
      img.className = 'film-frame';
      img.src = thumbUrl(idx);
      img.loading = 'lazy';
      img.style.left = `${x}px`;
      img.title = `source ${fmt(src)}`;
      film.appendChild(img);
    }
    const spanPerFrame = Math.max(1, Math.round(slotW / pps));
    $('filmScale').textContent = `1 frame ≈ ${spanPerFrame}s of video · zoom + for more frames`;
  } else {
    $('filmScale').textContent = '';
  }

  // Agent plan track — the agent's per-segment decision (1× keep vs N× fast)
  // with its reason. Appears under the audio track after a plan-producing edit.
  const planTrack = $('trackPlan');
  planTrack.innerHTML = '';
  planTrack.hidden = agentPlan.length === 0;
  if (agentPlan.length) {
    const byCand = new Map(agentPlan.map((p) => [p.id, p]));
    for (const it of items) {
      if (!it.seg) continue;
      const p = byCand.get(it.seg.candidateId);
      if (!p) continue;
      const div = document.createElement('div');
      const w = Math.max(4, (it.outEnd - it.outStart) * pps - 2);
      div.className = `plan-block ${p.speed === 1 ? 'plan-keep' : 'plan-fast'}`;
      div.style.left = `${it.outStart * pps}px`;
      div.style.width = `${w}px`;
      div.textContent = w > 120 ? `${p.speed === 1 ? '✓ 1×' : `⏩ ${p.speed}×`} — ${p.reason}` : p.speed === 1 ? '✓ 1×' : `⏩${p.speed}×`;
      div.title = p.reason;
      planTrack.appendChild(div);
    }
  }

  renderOverlayTrack(s);
  paintPlayhead();
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
    // Lead with the AI one-line moment summary (falls back to the label/speech).
    const moment = momentLabels.get(seg.candidateId) || seg.label || '';
    row.className = `row ${seg.class === 'key' ? 'key' : 'fast'}`;
    row.innerHTML = `
      <span class="dot"></span>
      <span class="time">${fmt(seg.sourceStart)}–${fmt(seg.sourceEnd)}</span>
      <span class="lbl">${moment ? escapeHtml(moment) : '<span class="muted">…</span>'}</span>
      <select data-id="${seg.id}">${[1, 2, 4, 6, 8, 10, 12, 16].map((v) => `<option value="${v}" ${v === seg.speed ? 'selected' : ''}>${v}×</option>`).join('')}</select>
      <span class="pin">${seg.pinned ? '📌' : ''}</span>`;
    // Click a moment → seek the preview to it.
    row.onclick = (ev) => {
      if ((ev.target as HTMLElement).matches('select')) return;
      const spans = computeSpans(s.edl).items.find((x) => x.id === seg.id);
      if (spans) seek(spans.outStart + 0.05);
    };
    wrap.appendChild(row);
  }
  wrap.querySelectorAll<HTMLSelectElement>('select').forEach((sel) => {
    sel.onchange = async () => { const snap = await pve.setSpeed(sel.dataset.id!, Number(sel.value)); if (snap) apply(snap, { keepPlayhead: true }); };
  });
}

/** Fetch + render the LLM-ranked key moments (which segments matter and why). */
async function requestHighlights(force = false) {
  $('hlSrc').textContent = 'ranking…';
  const res = await pve.highlights(force);
  if (!res) return;
  currentHighlights = res.highlights || [];
  $('hlSrc').textContent = res.error ? `(${res.error.slice(0, 60)})` : `via ${res.source ?? 'heuristic'}`;
  renderHighlights();
  if (current) renderTracks(current); // repaint ★ rings on clips
}

function renderHighlights() {
  const el = $('highlights');
  el.innerHTML = '';
  if (!currentHighlights.length) {
    el.innerHTML = '<span class="muted-note">No highlights identified yet.</span>';
    return;
  }
  currentHighlights.forEach((h, i) => {
    const card = document.createElement('div');
    card.className = 'hl-card';
    card.innerHTML =
      `<span class="hl-rank">#${i + 1}</span>` +
      `<span class="hl-time">${fmt(h.start)}</span>` +
      `<span class="hl-title">${escapeHtml(h.title)}</span>` +
      `<span class="hl-why">${escapeHtml(h.why)}</span>`;
    card.onclick = () => {
      if (!current) return;
      const seg = current.edl.entries.find((e) => e.kind === 'segment' && e.candidateId === h.id);
      const sp = seg && computeSpans(current.edl).items.find((x) => x.id === seg.id);
      stop();
      seek(sp ? sp.outStart + 0.05 : 0);
    };
    el.appendChild(card);
  });
}

let finalSummaryShown = false; // once the full-digest summary lands, ignore late partials

// Progressive summary drafts stream in while whisper is still transcribing.
pve.onSummaryPartial(({ summary, coveredSec, totalSec }) => {
  if (finalSummaryShown) return;
  $('summary').hidden = false;
  $('summarySrc').textContent = `first ${fmt(coveredSec)} of ${fmt(totalSec)} · refining…`;
  const el = $('summaryText');
  el.className = 'summary-text';
  el.textContent = summary;
});

async function requestSummary(force = false) {
  $('summary').hidden = false;
  const textEl = $('summaryText');
  const hasPartialDraft = !finalSummaryShown && !!textEl.textContent?.trim() && !textEl.classList.contains('loading');
  if (hasPartialDraft) {
    // Keep the progressive draft on screen while the full summary computes.
    $('summarySrc').textContent = 'finalizing…';
  } else if (force || !textEl.textContent?.trim() || textEl.classList.contains('loading')) {
    textEl.className = 'summary-text loading';
    textEl.textContent = 'Summarizing…';
  }
  const res = await pve.summarize(force);
  if (!res) { $('summary').hidden = true; return; }
  textEl.className = 'summary-text';
  textEl.textContent = res.summary || '(no summary)';
  const active = ($('backendSel') as HTMLSelectElement).value;
  $('summarySrc').textContent = active === 'heuristic' ? 'from transcript' : `via ${active}`;
  finalSummaryShown = true;
  momentLabels = new Map(res.moments.map((m) => [m.id, m.label]));
  if (current) renderEdl(current);
}
function renderHistory(s: Snapshot) {
  // Defensive: a missing panel must never break the apply() chain.
  const el = document.getElementById('history');
  if (!el) return;
  el.innerHTML = s.timeline.map((t, i) => `<li class="${i === s.timeline.length - 1 ? 'current' : ''}">${escapeHtml(t)}</li>`).join('');
}

// ---- apply a snapshot ------------------------------------------------------
function apply(s: Snapshot, opts: { keepPlayhead?: boolean } = {}) {
  current = s;
  if (s.agentPlan) agentPlan = s.agentPlan;
  $('fileName').textContent = s.sourcePath ? s.sourcePath.split('/').pop()! : 'no file';
  $('workspace').hidden = false;
  $('emptyState').hidden = true;
  (['undoBtn', 'redoBtn', 'exportBtn'] as const).forEach((id) => (($(id) as HTMLButtonElement).disabled = false));
  const v = video();
  if (s.mediaUrl && v.getAttribute('src') !== s.mediaUrl) { v.setAttribute('src', s.mediaUrl); }
  if (!opts.keepPlayhead) playhead = 0;
  renderTracks(s);
  renderOverlayLayer(s);
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
  // Partial summaries stream DURING the import await — arm them now, and clear
  // any previous video's summary so drafts don't mix.
  finalSummaryShown = false;
  $('summaryText').textContent = '';
  $('summary').hidden = true;
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
  momentLabels = new Map();
  apply(res as Snapshot);
  const v = video();
  if ((res as Snapshot).mediaUrl) { v.setAttribute('src', (res as Snapshot).mediaUrl!); v.load(); }
  startPaintLoop();
  $('outbound').textContent = (res as Snapshot).digestText || '';
  toast(`Imported ${path.split('/').pop()}`);
  // Generate the summary, per-moment labels, and ranked highlights.
  currentHighlights = [];
  agentPlan = [];
  thumbs = null;
  finalSummaryShown = false;
  renderHighlights();
  requestSummary();
  requestHighlights();
  // Filmstrip thumbnails extract in the background (cached per file after that).
  pve.thumbsEnsure().then((t) => {
    thumbs = t;
    if (current) renderTracks(current);
  }).catch(() => {});
}
// ---- chat -----------------------------------------------------------------
function addMsg(cls: string, text: string): HTMLElement {
  const el = document.createElement('div');
  el.className = `msg ${cls}`;
  el.textContent = text;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}
async function sendChat() {
  const input = $('chatInput') as HTMLInputElement;
  const text = input.value.trim();
  if (!text) return;
  if (!current) { addMsg('bot err', 'Import a video first.'); return; }
  addMsg('user', text);
  input.value = '';
  const thinking = addMsg('bot thinking', 'thinking…');
  const res = await pve.chat(text);
  thinking.remove();
  if (!res || !res.ok) { addMsg('bot err', (res as { error?: string })?.error || 'something went wrong'); return; }
  if (res.kind === 'edit') {
    addMsg('bot edit', `✓ ${res.text}${res.usedFallback ? '  (heuristic)' : ''}`);
    apply(res as unknown as Snapshot, { keepPlayhead: true });
  } else {
    addMsg('bot', res.text || '(no answer)');
  }
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
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') sendChat(); });
$('chatInput').addEventListener('input', (e) => refreshOutbound((e.target as HTMLInputElement).value));
$('undoBtn').onclick = async () => { const s = await pve.undo(); if (s) apply(s, { keepPlayhead: true }); };
$('redoBtn').onclick = async () => { const s = await pve.redo(); if (s) apply(s, { keepPlayhead: true }); };
$('exportBtn').onclick = doExport;
$('importErrorDismiss').onclick = () => {
  $('importError').hidden = true;
  if (!current) $('emptyState').hidden = false;
};
$('playBtn').onclick = playPause;
$('muteBtn').onclick = () => {
  audioOn = !audioOn;
  $('muteBtn').textContent = audioOn ? '🔊' : '🔇';
  syncVideoTo(playhead);
};
$('summaryRefresh').onclick = () => requestSummary(true);
$('hlRefresh').onclick = () => requestHighlights(true);
// Click anywhere on the tracks → seek there (the playhead follows).
$('tracksInner').addEventListener('mousedown', (e) => {
  const rect = $('tracksInner').getBoundingClientRect();
  stop();
  seek(((e as MouseEvent).clientX - rect.left) / lastPps);
});
$('zoomIn').onclick = () => { zoomFactor = Math.min(32, zoomFactor * 2); if (current) renderTracks(current); };
$('zoomOut').onclick = () => { zoomFactor = Math.max(1, zoomFactor / 2); if (current) renderTracks(current); };
$('zoomFit').onclick = () => { zoomFactor = 1; if (current) renderTracks(current); };
$('scrub').addEventListener('input', (e) => { stop(); seek((Number((e.target as HTMLInputElement).value) / 1000) * totalDur()); });
$('addText').onclick = addTextOverlay;
$('stage').addEventListener('mousedown', (e) => { const id = (e.target as HTMLElement).id; if (id === 'previewCanvas' || id === 'overlayLayer') selectOverlay(null); });
// Repaint the canvas whenever the decode source produces a new frame.
for (const ev of ['seeked', 'loadeddata', 'canplay']) video().addEventListener(ev, drawFrame);

// Background visual pass finished: the digest now carries frame captions.
// Refresh views without disturbing the playhead, edits, or chat.
pve.onImportEnriched((s) => {
  apply(s, { keepPlayhead: true });
  $('outbound').textContent = s.digestText || '';
  toast('👁 Frame captions added — the agent can now see the video');
  requestSummary(true);
  requestHighlights(true);
});

// ---- backend selector ------------------------------------------------------
let modelsLoaded = false;
async function loadOllamaModels() {
  const picker = $('modelPicker');
  const { ok, models } = await pve.ollamaModels();
  if (!ok || !models.length) {
    picker.innerHTML = '<span style="font-size:11px;color:var(--muted)">No Ollama models found. Run e.g. <code>ollama pull llama3.2:3b</code></span>';
    return;
  }
  picker.innerHTML = '';
  models.forEach((m) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" value="${m}" ${m.includes('llama3.2:3b') ? 'checked' : ''} /> <span>${escapeHtml(m)}</span><span class="ord"></span>`;
    label.querySelector('input')!.addEventListener('change', updateModelOrder);
    picker.appendChild(label);
  });
  updateModelOrder();
  modelsLoaded = true;
}
function checkedModels(): string[] {
  return [...document.querySelectorAll<HTMLInputElement>('#modelPicker input:checked')].map((i) => i.value);
}
function updateModelOrder() {
  const checked = checkedModels();
  document.querySelectorAll<HTMLElement>('#modelPicker label').forEach((l) => {
    const v = l.querySelector('input')!.value;
    const idx = checked.indexOf(v);
    l.querySelector('.ord')!.textContent = idx >= 0 && checked.length > 1 ? `#${idx + 1}` : '';
  });
}
$('backendSel').addEventListener('change', () => {
  const kind = ($('backendSel') as HTMLSelectElement).value;
  $('ollamaCfg').hidden = kind !== 'ollama';
  $('anthropicCfg').hidden = kind !== 'anthropic';
  $('remoteCfg').hidden = kind !== 'remote';
  if (kind === 'ollama' && !modelsLoaded) loadOllamaModels();
});
$('applyBackend').onclick = async () => {
  const kind = ($('backendSel') as HTMLSelectElement).value;
  const config: Record<string, unknown> = {};
  if (kind === 'ollama') {
    const models = checkedModels();
    if (!models.length) return toast('select at least one model', true);
    config.models = models;
  }
  if (kind === 'anthropic') {
    config.model = ($('anthropicModel') as HTMLSelectElement).value;
    config.apiKey = ($('anthropicKey') as HTMLInputElement).value.trim();
    if (!config.apiKey) return toast('enter your Anthropic API key', true);
  }
  if (kind === 'remote') {
    config.apiBase = ($('remoteBase') as HTMLInputElement).value.trim();
    config.model = ($('remoteModel') as HTMLInputElement).value.trim();
    config.apiKey = ($('remoteKey') as HTMLInputElement).value;
  }
  const r = await pve.setBackend(kind, config);
  if (!r.ok) return toast(r.error || 'could not set backend', true);
  const scope = r.network ? 'remote' : 'local';
  const detail = kind === 'ollama' && checkedModels().length > 1 ? `cascade: ${checkedModels().join(' → ')}` : r.name;
  $('backendStatus').className = `be-status${r.network ? ' net' : ''}`;
  $('backendStatus').textContent = `Active: ${detail} (${scope})`;
  const badge = document.querySelector('.brand .mode');
  if (badge) badge.textContent = `${scope} · ${r.name}`;
  toast(`Backend: ${detail}`);
};

(async () => {
  // Reflect the auto-selected backend (Ollama when available) before anything
  // else runs, so summary/highlights labels and the chat all show the truth.
  const cur = await pve.currentBackend();
  $('backendStatus').textContent = `Active: ${cur.detail} (${cur.network ? 'remote' : 'local'})`;
  const badge = document.querySelector('.brand .mode');
  if (badge) badge.textContent = `${cur.network ? 'remote' : 'local'} · ${cur.name}`;
  if (cur.name === 'ollama') ($('backendSel') as HTMLSelectElement).value = 'ollama';
  if (cur.name === 'heuristic') {
    addMsg('bot', 'Heads up: no AI model is active (Ollama isn\'t running), so answers will be rough. Start Ollama or pick Anthropic API in the Intelligence panel.');
  }

  await renderChecks();
  const emojiRow = $('emojiRow');
  for (const em of EMOJIS) { const b = document.createElement('button'); b.textContent = em; b.onclick = () => addEmojiOverlay(em); emojiRow.appendChild(b); }
  const sample = await pve.samplePath();
  if (sample) { const btn = $('sampleBtn') as HTMLButtonElement; btn.hidden = false; btn.onclick = () => importPath(sample); }
  // Auto-import a file passed on the command line (open-with / drag-to-dock).
  const initial = await pve.initialFile();
  if (initial) importPath(initial);
})();
