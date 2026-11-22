// Scene-shift detection + filmstrip thumbnails.
// Works on arbitrarily long files: it samples key frames (cheap to decode — no GOP walk)
// and only falls back to uniform non-key sampling when key frames are sparse.
import { CanvasSink } from '../vendor/mediabunny.min.mjs';

const MAX_SAMPLES = 700;
const THUMB_W = 160;

export async function analyze(src, { onProgress, onSample, signal }) {
  const { duration, tOffset, packetSink, videoTrack } = src;
  const step = Math.max(0.5, duration / MAX_SAMPLES);

  // 1) Collect key-frame timestamps near a uniform grid (metadata only = no media bytes read).
  const keyTs = new Set();
  for (let t = 0; t < duration; t += step) {
    if (signal?.aborted) return null;
    try {
      const p = await packetSink.getKeyPacket(t + tOffset, { metadataOnly: true });
      if (p) keyTs.add(round3(p.timestamp));
    } catch { /* ignore */ }
    if (keyTs.size % 25 === 0) onProgress?.({ phase: 'index', p: t / duration });
  }
  let times = [...keyTs].sort((a, b) => a - b);

  // 2) Sparse key frames (e.g. screen recordings, 10s+ GOPs)? Add uniform samples.
  const wanted = Math.min(MAX_SAMPLES, Math.ceil(duration / step));
  if (times.length < wanted * 0.5) {
    const uStep = Math.max(1, duration / 350);
    const extra = [];
    for (let t = 0; t < duration; t += uStep) extra.push(round3(t + tOffset));
    times = [...new Set([...times, ...extra])].sort((a, b) => a - b);
  }
  if (!times.length) times = [tOffset];

  // 3) Decode the samples at thumbnail size, compute features.
  const sink = new CanvasSink(videoTrack, { width: THUMB_W, poolSize: 3 });
  const feat = new OffscreenCanvas(32, 18);
  const fctx = feat.getContext('2d', { willReadFrequently: true });
  const samples = [];
  let i = 0;
  for await (const wc of sink.canvasesAtTimestamps(times)) {
    if (signal?.aborted) return null;
    const reqT = times[i++];
    if (!wc) continue;
    const bmp = await createImageBitmap(wc.canvas);
    fctx.drawImage(wc.canvas, 0, 0, 32, 18);
    const px = fctx.getImageData(0, 0, 32, 18).data;
    const s = {
      t: Math.max(0, Math.min(duration, reqT - tOffset)),
      bmp,
      f: features(px),
      score: 0,
    };
    const prev = samples[samples.length - 1];
    if (prev) s.score = distance(prev.f, s.f);
    samples.push(s);
    onSample?.(s, samples);
    if (i % 10 === 0) onProgress?.({ phase: 'scan', p: i / times.length });
  }
  onProgress?.({ phase: 'done', p: 1 });
  return samples;
}

function round3(x) { return Math.round(x * 1000) / 1000; }

// Feature vector: 3x16-bin colour histogram + 8x6 luma grid.
function features(px) {
  const hist = new Float32Array(48);
  const grid = new Float32Array(48);
  const gridN = new Float32Array(48);
  const n = px.length / 4;
  for (let k = 0, p = 0; p < px.length; p += 4, k++) {
    const r = px[p], g = px[p + 1], b = px[p + 2];
    hist[r >> 4]++; hist[16 + (g >> 4)]++; hist[32 + (b >> 4)]++;
    const x = k % 32, y = (k / 32) | 0;
    const gi = ((y / 3) | 0) * 8 + ((x / 4) | 0);
    grid[gi] += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    gridN[gi]++;
  }
  for (let j = 0; j < 48; j++) { hist[j] /= n; grid[j] = grid[j] / (gridN[j] || 1) / 255; }
  return { hist, grid };
}

function distance(a, b) {
  let h = 0, g = 0;
  for (let j = 0; j < 48; j++) h += Math.abs(a.hist[j] - b.hist[j]);
  for (let j = 0; j < 48; j++) g += Math.abs(a.grid[j] - b.grid[j]);
  return 0.55 * (h / 6) + 0.45 * (g / 48) * 2.2; // both terms roughly 0..1
}

/**
 * Pick "major shift" marks from sample scores.
 * sensitivity 0..1 (higher = more marks). Robust z-score over median/MAD + local-max + min spacing.
 */
export function detectShifts(samples, duration, sensitivity = 0.5) {
  if (!samples || samples.length < 3) return [];
  const sc = samples.map(s => s.score);
  const sorted = [...sc].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const mad = [...sc].map(x => Math.abs(x - med)).sort((a, b) => a - b)[sc.length >> 1] || 1e-3;
  const k = 9 - sensitivity * 7.5;          // z threshold: 9 (few) .. 1.5 (many)
  const floor = 0.16 - sensitivity * 0.12;  // absolute floor on score
  const minGap = Math.max(1, duration / 300);
  const cands = [];
  for (let i = 1; i < samples.length; i++) {
    const z = (sc[i] - med) / (1.4826 * mad + 1e-4);
    if (z < k || sc[i] < floor) continue;
    let isMax = true;
    for (let j = Math.max(1, i - 2); j <= Math.min(samples.length - 1, i + 2); j++) {
      if (j !== i && sc[j] > sc[i]) { isMax = false; break; }
    }
    if (isMax) cands.push({ t: samples[i].t, s: sc[i] });
  }
  // Enforce spacing, keeping the strongest.
  cands.sort((a, b) => b.s - a.s);
  const picked = [];
  for (const c of cands) if (picked.every(p => Math.abs(p - c.t) >= minGap)) picked.push(c.t);
  return picked.sort((a, b) => a - b);
}

/** Nearest sample thumbnail for a time (binary search). */
export function thumbAt(samples, t) {
  if (!samples?.length) return null;
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].t <= t) lo = mid; else hi = mid - 1;
  }
  const a = samples[lo], b = samples[lo + 1];
  return (b && Math.abs(b.t - t) < Math.abs(a.t - t)) ? b.bmp : a.bmp;
}
