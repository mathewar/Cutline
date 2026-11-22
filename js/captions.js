// Caption model (timed on the OUTPUT timeline), automatic timing, and canvas rendering.
// The same draw function is used for live preview and for the exported MP4, so what you
// see is what you get.
import { fontCss } from './style.js';

let nextId = 1;
export const newId = () => `c${Date.now().toString(36)}${(nextId++).toString(36)}`;

/** Natural on-screen time for a caption, from its length (reading speed ~15 chars/s). */
export function readTime(text) {
  const t = text.replace(/\|/g, ' ').trim();
  const words = t ? t.split(/\s+/).length : 0;
  const secs = Math.max(0.6 + t.length / 15, 0.4 + words * 0.32);
  return clamp(secs, 1.2, 7);
}

/**
 * Insert a caption starting at output time `start`. Duration is automatic.
 * An earlier caption still on screen is cut short; later captions ripple forward if needed.
 */
export function placeCaption(captions, text, start, outDuration) {
  const dur = readTime(text);
  const list = captions.map(c => ({ ...c })).sort((a, b) => a.start - b.start);
  start = clamp(start, 0, Math.max(0, outDuration - 0.5));
  for (const c of list) {
    if (c.start < start && c.start + c.dur > start) {
      if (start - c.start >= 0.6) c.dur = start - c.start;
      else start = c.start + 0.6;
    }
  }
  const cap = { id: newId(), text, start, dur };
  list.push(cap);
  list.sort((a, b) => a.start - b.start);
  // Ripple following captions so nothing overlaps.
  for (let i = 1; i < list.length; i++) {
    const p = list[i - 1], c = list[i];
    if (c.start < p.start + p.dur) {
      if (c === cap) { /* new one already placed after p */ }
      else c.start = p.start + p.dur;
    }
  }
  return { captions: list, placed: cap };
}

/**
 * Lay a whole script (one caption per line) across the output.
 * If the script reads faster than the video, captions are centred in equal slots with gaps;
 * if it's longer, all durations are compressed proportionally.
 */
export function layoutScript(lines, outDuration) {
  const texts = lines.map(l => l.trim()).filter(Boolean);
  if (!texts.length || outDuration <= 0) return { captions: [], compressed: 1 };
  const nat = texts.map(readTime);
  const total = nat.reduce((a, b) => a + b, 0);
  const caps = [];
  if (total <= outDuration) {
    const gap = (outDuration - total) / texts.length;
    let t = gap / 2;
    texts.forEach((text, i) => { caps.push({ id: newId(), text, start: t, dur: nat[i] }); t += nat[i] + gap; });
    return { captions: caps, compressed: 1 };
  }
  const k = outDuration / total;
  let t = 0;
  texts.forEach((text, i) => { const d = nat[i] * k; caps.push({ id: newId(), text, start: t, dur: d }); t += d; });
  return { captions: caps, compressed: k };
}

export function activeCaptions(captions, t) {
  return captions.filter(c => t >= c.start && t < c.start + c.dur);
}

// ---------------------------------------------------------------- rendering

const lumCanvas = new OffscreenCanvas(16, 4);
const lumCtx = lumCanvas.getContext('2d', { willReadFrequently: true });

function regionLuminance(srcCanvas, x, y, w, h) {
  try {
    lumCtx.drawImage(srcCanvas, Math.max(0, x), Math.max(0, y), Math.max(1, w), Math.max(1, h), 0, 0, 16, 4);
    const d = lumCtx.getImageData(0, 0, 16, 4).data;
    let s = 0;
    for (let i = 0; i < d.length; i += 4) s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    return s / (d.length / 4) / 255;
  } catch { return 0.3; } // tainted canvas etc. — assume darkish
}

function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of text.split('|')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) { out.push(line); line = w; }
      else line = test;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * Draw every caption active at output time t onto ctx (which already holds the frame).
 * `contrast` is a Map persisted across frames so auto-contrast has hysteresis (no flicker).
 */
export function drawCaptions(ctx, W, H, captions, style, t, contrast) {
  const active = activeCaptions(captions, t);
  if (!active.length) return;
  const fontPx = Math.max(8, H * style.size / 100);
  const font = `${style.weight} ${fontPx}px ${fontCss(style)}`;
  const lineH = fontPx * style.lineHeight;
  const maxW = W * style.maxWidth / 100;
  const margin = H * style.margin / 100;

  // Layout + sample the background for each caption before drawing any text.
  const jobs = active.map(c => {
    ctx.font = font;
    const text = style.uppercase ? c.text.toUpperCase() : c.text;
    const lines = wrap(ctx, text, maxW);
    const widths = lines.map(l => ctx.measureText(l).width);
    const blockH = lines.length * lineH;
    let top;
    if (style.position === 'top') top = margin;
    else if (style.position === 'middle') top = (H - blockH) / 2;
    else top = H - margin - blockH;
    const bw = Math.max(...widths);
    const cx = style.align === 'left' ? (W - maxW) / 2 : W / 2;
    const bx = style.align === 'left' ? cx : cx - bw / 2;
    let dark = false;
    if (style.autoContrast) {
      const lum = regionLuminance(ctx.canvas, bx, top, bw, blockH);
      const prev = contrast?.get(c.id);
      dark = prev === undefined ? lum > 0.56 : (prev ? lum > 0.46 : lum > 0.64);
      contrast?.set(c.id, dark);
    }
    const fadeIn = style.fade ? (t - c.start) / 0.18 : 1;
    const fadeOut = style.fade ? (c.start + c.dur - t) / 0.18 : 1;
    return { lines, widths, top, cx, bx, bw, blockH, dark, alpha: clamp(Math.min(fadeIn, fadeOut), 0, 1) };
  });

  for (const j of jobs) drawBlock(ctx, W, j, style, fontPx, font, lineH);
}

function drawBlock(ctx, W, j, style, fontPx, font, lineH) {
  const auto = style.autoContrast;
  const fill = auto ? (j.dark ? '#111111' : '#ffffff') : style.color;
  const manualEdge = style.edgeAuto ? (luma(style.color) > 0.55 ? '#000000' : '#ffffff') : style.strokeColor;
  const edge = auto ? (j.dark ? '#ffffff' : '#000000') : manualEdge;
  const boxRGB = auto ? (j.dark ? '255,255,255' : '0,0,0') : hexToRgb(manualEdge);
  const op = style.boxOpacity / 100;

  ctx.save();
  ctx.globalAlpha = j.alpha;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = style.align === 'left' ? 'left' : 'center';
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;

  // Backgrounds
  const padX = fontPx * 0.4, padY = fontPx * 0.12;
  if (style.box === 'band') {
    ctx.fillStyle = `rgba(${boxRGB},${op})`;
    ctx.fillRect(0, j.top - padY * 2, W, j.blockH + padY * 4);
  } else if (style.box === 'box') {
    ctx.fillStyle = `rgba(${boxRGB},${op})`;
    j.lines.forEach((l, i) => {
      const w = j.widths[i];
      const x = style.align === 'left' ? j.cx - padX : j.cx - w / 2 - padX;
      const y = j.top + i * lineH - padY;
      roundRect(ctx, x, y, w + padX * 2, lineH + padY * 2, fontPx * 0.18);
    });
  }

  const sw = fontPx * style.stroke / 100;
  const shadow = () => {
    if (style.shadow === 'none') return;
    ctx.shadowColor = j.dark && auto ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.65)';
    ctx.shadowBlur = style.shadow === 'soft' ? fontPx * 0.22 : 0;
    ctx.shadowOffsetX = ctx.shadowOffsetY = fontPx * (style.shadow === 'soft' ? 0.04 : 0.07);
  };
  const noShadow = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = ctx.shadowOffsetY = 0; };

  j.lines.forEach((l, i) => {
    const y = j.top + i * lineH + lineH / 2;
    const x = j.cx;
    // Raised lettering: stack of offset copies forming an extrusion beneath the face.
    if (style.raised) {
      const depth = fontPx * style.raisedDepth / 100;
      const steps = Math.min(40, Math.max(2, Math.round(depth)));
      const a = style.raisedAngle * Math.PI / 180;
      const dx = Math.cos(a) * depth / steps, dy = Math.sin(a) * depth / steps;
      ctx.fillStyle = auto ? (j.dark ? '#9aa0aa' : '#000000') : shade(edge, 1);
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = sw;
      for (let s = steps; s >= 1; s--) {
        if (s === steps) shadow(); else noShadow();
        if (sw > 0) ctx.strokeText(l, x + dx * s, y + dy * s);
        ctx.fillText(l, x + dx * s, y + dy * s);
      }
      noShadow();
    }
    if (sw > 0) {
      if (!style.raised) shadow();
      ctx.strokeStyle = edge;
      ctx.lineWidth = sw;
      ctx.strokeText(l, x, y);
      noShadow();
    } else if (!style.raised && style.box === 'none') {
      shadow();
    }
    ctx.fillStyle = fill;
    ctx.fillText(l, x, y);
    noShadow();
  });
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h);
  ctx.fill();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
}

function luma(hex) {
  const [r, g, b] = hexToRgb(hex).split(',').map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function shade(hex, k) {
  const [r, g, b] = hexToRgb(hex).split(',').map(Number);
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

export function clamp(x, a, b) { return Math.min(b, Math.max(a, x)); }

export function fmtTime(s, withFrac = false) {
  if (!isFinite(s)) return '--:--';
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const ss = withFrac ? sec.toFixed(1).padStart(4, '0') : String(Math.floor(sec)).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
