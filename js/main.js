import { openSource } from './source.js';
import { analyze, detectShifts, thumbAt } from './analyze.js';
import * as R from './ranges.js';
import { placeCaption, layoutScript, readTime, drawCaptions, activeCaptions, fmtTime, clamp, newId } from './captions.js';
import { loadStyle, saveStyle, DEFAULT_STYLE, PRESETS, FONTS } from './style.js';
import { exportMp4, MAX_OUTPUT } from './export.js';

const $ = (s) => document.querySelector(s);
const video = $('#video');
const preview = $('#preview');
const pctx = preview.getContext('2d', { willReadFrequently: true });
const srcTl = $('#srcTl');
const outTl = $('#outTl');

// ------------------------------------------------------------------ state
const S = {
  src: null,
  samples: [],
  autoMarks: [],
  removedAuto: [],
  userMarks: [],
  ranges: [],
  captions: [],
  style: loadStyle(),
  mode: 'edit',
  inPoint: null,
  sensitivity: 0.5,
  view: { s: 0, e: 1 },
  analyzing: null,
  selCap: null,
};
const contrast = new Map();
const undoStack = [], redoStack = [];
let dirty = true;

window.cutline = S; // handy for debugging in devtools

// ------------------------------------------------------------------ helpers
function toast(msg, kind = '', ms = 4200) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
const outDuration = () => R.totalDuration(S.ranges);
const marks = () => {
  const auto = S.autoMarks.filter(t => !S.removedAuto.some(r => Math.abs(r - t) < 1e-3));
  return [...new Set([...auto, ...S.userMarks].map(t => +t.toFixed(3)))].sort((a, b) => a - b);
};
function segmentAt(t) {
  const m = marks();
  let s = 0, e = S.src ? S.src.duration : 0;
  for (const x of m) { if (x <= t + 1e-3) s = x; else { e = x; break; } }
  return { s, e };
}
const snapshot = () => JSON.stringify({ r: S.ranges, u: S.userMarks, a: S.removedAuto, c: S.captions });
function restore(js) {
  const o = JSON.parse(js);
  S.ranges = o.r; S.userMarks = o.u; S.removedAuto = o.a; S.captions = o.c;
  changed();
}
function mutate(fn) {
  const before = snapshot();
  fn();
  if (snapshot() !== before) { undoStack.push(before); if (undoStack.length > 200) undoStack.shift(); redoStack.length = 0; }
  changed();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }

let saveTimer = 0;
function changed() {
  dirty = true;
  updateMeter();
  renderCapList();
  drawTimelines();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveProject, 400);
}
function saveProject() {
  if (!S.src) return;
  try {
    localStorage.setItem('cutline:' + S.src.id, JSON.stringify({
      ranges: S.ranges, userMarks: S.userMarks, removedAuto: S.removedAuto,
      captions: S.captions, script: $('#scriptText').value, savedAt: Date.now(),
    }));
  } catch { /* quota — ignore */ }
}
function loadProject(id) {
  try { return JSON.parse(localStorage.getItem('cutline:' + id) || 'null'); } catch { return null; }
}

// ------------------------------------------------------------------ opening
async function open(arg) {
  const busy = $('#busy');
  busy.hidden = false;
  $('#busyText').textContent = arg instanceof File ? `Opening ${arg.name}…` : 'Connecting to stream…';
  S.analyzing?.abort();
  if (S.src) { S.src.dispose(); S.src = null; }
  try {
    const src = await openSource(arg, video);
    S.src = src;
    Object.assign(S, { samples: [], autoMarks: [], removedAuto: [], userMarks: [], ranges: [], captions: [], inPoint: null, selCap: null });
    undoStack.length = redoStack.length = 0;
    contrast.clear();
    S.view = { s: 0, e: src.duration };
    const saved = loadProject(src.id);
    if (saved) {
      S.ranges = saved.ranges || []; S.userMarks = saved.userMarks || [];
      S.removedAuto = saved.removedAuto || []; S.captions = saved.captions || [];
      $('#scriptText').value = saved.script || '';
      toast('Restored your previous edit of this video.');
    } else if (src.duration <= MAX_OUTPUT) {
      S.ranges = [{ s: 0, e: src.duration }];
    }
    document.body.classList.add('has-video');
    $('#emptyState').classList.add('hidden');
    $('#exportBtn').disabled = false;
    $('#srcInfo').textContent = `${src.name} · ${src.width}×${src.height} · ${src.fps.toFixed(2).replace(/\.00$/, '')} fps · ${fmtTime(src.duration)}${src.size ? ' · ' + fmtBytes(src.size) : ''}${src.audioTrack ? '' : ' · no audio'}`;
    sizePreview();
    changed();
    runAnalysis();
    if (!saved && src.duration > MAX_OUTPUT) {
      toast('Scrub to a moment and press Enter to keep that segment. Auto-markers split the video at scene shifts.', '', 7000);
    }
  } catch (err) {
    console.error(err);
    toast(err.message || String(err), 'err', 9000);
    if (!S.src) { $('#emptyState').classList.remove('hidden'); document.body.classList.remove('has-video'); }
  } finally {
    busy.hidden = true;
  }
}

async function runAnalysis() {
  const ac = new AbortController();
  S.analyzing = ac;
  const status = $('#anaStatus');
  status.textContent = 'Indexing key frames…';
  let lastDraw = 0;
  try {
    const samples = await analyze(S.src, {
      signal: ac.signal,
      onProgress: ({ phase, p }) => {
        status.textContent = phase === 'index' ? `Indexing key frames… ${Math.round(p * 100)}%`
          : phase === 'scan' ? `Detecting scene shifts… ${Math.round(p * 100)}%` : '';
      },
      onSample: (s, all) => {
        S.samples = all;
        const now = performance.now();
        if (now - lastDraw > 120) { lastDraw = now; drawTimelines(); }
      },
    });
    if (!samples || ac.signal.aborted) return;
    S.samples = samples;
    recomputeMarks();
    status.textContent = `${S.autoMarks.length} scene shifts · ${samples.length} frames sampled`;
  } catch (err) {
    console.error(err);
    status.textContent = 'Scene detection unavailable for this source.';
  }
}

function recomputeMarks() {
  if (!S.src) return;
  S.autoMarks = detectShifts(S.samples, S.src.duration, S.sensitivity);
  if (S.samples.length) $('#anaStatus').textContent = `${S.autoMarks.length} scene shifts · ${S.samples.length} frames sampled`;
  drawTimelines();
}

function fmtBytes(b) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b < 10 && i ? 1 : 0)} ${u[i]}`;
}

// ------------------------------------------------------------------ playback
function curOut() { return R.srcToOutSnap(S.ranges, video.currentTime); }
function seek(t) {
  if (!S.src) return;
  video.currentTime = clamp(t, 0, S.src.duration - 0.001);
  dirty = true;
}
function play() {
  if (!S.src) return;
  if (S.mode === 'edit') {
    if (!S.ranges.length) { setMode('source'); toast('Nothing kept yet — previewing the full source.'); }
    else {
      const r = R.rangeAtOrAfter(S.ranges, video.currentTime);
      if (!r) seek(S.ranges[0].s);
      else if (video.currentTime < r.s) seek(r.s);
      if (curOut() >= MAX_OUTPUT - 0.05) seek(S.ranges[0].s);
    }
  }
  video.play().catch(err => toast('Playback failed: ' + err.message, 'err'));
}
function togglePlay() { video.paused ? play() : video.pause(); }
function setMode(m) {
  S.mode = m;
  $('#modeEdit').classList.toggle('on', m === 'edit');
  $('#modeSource').classList.toggle('on', m === 'source');
  const b = $('#modeBadge');
  b.textContent = m === 'edit' ? 'EDIT PREVIEW' : 'SOURCE';
  b.classList.toggle('source', m === 'source');
  dirty = true;
}
video.addEventListener('play', () => { $('#playBtn').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('#playBtn').textContent = '▶'; dirty = true; });
video.addEventListener('seeked', () => { dirty = true; });

function enforceEditPlayback() {
  if (video.paused || S.mode !== 'edit' || !S.ranges.length) return;
  const t = video.currentTime;
  const r = R.rangeAtOrAfter(S.ranges, t);
  if (!r) { video.pause(); seek(S.ranges[0].s); return; }
  if (t < r.s - 0.02) video.currentTime = r.s;
  if (curOut() >= MAX_OUTPUT) { video.pause(); toast('Reached the 2:00 output limit.'); }
}

// ------------------------------------------------------------------ preview drawing
function sizePreview() {
  if (!S.src) return;
  const v = $('#viewer').getBoundingClientRect();
  const a = S.src.width / S.src.height;
  let cw = Math.min(v.width, v.height * a), ch = cw / a;
  const dpr = devicePixelRatio || 1;
  preview.style.width = cw + 'px';
  preview.style.height = ch + 'px';
  const iw = Math.min(S.src.width, Math.round(cw * dpr));
  preview.width = iw; preview.height = Math.round(iw / a);
  dirty = true;
}
new ResizeObserver(() => { sizePreview(); sizeTimelines(); }).observe($('#viewer'));

let capEls = [];
const SAMPLE = { id: '__sample', text: 'Sample caption — this is how it will look', start: 0, dur: 1e9 };
function frame() {
  enforceEditPlayback();
  if (S.src && (dirty || !video.paused)) {
    dirty = false;
    const W = preview.width, H = preview.height;
    pctx.fillStyle = '#000'; pctx.fillRect(0, 0, W, H);
    if (video.readyState >= 2) pctx.drawImage(video, 0, 0, W, H);
    const t = video.currentTime;
    const o = R.srcToOut(S.ranges, t);
    if (o !== null) drawCaptions(pctx, W, H, S.captions, S.style, o, contrast);
    // While styling with nothing on screen, show a sample so changes are visible.
    if (!$('#tab-style').hidden && (o === null || !activeCaptions(S.captions, o).length)) {
      drawCaptions(pctx, W, H, [SAMPLE], S.style, 1, contrast);
    }
    else if (S.mode === 'source') { // dim excluded material while browsing the source
      pctx.fillStyle = 'rgba(0,0,0,0.35)'; pctx.fillRect(0, 0, W, H);
      pctx.fillStyle = 'rgba(255,255,255,.75)'; pctx.font = `600 ${Math.max(11, H * 0.03)}px system-ui`;
      pctx.textAlign = 'left'; pctx.textBaseline = 'top';
      pctx.fillText('not in edit', H * 0.03, H * 0.03);
    }
    $('#tSrc').textContent = fmtTime(t, true);
    $('#tOut').textContent = o === null ? '—' : fmtTime(o, true);
    // highlight active captions in the list
    const act = new Set(o === null ? [] : activeCaptions(S.captions, o).map(c => c.id));
    for (const el of capEls) el.classList.toggle('active', act.has(el.dataset.id));
    followPlayhead();
    drawTimelines();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ------------------------------------------------------------------ meter
function updateMeter() {
  const d = outDuration();
  $('#meterFill').style.width = Math.min(100, d / MAX_OUTPUT * 100) + '%';
  $('#meterText').textContent = `${fmtTime(d)} / 2:00`;
  $('#meter').classList.toggle('over', d > MAX_OUTPUT);
  $('#meter').title = d > MAX_OUTPUT
    ? `Kept material is ${fmtTime(d)} — only the first 2:00 will be exported.`
    : 'Length of the exported video (max 2:00)';
}

// ------------------------------------------------------------------ timelines
const DPR = () => devicePixelRatio || 1;
function sizeTimelines() {
  for (const c of [srcTl, outTl]) {
    const r = c.getBoundingClientRect();
    c.width = Math.round(r.width * DPR()); c.height = Math.round(r.height * DPR());
  }
  drawTimelines();
}
let tlQueued = false;
function drawTimelines() {
  if (tlQueued) return;
  tlQueued = true;
  requestAnimationFrame(() => { tlQueued = false; drawSrcTl(); drawOutTl(); });
}

// geometry of the source timeline (CSS px)
const SG = { ruler: [0, 16], strip: [16, 78], graph: [78, 96], band: [98, 120] };
const tx = (t, w) => (t - S.view.s) / (S.view.e - S.view.s) * w;
const xt = (x, w) => S.view.s + x / w * (S.view.e - S.view.s);

function drawSrcTl() {
  const c = srcTl, ctx = c.getContext('2d'), dpr = DPR();
  const w = c.width / dpr, h = c.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#0b0c0f'; ctx.fillRect(0, 0, w, h);
  if (!S.src) return;
  const dur = S.src.duration;

  // ruler
  const span = S.view.e - S.view.s;
  const step = niceStep(span / (w / 90));
  ctx.fillStyle = '#6b7080'; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
  ctx.strokeStyle = '#262a33'; ctx.lineWidth = 1;
  for (let t = Math.ceil(S.view.s / step) * step; t <= S.view.e; t += step) {
    const x = Math.round(tx(t, w)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, 10); ctx.lineTo(x, 16); ctx.stroke();
    ctx.fillText(fmtTime(t, step < 1), x + 3, 2);
  }

  // filmstrip
  const [sy, ey] = SG.strip, sh = ey - sy;
  const aspect = S.src.width / S.src.height;
  const tw = Math.max(24, sh * aspect);
  if (S.samples.length) {
    for (let x = 0; x < w; x += tw) {
      const t = xt(x + tw / 2, w);
      if (t > dur) break;
      const bmp = thumbAt(S.samples, t);
      if (bmp) ctx.drawImage(bmp, x, sy, tw - 1, sh);
    }
  } else {
    ctx.fillStyle = '#16181d'; ctx.fillRect(0, sy, Math.min(w, tx(dur, w)), sh);
  }
  // dim excluded areas on the strip
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  let prev = 0;
  for (const r of [...S.ranges, { s: dur, e: dur }]) {
    const a = tx(prev, w), b = tx(r.s, w);
    if (b > a) ctx.fillRect(a, sy, b - a, sh);
    prev = r.e;
  }

  // score graph (how much the picture changes between samples)
  const [gy, gey] = SG.graph, gh = gey - gy;
  ctx.fillStyle = '#121419'; ctx.fillRect(0, gy, w, gh);
  if (S.samples.length > 1) {
    const maxS = Math.max(0.2, ...S.samples.map(s => s.score));
    ctx.beginPath(); ctx.moveTo(tx(S.samples[0].t, w), gey);
    for (const s of S.samples) ctx.lineTo(tx(s.t, w), gey - (s.score / maxS) * (gh - 2));
    ctx.lineTo(tx(S.samples[S.samples.length - 1].t, w), gey);
    ctx.fillStyle = 'rgba(255,176,32,0.28)'; ctx.fill();
  }

  // keep lane
  const [by, bey] = SG.band, bh = bey - by;
  ctx.fillStyle = '#15171c'; ctx.fillRect(0, by, Math.min(w, tx(dur, w)), bh);
  // segment boundaries (subtle)
  const ms = marks();
  ctx.fillStyle = 'rgba(61,220,132,0.9)';
  for (const r of S.ranges) {
    const a = tx(r.s, w), b = tx(r.e, w);
    if (b < 0 || a > w) continue;
    ctx.fillRect(a, by + 2, Math.max(1.5, b - a), bh - 4);
  }
  // 120s cap overlay on the lane
  if (outDuration() > MAX_OUTPUT) {
    const capS = R.outToSrc(S.ranges, MAX_OUTPUT);
    ctx.fillStyle = 'rgba(255,77,109,0.7)';
    for (const r of S.ranges) {
      const a = tx(Math.max(r.s, capS), w), b = tx(r.e, w);
      if (r.e > capS && b > a) ctx.fillRect(a, by + 2, b - a, bh - 4);
    }
  }
  // hover segment
  if (hover.t !== null && hover.y >= SG.strip[0]) {
    const seg = segmentAt(hover.t);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1;
    ctx.strokeRect(tx(seg.s, w) + 0.5, sy + 0.5, tx(seg.e, w) - tx(seg.s, w) - 1, bey - sy - 1);
  }

  // markers
  for (const t of ms) {
    const x = Math.round(tx(t, w)) + 0.5;
    if (x < -2 || x > w + 2) continue;
    const isUser = S.userMarks.some(u => Math.abs(u - t) < 1e-3);
    ctx.strokeStyle = isUser ? '#4cc9f0' : '#ffb020'; ctx.lineWidth = isUser ? 2 : 1.25;
    ctx.beginPath(); ctx.moveTo(x, sy); ctx.lineTo(x, bey); ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath(); ctx.moveTo(x - 4, sy); ctx.lineTo(x + 4, sy); ctx.lineTo(x, sy + 5); ctx.fill();
  }
  // in-point
  if (S.inPoint !== null) {
    const x = tx(S.inPoint, w);
    ctx.fillStyle = '#3ddc84';
    ctx.fillRect(x, sy, 2, bey - sy);
    ctx.font = '700 10px system-ui'; ctx.fillText('IN', x + 4, sy + 2);
  }
  // playhead
  const px = tx(video.currentTime, w);
  ctx.fillStyle = '#ff5a36'; ctx.fillRect(px - 1, 0, 2, h);
  ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 7); ctx.fill();
  // drag-paint preview
  if (drag?.kind === 'paint') {
    const a = tx(Math.min(drag.t0, drag.t1), w), b = tx(Math.max(drag.t0, drag.t1), w);
    ctx.fillStyle = drag.erase ? 'rgba(255,77,109,.5)' : 'rgba(61,220,132,.5)';
    ctx.fillRect(a, by, b - a, bh);
  }
}

function niceStep(x) {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
  return steps.find(s => s >= x) || 7200;
}

// output timeline geometry
const OG = { clips: [4, 36], caps: [42, 72] };
function outScale(w) { return w / Math.max(10, Math.min(Math.max(outDuration(), MAX_OUTPUT * 0.25), outDuration() * 1.02 + 1)); }

function drawOutTl() {
  const c = outTl, ctx = c.getContext('2d'), dpr = DPR();
  const w = c.width / dpr, h = c.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b0c0f'; ctx.fillRect(0, 0, w, h);
  if (!S.src) return;
  const k = outScale(w);
  const [cy, cey] = OG.clips, ch = cey - cy;
  const aspect = S.src.width / S.src.height;
  const tw = Math.max(20, ch * aspect);
  // clips
  let acc = 0;
  for (const r of S.ranges) {
    const a = acc * k, b = (acc + r.e - r.s) * k;
    ctx.save(); ctx.beginPath(); ctx.rect(a, cy, b - a, ch); ctx.clip();
    ctx.fillStyle = '#1b2a22'; ctx.fillRect(a, cy, b - a, ch);
    if (S.samples.length) {
      for (let x = a; x < b; x += tw) {
        const bmp = thumbAt(S.samples, r.s + (x - a + tw / 2) / k);
        if (bmp) ctx.drawImage(bmp, x, cy, tw, ch);
      }
    }
    ctx.restore();
    ctx.fillStyle = '#3ddc84'; ctx.fillRect(a, cey - 2, b - a, 2);
    ctx.fillStyle = '#0b0c0f'; ctx.fillRect(b - 1, cy, 2, ch);
    acc += r.e - r.s;
  }
  if (!S.ranges.length) {
    ctx.fillStyle = '#6b7080'; ctx.font = '12px system-ui'; ctx.textBaseline = 'middle';
    ctx.fillText('Nothing kept yet — press Enter on a segment, or drag on the green lane above.', 10, (cy + cey) / 2);
  }
  // over-limit region
  if (acc > MAX_OUTPUT) {
    ctx.fillStyle = 'rgba(255,77,109,0.35)';
    ctx.fillRect(MAX_OUTPUT * k, 0, w, h);
    ctx.fillStyle = '#ff4d6d'; ctx.fillRect(MAX_OUTPUT * k - 1, 0, 2, h);
    ctx.font = '600 10px system-ui'; ctx.textBaseline = 'top'; ctx.fillText('2:00 limit', MAX_OUTPUT * k + 4, 2);
  }
  // captions
  const [ky, key] = OG.caps, kh = key - ky;
  ctx.fillStyle = '#121419'; ctx.fillRect(0, ky, w, kh);
  ctx.font = '11px system-ui'; ctx.textBaseline = 'middle';
  for (const cap of S.captions) {
    const a = cap.start * k, b = (cap.start + cap.dur) * k;
    const sel = cap.id === S.selCap;
    const over = cap.start >= Math.min(acc, MAX_OUTPUT);
    ctx.fillStyle = over ? '#4a2230' : sel ? '#2b4f63' : '#2a2f3a';
    roundRect(ctx, a, ky + 2, Math.max(3, b - a - 1), kh - 4, 4);
    ctx.fillStyle = sel ? '#4cc9f0' : '#59606e';
    ctx.fillRect(a, ky + 2, 2, kh - 4);
    ctx.save(); ctx.beginPath(); ctx.rect(a + 4, ky, Math.max(0, b - a - 8), kh); ctx.clip();
    ctx.fillStyle = '#e8e9ec'; ctx.fillText(cap.text.replace(/\|/g, ' '), a + 6, ky + kh / 2);
    ctx.restore();
  }
  // playhead
  const o = R.srcToOut(S.ranges, video.currentTime);
  if (o !== null) { ctx.fillStyle = '#ff5a36'; ctx.fillRect(o * k - 1, 0, 2, h); }
  else { ctx.fillStyle = 'rgba(255,90,54,.45)'; const so = curOut() * k; ctx.fillRect(so - 1, 0, 2, h); }
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h); ctx.fill(); }

function followPlayhead() {
  if (!S.src || video.paused || drag) return;
  const t = video.currentTime, span = S.view.e - S.view.s;
  if (t > S.view.e - span * 0.05 || t < S.view.s) setView(t - span * 0.1, t + span * 0.9);
}
function setView(s, e) {
  const dur = S.src.duration;
  let span = clamp(e - s, Math.min(2, dur), dur);
  s = clamp(s, 0, dur - span);
  S.view = { s, e: s + span };
  drawTimelines();
}
function zoom(f, anchorT) {
  if (!S.src) return;
  const a = anchorT ?? video.currentTime;
  const s = a - (a - S.view.s) * f, e = a + (S.view.e - a) * f;
  setView(s, e);
}

// --- source timeline interaction
const hover = { t: null, y: 0 };
let drag = null;
function tlPos(e, c) {
  const r = c.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width };
}
srcTl.addEventListener('pointermove', (e) => {
  if (!S.src) return;
  const p = tlPos(e, srcTl);
  hover.t = clamp(xt(p.x, p.w), 0, S.src.duration); hover.y = p.y;
  const seg = segmentAt(hover.t);
  const kept = R.coverage(S.ranges, seg.s, seg.e) > 0.5;
  $('#hoverInfo').textContent = `${fmtTime(hover.t, true)} · segment ${fmtTime(seg.s, true)}–${fmtTime(seg.e, true)} ${kept ? '(kept)' : ''}`;
  if (drag?.kind === 'scrub') seek(hover.t);
  if (drag?.kind === 'paint') { drag.t1 = hover.t; drag.moved ||= Math.abs(p.x - drag.x0) > 4; }
  if (drag?.kind === 'pan') { const dt = (drag.x0 - p.x) / p.w * (S.view.e - S.view.s); setView(drag.v.s + dt, drag.v.e + dt); }
  drawTimelines();
});
srcTl.addEventListener('pointerleave', () => { hover.t = null; $('#hoverInfo').textContent = ''; drawTimelines(); });
srcTl.addEventListener('pointerdown', (e) => {
  if (!S.src) return;
  srcTl.setPointerCapture(e.pointerId);
  const p = tlPos(e, srcTl);
  const t = clamp(xt(p.x, p.w), 0, S.src.duration);
  if (e.button === 1) { drag = { kind: 'pan', x0: p.x, v: { ...S.view } }; return; }
  if (p.y >= SG.band[0] - 2) drag = { kind: 'paint', t0: t, t1: t, x0: p.x, erase: e.shiftKey || e.altKey, moved: false };
  else { drag = { kind: 'scrub' }; seek(t); }
});
srcTl.addEventListener('pointerup', () => {
  if (drag?.kind === 'paint') {
    const d = drag;
    if (!d.moved) toggleSegment(d.t0);
    else mutate(() => { S.ranges = d.erase ? R.subtractRange(S.ranges, d.t0, d.t1) : R.addRange(S.ranges, d.t0, d.t1); });
  }
  drag = null; drawTimelines();
});
srcTl.addEventListener('dblclick', (e) => {
  if (!S.src) return;
  const p = tlPos(e, srcTl);
  if (p.y < SG.band[0]) addMarker(clamp(xt(p.x, p.w), 0, S.src.duration));
});
srcTl.addEventListener('wheel', (e) => {
  if (!S.src) return;
  e.preventDefault();
  const p = tlPos(e, srcTl);
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    const d = (e.shiftKey ? e.deltaY : e.deltaX) / p.w * (S.view.e - S.view.s);
    setView(S.view.s + d, S.view.e + d);
  } else {
    zoom(Math.exp(e.deltaY * 0.0022), xt(p.x, p.w));
  }
}, { passive: false });

// --- output timeline interaction (seek + caption move/resize)
outTl.addEventListener('pointerdown', (e) => {
  if (!S.src) return;
  const p = tlPos(e, outTl), k = outScale(p.w);
  const o = p.x / k;
  if (p.y >= OG.caps[0]) {
    const hit = [...S.captions].reverse().find(c => p.x >= c.start * k - 4 && p.x <= (c.start + c.dur) * k + 4);
    if (hit) {
      outTl.setPointerCapture(e.pointerId);
      const a = hit.start * k, b = (hit.start + hit.dur) * k;
      const mode = Math.abs(p.x - a) < 7 ? 'l' : Math.abs(p.x - b) < 7 ? 'r' : 'move';
      drag = { kind: 'cap', id: hit.id, mode, x0: p.x, start: hit.start, dur: hit.dur, before: snapshot(), moved: false };
      S.selCap = hit.id;
      renderCapList(); scrollCapIntoView(hit.id);
      return;
    }
    S.selCap = null; renderCapList();
  }
  outTl.setPointerCapture(e.pointerId);
  drag = { kind: 'oscrub' };
  if (S.ranges.length) seek(R.outToSrc(S.ranges, clamp(o, 0, outDuration() - 0.001)));
});
outTl.addEventListener('pointermove', (e) => {
  if (!S.src) return;
  const p = tlPos(e, outTl), k = outScale(p.w);
  if (!drag) {
    const onCap = p.y >= OG.caps[0] && S.captions.find(c => Math.abs(p.x - c.start * k) < 7 || Math.abs(p.x - (c.start + c.dur) * k) < 7);
    outTl.style.cursor = onCap ? 'ew-resize' : p.y >= OG.caps[0] ? 'grab' : 'crosshair';
    return;
  }
  if (drag.kind === 'oscrub' && S.ranges.length) seek(R.outToSrc(S.ranges, clamp(p.x / k, 0, outDuration() - 0.001)));
  if (drag.kind === 'cap') {
    const cap = S.captions.find(c => c.id === drag.id);
    const d = (p.x - drag.x0) / k;
    drag.moved ||= Math.abs(p.x - drag.x0) > 2;
    if (drag.mode === 'move') cap.start = Math.max(0, drag.start + d);
    else if (drag.mode === 'l') { const ns = clamp(drag.start + d, 0, drag.start + drag.dur - 0.4); cap.dur = drag.start + drag.dur - ns; cap.start = ns; cap.manual = true; }
    else { cap.dur = Math.max(0.4, drag.dur + d); cap.manual = true; }
    contrast.delete(cap.id);
    dirty = true; drawTimelines();
    if (drag.moved && drag.mode === 'move') seek(R.outToSrc(S.ranges, cap.start + 0.01));
  }
});
outTl.addEventListener('pointerup', () => {
  if (drag?.kind === 'cap' && drag.moved) {
    S.captions.sort((a, b) => a.start - b.start);
    undoStack.push(drag.before); redoStack.length = 0;
    changed();
  } else if (drag?.kind === 'cap') {
    const cap = S.captions.find(c => c.id === drag.id);
    if (cap) seek(R.outToSrc(S.ranges, cap.start + 0.01));
  }
  drag = null;
});

// ------------------------------------------------------------------ segment ops
function toggleSegment(t) {
  if (!S.src) return;
  const seg = segmentAt(t);
  const kept = R.coverage(S.ranges, seg.s, seg.e) > 0.5;
  mutate(() => { S.ranges = kept ? R.subtractRange(S.ranges, seg.s, seg.e) : R.addRange(S.ranges, seg.s, seg.e); });
  if (!kept && outDuration() > MAX_OUTPUT) toast(`Kept material is now ${fmtTime(outDuration())} — export stops at 2:00.`);
}
function dropSegment(t) {
  const seg = segmentAt(t);
  mutate(() => { S.ranges = R.subtractRange(S.ranges, seg.s, seg.e); });
}
function addMarker(t) {
  mutate(() => { if (!marks().some(m => Math.abs(m - t) < 0.05)) S.userMarks.push(+t.toFixed(3)); S.userMarks.sort((a, b) => a - b); });
}
function removeNearestMarker(t) {
  const ms = marks();
  if (!ms.length) return;
  const nearest = ms.reduce((a, b) => Math.abs(b - t) < Math.abs(a - t) ? b : a);
  const tol = Math.max(0.75, (S.view.e - S.view.s) * 0.015);
  if (Math.abs(nearest - t) > tol) { toast('No marker near the playhead.'); return; }
  mutate(() => {
    const ui = S.userMarks.findIndex(u => Math.abs(u - nearest) < 1e-3);
    if (ui >= 0) S.userMarks.splice(ui, 1); else S.removedAuto.push(nearest);
  });
}
function jumpMarker(dir) {
  const t = video.currentTime;
  const ms = [0, ...marks(), S.src.duration];
  const target = dir > 0 ? ms.find(m => m > t + 0.04) : [...ms].reverse().find(m => m < t - 0.04);
  if (target !== undefined) seek(target);
}

// ------------------------------------------------------------------ captions UI
const capInput = $('#capInput');
let anchorOut = null, autoPaused = false;
capInput.addEventListener('input', () => {
  if (capInput.value && anchorOut === null) {
    anchorOut = curOut();
    if (!video.paused && $('#pauseTyping').checked) { video.pause(); autoPaused = true; }
  }
  if (!capInput.value) anchorOut = null;
});
capInput.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { capInput.blur(); if (autoPaused) { play(); autoPaused = false; } return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const text = capInput.value.trim();
  if (!text) return;
  if (!S.src) { toast('Open a video first.'); return; }
  if (!S.ranges.length) { toast('Keep at least one segment first — captions are timed on the edited video.'); return; }
  const lastEnd = S.captions.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
  const start = e.shiftKey ? lastEnd : (anchorOut ?? curOut());
  mutate(() => {
    const res = placeCaption(S.captions, text, start, Math.min(outDuration(), MAX_OUTPUT));
    S.captions = res.captions;
    S.selCap = res.placed.id;
  });
  capInput.value = ''; anchorOut = null;
  if (autoPaused) { play(); autoPaused = false; }
});
$('#capForm').addEventListener('submit', e => e.preventDefault());

function renderCapList() {
  const list = $('#capList');
  if (document.activeElement?.closest?.('#capList')) return; // don't clobber while editing
  list.innerHTML = '';
  capEls = [];
  if (!S.captions.length) {
    list.innerHTML = '<p class="muted pad">No captions yet. Type in the box under the video and press Enter, or paste a script below.</p>';
    return;
  }
  const limit = Math.min(outDuration(), MAX_OUTPUT);
  for (const c of S.captions) {
    const row = document.createElement('div');
    row.className = 'cap' + (c.id === S.selCap ? ' sel' : '') + (c.start >= limit ? ' overflow' : '');
    row.dataset.id = c.id;
    row.innerHTML = `<button class="when" title="Jump here"><b>${fmtTime(c.start, true)}</b>${c.dur.toFixed(1)}s</button><textarea rows="1" spellcheck="true"></textarea><button class="del" title="Delete caption">×</button>`;
    const ta = row.querySelector('textarea');
    ta.value = c.text;
    const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; };
    requestAnimationFrame(fit);
    let before = null;
    ta.addEventListener('focus', () => { before = snapshot(); S.selCap = c.id; });
    ta.addEventListener('input', () => {
      c.text = ta.value.replace(/\n/g, ' ');
      if (!c.manual) c.dur = readTime(c.text);
      contrast.delete(c.id); fit(); dirty = true; drawTimelines();
    });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
    ta.addEventListener('blur', () => {
      if (!c.text.trim()) S.captions = S.captions.filter(x => x !== c);
      if (before && before !== snapshot()) { undoStack.push(before); redoStack.length = 0; }
      setTimeout(changed, 0);
    });
    row.querySelector('.when').addEventListener('click', () => { S.selCap = c.id; seek(R.outToSrc(S.ranges, c.start + 0.01)); renderCapList(); });
    row.querySelector('.del').addEventListener('click', () => mutate(() => { S.captions = S.captions.filter(x => x.id !== c.id); }));
    list.appendChild(row);
    capEls.push(row);
  }
}
function scrollCapIntoView(id) { list().querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' }); }
const list = () => $('#capList');

$('#scriptLayout').addEventListener('click', () => {
  const lines = $('#scriptText').value.split('\n');
  const dur = Math.min(outDuration(), MAX_OUTPUT);
  if (!dur) { toast('Keep at least one segment first.'); return; }
  const res = layoutScript(lines, dur);
  if (!res.captions.length) { toast('The script is empty.'); return; }
  if (S.captions.length && !confirm(`Replace the ${S.captions.length} existing caption(s)?`)) return;
  mutate(() => { S.captions = res.captions; });
  $('#scriptNote').textContent = res.compressed < 1
    ? `Heads up: the script reads longer than the video, so captions are on screen ${Math.round(res.compressed * 100)}% of natural reading time. Trim the text or keep more video.`
    : `${res.captions.length} captions spread across ${fmtTime(dur)}.`;
});
$('#scriptAppend').addEventListener('click', () => {
  const lines = $('#scriptText').value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return;
  mutate(() => {
    let t = S.captions.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
    for (const text of lines) { const d = readTime(text); S.captions.push({ id: newId(), text, start: t, dur: d }); t += d; }
  });
  const end = S.captions.reduce((m, c) => Math.max(m, c.start + c.dur), 0);
  $('#scriptNote').textContent = end > outDuration() ? `Captions run to ${fmtTime(end)}, past the end of the edit (${fmtTime(outDuration())}).` : '';
});
$('#capClear').addEventListener('click', () => { if (S.captions.length && confirm('Delete all captions?')) mutate(() => { S.captions = []; }); });

// ------------------------------------------------------------------ style panel
const fontSel = $('#fontSelect');
for (const f of FONTS) { const o = document.createElement('option'); o.value = f.id; o.textContent = f.label; o.style.fontFamily = f.css; fontSel.appendChild(o); }
const styleForm = $('#styleForm');
function syncStyleForm() {
  for (const el of styleForm.querySelectorAll('[data-k]')) {
    const v = S.style[el.dataset.k];
    if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
  }
  for (const o of styleForm.querySelectorAll('output[data-o]')) {
    const k = o.dataset.o, v = S.style[k];
    o.textContent = k === 'raisedAngle' ? `${v}°` : k === 'size' ? `${(+v).toFixed(2).replace(/0$/, '')}%` : `${v}%`;
  }
  for (const b of document.querySelectorAll('#swatches button')) {
    const c = b.dataset.color;
    b.classList.toggle('on', c === 'auto' ? S.style.autoContrast : (!S.style.autoContrast && c.toLowerCase() === S.style.color.toLowerCase()));
  }
  const isPreset = [...document.querySelectorAll('#swatches button')].some(b => b.dataset.color.toLowerCase() === S.style.color.toLowerCase());
  document.querySelector('#swatches .custom').classList.toggle('on', !S.style.autoContrast && !isPreset);
  document.querySelector('#swatches .custom').style.background = (!S.style.autoContrast && !isPreset) ? S.style.color : '';
  for (const el of styleForm.querySelectorAll('[data-when]')) {
    const w = el.dataset.when, neg = w.startsWith('!'), key = w.replace('!', '');
    const val = key === 'box' ? S.style.box !== 'none' : !!S.style[key];
    el.classList.toggle('off', neg ? val : !val);
  }
}
styleForm.addEventListener('input', (e) => {
  const el = e.target; const k = el.dataset.k; if (!k) return;
  let v = el.type === 'checkbox' ? el.checked : el.value;
  if (typeof DEFAULT_STYLE[k] === 'number') v = +v;
  S.style[k] = v;
  if (k === 'color') S.style.autoContrast = false; // picking a colour means "use this colour"
  contrast.clear();
  saveStyle(S.style); syncStyleForm(); dirty = true;
});
$('#presets').addEventListener('click', (e) => {
  const p = e.target.dataset.preset; if (!p) return;
  S.style = { ...PRESETS[p] }; contrast.clear(); saveStyle(S.style); syncStyleForm(); dirty = true;
});
$('#swatches').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const c = b.dataset.color;
  if (c === 'auto') S.style.autoContrast = true;
  else { S.style.autoContrast = false; S.style.color = c; }
  contrast.clear(); saveStyle(S.style); syncStyleForm(); dirty = true;
});
$('#styleReset').addEventListener('click', () => { S.style = { ...DEFAULT_STYLE }; saveStyle(S.style); syncStyleForm(); dirty = true; });
syncStyleForm();

// ------------------------------------------------------------------ tabs, buttons
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== 'tab-' + b.dataset.tab; });
  dirty = true;
}));
$('#playBtn').addEventListener('click', togglePlay);
$('#modeEdit').addEventListener('click', () => setMode('edit'));
$('#modeSource').addEventListener('click', () => setMode('source'));
$('#zoomIn').addEventListener('click', () => zoom(0.5));
$('#zoomOut').addEventListener('click', () => zoom(2));
$('#zoomFit').addEventListener('click', () => S.src && setView(0, S.src.duration));
$('#sens').addEventListener('input', (e) => { S.sensitivity = +e.target.value; recomputeMarks(); });
$('#keepAll').addEventListener('click', () => S.src && mutate(() => { S.ranges = [{ s: 0, e: S.src.duration }]; }));
$('#keepNone').addEventListener('click', () => S.src && mutate(() => { S.ranges = []; }));
$('#preview').addEventListener('click', togglePlay);

$('#fileInput').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) open(f); e.target.value = ''; });
$('#urlForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const u = $('#urlInput').value.trim();
  if (!u) return;
  try { new URL(u); } catch { toast('That doesn\'t look like a URL.', 'err'); return; }
  open(u);
});
let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|ts)$/i.test(f.name));
  if (f) open(f);
  else {
    const url = e.dataTransfer?.getData('text/uri-list') || e.dataTransfer?.getData('text/plain');
    if (url && /^https?:/.test(url)) { $('#urlInput').value = url; open(url); }
  }
});

// ------------------------------------------------------------------ keyboard
window.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  const typing = (tag === 'INPUT' && !['range', 'checkbox', 'color', 'file'].includes(e.target.type)) || tag === 'TEXTAREA' || tag === 'SELECT';
  if (typing || $('#exportDlg').open) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); doExport(); return; }
  if (mod) return;
  if (!S.src) return;
  const t = video.currentTime, fstep = 1 / (S.src.fps || 30);
  const k = e.key;
  const handled = () => e.preventDefault();
  switch (k) {
    case ' ': handled(); togglePlay(); break;
    case 'ArrowRight': handled(); video.pause(); seek(t + (e.altKey ? 10 : e.shiftKey ? 1 : fstep)); break;
    case 'ArrowLeft': handled(); video.pause(); seek(t - (e.altKey ? 10 : e.shiftKey ? 1 : fstep)); break;
    case ']': handled(); jumpMarker(1); break;
    case '[': handled(); jumpMarker(-1); break;
    case 'Home': handled(); seek(0); break;
    case 'End': handled(); seek(S.src.duration); break;
    case 'Enter': case 's': case 'S': handled(); toggleSegment(t); break;
    case 'x': case 'X': handled(); dropSegment(t); break;
    case 'm': case 'M': handled(); addMarker(t); break;
    case 'Backspace': case 'Delete':
      handled();
      if (S.selCap) { const id = S.selCap; mutate(() => { S.captions = S.captions.filter(c => c.id !== id); S.selCap = null; }); }
      else removeNearestMarker(t);
      break;
    case 'i': case 'I': handled(); S.inPoint = t; toast('In-point set. Move to the end and press O.', '', 2500); drawTimelines(); break;
    case 'o': case 'O':
      handled();
      if (S.inPoint === null) { toast('Press I at the start first.'); break; }
      { const a = S.inPoint; S.inPoint = null; mutate(() => { S.ranges = R.addRange(S.ranges, a, t); }); }
      break;
    case 'Tab': handled(); setMode(S.mode === 'edit' ? 'source' : 'edit'); break;
    case '/': case 't': case 'T': handled(); capInput.focus(); break;
    case 'Escape': S.selCap = null; S.inPoint = null; renderCapList(); drawTimelines(); break;
    case '=': case '+': zoom(0.5); break;
    case '-': case '_': zoom(2); break;
    default: return;
  }
});

// ------------------------------------------------------------------ export
const dlg = $('#exportDlg');
let exportAbort = null;
$('#exportBtn').addEventListener('click', doExport);
async function doExport() {
  if (!S.src || exportAbort) return;
  if (!S.ranges.length) { toast('Nothing kept yet. Select segments to include first.'); return; }
  if (!('VideoEncoder' in window)) { toast('This browser lacks WebCodecs video encoding. Use a current Chrome, Edge or Safari.', 'err', 8000); return; }
  video.pause();
  const ranges = R.capRanges(S.ranges, MAX_OUTPUT);
  const over = outDuration() > MAX_OUTPUT;
  $('#expTitle').textContent = 'Exporting…';
  $('#expBar').style.width = '0%';
  $('#expInfo').textContent = over ? 'Kept material is longer than 2:00 — exporting the first 2:00.' : '';
  $('#expVideo').hidden = true; $('#expDownload').hidden = true;
  $('#expCancel').textContent = 'Cancel';
  dlg.showModal();
  exportAbort = new AbortController();
  try {
    const res = await exportMp4({
      src: S.src, ranges, captions: S.captions, style: S.style,
      maxHeight: +$('#resSelect').value,
      signal: exportAbort.signal,
      onProgress: ({ p, frame, total, speed, finalizing }) => {
        $('#expBar').style.width = (p * 100).toFixed(1) + '%';
        $('#expInfo').textContent = finalizing ? 'Finalizing MP4…'
          : `Frame ${frame} / ${total} · ${speed ? speed.toFixed(1) + '× realtime' : ''}${over ? ' · trimmed to 2:00' : ''}`;
      },
    });
    const url = URL.createObjectURL(res.blob);
    const base = (S.src.name || 'video').replace(/\.[^.]+$/, '');
    $('#expTitle').textContent = 'Done';
    $('#expInfo').textContent = `${fmtTime(res.seconds, true)} · ${res.width}×${res.height} · ${res.fps} fps · ${res.codec.toUpperCase()}${res.audioCodec ? ' + ' + res.audioCodec.toUpperCase() : ' (no audio)'} · ${fmtBytes(res.blob.size)}`;
    const v = $('#expVideo'); v.src = url; v.hidden = false;
    const a = $('#expDownload'); a.href = url; a.download = `${base}-cut.mp4`; a.hidden = false;
    $('#expCancel').textContent = 'Close';
  } catch (err) {
    if (err.name === 'AbortError') { dlg.close(); toast('Export cancelled.'); }
    else { console.error(err); $('#expTitle').textContent = 'Export failed'; $('#expInfo').textContent = err.message || String(err); $('#expCancel').textContent = 'Close'; }
  } finally {
    exportAbort = null;
  }
}
$('#expCancel').addEventListener('click', () => {
  if (exportAbort) exportAbort.abort();
  else { dlg.close(); const v = $('#expVideo'); v.pause(); }
});
dlg.addEventListener('cancel', (e) => { if (exportAbort) { e.preventDefault(); exportAbort.abort(); } });

// ------------------------------------------------------------------ boot
sizeTimelines();
updateMeter();
setMode('edit');
if (!('VideoDecoder' in window)) toast('This browser has no WebCodecs support. Use a current Chrome, Edge, or Safari 17+.', 'err', 12000);
