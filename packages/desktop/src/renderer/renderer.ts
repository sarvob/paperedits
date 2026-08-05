import type { Edl, SegmentEntry } from '@pve/core';

// Shapes returned by the preload bridge (kept loose on purpose).
interface Snapshot {
  edl: Edl;
  durationSec: number;
  digestText: string;
  tokens: number;
  timeline: string[];
  sourcePath: string | null;
}
interface Check { name: string; ok: boolean; required: boolean; detail: string }
interface PveApi {
  systemCheck(): Promise<{ lines: Check[] }>;
  openFile(): Promise<string | null>;
  samplePath(): Promise<string | null>;
  import(path: string): Promise<{ ok: boolean; error?: string } & Partial<Snapshot>>;
  prompt(i: string): Promise<{ ok: boolean; rejected?: boolean; errors?: string[]; interpretation?: string } & Partial<Snapshot>>;
  undo(): Promise<({ label: string | null } & Snapshot) | null>;
  redo(): Promise<({ label: string | null } & Snapshot) | null>;
  setSpeed(id: string, speed: number): Promise<Snapshot | null>;
  outbound(i: string): Promise<{ network: boolean; text: string }>;
  export(out?: string | null): Promise<{ ok: boolean; output?: string; bytes?: number; seconds?: number; warn?: string; error?: string }>;
}
declare global {
  interface Window { pve: PveApi }
}
const pve = window.pve;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

let current: Snapshot | null = null;

// ---- rendering ------------------------------------------------------------
function renderTimeline(s: Snapshot) {
  const tl = $('timeline');
  tl.innerHTML = '';
  const totalSource = s.edl.entries.reduce(
    (a, e) => a + (e.kind === 'segment' ? e.sourceEnd - e.sourceStart : 2),
    0,
  );
  for (const e of s.edl.entries) {
    const div = document.createElement('div');
    if (e.kind === 'card') {
      div.className = 'block card';
      div.innerHTML = `<span class="lbl">▤</span>`;
      div.title = `card: ${e.text}`;
    } else {
      const span = e.sourceEnd - e.sourceStart;
      div.className = `block ${e.class === 'key' ? 'key' : 'fast'}`;
      div.style.flex = String(span / totalSource);
      div.innerHTML =
        `<span class="spd">${e.speed}×</span>` +
        (e.pinned ? `<span class="pin">📌</span>` : '') +
        `<span class="lbl">${e.label ? escapeHtml(e.label) : ''}</span>`;
      div.title = `#${e.index} ${fmt(e.sourceStart)}–${fmt(e.sourceEnd)} · ${e.class} · ${e.speed}×`;
      div.onclick = () => $(`row-${e.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    tl.appendChild(div);
  }
  $('ruler').innerHTML = `<span>0:00</span><span>${fmt(s.durationSec)}</span>`;
}

function renderEdl(s: Snapshot) {
  const wrap = $('edl');
  wrap.innerHTML = '';
  for (const e of s.edl.entries) {
    const row = document.createElement('div');
    row.id = `row-${e.id}`;
    if (e.kind === 'card') {
      row.className = 'row key';
      row.innerHTML = `<span class="dot"></span><span class="idx">▤</span><span class="time"></span>
        <span class="lbl"><span class="cardtag">CARD</span> ${escapeHtml(e.text)}</span><span></span><span></span>`;
      wrap.appendChild(row);
      continue;
    }
    const seg = e as SegmentEntry;
    row.className = `row ${seg.class === 'key' ? 'key' : 'fast'}`;
    row.innerHTML = `
      <span class="dot"></span>
      <span class="idx">#${seg.index}</span>
      <span class="time">${fmt(seg.sourceStart)}–${fmt(seg.sourceEnd)}</span>
      <span class="lbl">${seg.label ? escapeHtml(seg.label) : '<span class="muted">—</span>'}</span>
      <select data-id="${seg.id}">
        ${[1, 2, 4, 6, 8, 10, 12, 16].map((v) => `<option value="${v}" ${v === seg.speed ? 'selected' : ''}>${v}×</option>`).join('')}
      </select>
      <span class="pin">${seg.pinned ? '📌' : ''}</span>`;
    wrap.appendChild(row);
  }
  wrap.querySelectorAll<HTMLSelectElement>('select').forEach((sel) => {
    sel.onchange = async () => {
      const snap = await pve.setSpeed(sel.dataset.id!, Number(sel.value));
      if (snap) apply(snap);
      toast(`set ${sel.dataset.id} → ${sel.value}× (pinned)`);
    };
  });
}

function renderHistory(s: Snapshot) {
  const ol = $('history');
  ol.innerHTML = s.timeline.map((t, i) => `<li class="${i === s.timeline.length - 1 ? 'current' : ''}">${escapeHtml(t)}</li>`).join('');
}

function apply(s: Snapshot) {
  current = s;
  $('fileName').textContent = s.sourcePath ? s.sourcePath.split('/').pop()! : 'no file';
  $('workspace').hidden = false;
  $('emptyState').hidden = true;
  (['undoBtn', 'redoBtn', 'exportBtn'] as const).forEach((id) => (($(id) as HTMLButtonElement).disabled = false));
  renderTimeline(s);
  renderEdl(s);
  renderHistory(s);
}

// ---- actions --------------------------------------------------------------
async function importPath(path: string) {
  toast('Importing… (whisper + scan)');
  const res = await pve.import(path);
  if (!res.ok) return toast(res.error || 'import failed', true);
  apply(res as Snapshot);
  $('outbound').textContent = res.digestText || '';
  toast('Imported.');
}

async function applyInstruction() {
  const input = $('cmd') as HTMLInputElement;
  const text = input.value.trim();
  if (!text || !current) return;
  const res = await pve.prompt(text);
  const interp = $('interpretation');
  if (!res.ok) {
    interp.className = 'interpretation err';
    interp.textContent = res.rejected ? `Rejected: ${(res.errors || []).join('; ')}` : (res as { error?: string }).error || 'failed';
    return;
  }
  interp.className = 'interpretation';
  interp.textContent = `→ ${res.interpretation}`;
  input.value = '';
  apply(res as Snapshot);
}

async function refreshOutbound(text: string) {
  if (!text.trim()) return;
  const o = await pve.outbound(text);
  $('outboundStatus').textContent = o.network
    ? '⚠️ Remote backend selected — this text WOULD be sent.'
    : 'Local mode — 0 bytes leave. (Preview of what a remote backend would send.)';
  $('outbound').textContent = o.text;
}

async function doExport() {
  toast('Rendering… (single ffmpeg encode)');
  const r = await pve.export();
  if (!r.ok) return toast(r.error || 'render failed', true);
  const mb = (r.bytes! / 1e6).toFixed(1);
  toast(`✓ Exported ${r.output!.split('/').pop()} — ${mb} MB in ${r.seconds!.toFixed(1)}s${r.warn ? ' (labels not burned)' : ''}`);
}

// ---- system check panel ---------------------------------------------------
async function renderChecks() {
  const rep = await pve.systemCheck();
  $('checks').innerHTML = rep.lines
    .map((l) => {
      const cls = l.ok ? 'ok' : l.required ? 'bad' : 'opt';
      const mark = l.ok ? '✓' : l.required ? '✗' : '○';
      return `<li><span class="${cls}">${mark}</span> ${escapeHtml(l.name)} <span style="opacity:.6">— ${escapeHtml(l.detail)}</span></li>`;
    })
    .join('');
}

// ---- misc -----------------------------------------------------------------
let toastTimer: number | undefined;
function toast(msg: string, err = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${err ? ' err' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), 3200);
}
function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

// ---- wire up --------------------------------------------------------------
$('openBtn').onclick = async () => {
  const p = await pve.openFile();
  if (p) importPath(p);
};
$('applyBtn').onclick = applyInstruction;
$('cmd').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') applyInstruction();
});
$('cmd').addEventListener('input', (e) => refreshOutbound((e.target as HTMLInputElement).value));
$('undoBtn').onclick = async () => { const s = await pve.undo(); if (s) apply(s); };
$('redoBtn').onclick = async () => { const s = await pve.redo(); if (s) apply(s); };
$('exportBtn').onclick = doExport;

(async () => {
  await renderChecks();
  const sample = await pve.samplePath();
  if (sample) {
    const btn = $('sampleBtn') as HTMLButtonElement;
    btn.hidden = false;
    btn.onclick = () => importPath(sample);
  }
})();
