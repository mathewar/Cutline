// Renders the kept ranges (+ burned-in captions) to an MP4 entirely in the browser using
// WebCodecs via mediabunny. Only the needed parts of the source are read and decoded.
import {
  Output, Mp4OutputFormat, BufferTarget, CanvasSource, AudioBufferSource,
  CanvasSink, AudioBufferSink, QUALITY_MEDIUM,
  getFirstEncodableVideoCodec, getFirstEncodableAudioCodec,
} from '../vendor/mediabunny.min.mjs';
import { drawCaptions } from './captions.js';

export const MAX_OUTPUT = 120;

export async function exportMp4({ src, ranges, captions, style, maxHeight = 1080, onProgress, signal }) {
  const { videoTrack, audioTrack, tOffset } = src;

  // Output size: keep aspect, cap the short side at maxHeight, even dimensions.
  const scale = Math.min(1, maxHeight / Math.min(src.width, src.height), 3840 / Math.max(src.width, src.height));
  const W = even(src.width * scale), H = even(src.height * scale);
  const fps = clampFps(src.fps);

  const vCodec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: W, height: H });
  if (!vCodec) throw new Error('This browser cannot encode video (WebCodecs). Use a recent Chrome, Edge or Safari.');

  let aCodec = null, aInfo = null;
  if (audioTrack) {
    const ch = Math.min(2, await audioTrack.getNumberOfChannels());
    const sr = await audioTrack.getSampleRate();
    aInfo = { ch, sr };
    aCodec = await getFirstEncodableAudioCodec(['aac', 'opus'], { numberOfChannels: ch, sampleRate: sr });
  }

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  const vSource = new CanvasSource(canvas, { codec: vCodec, quality: QUALITY_MEDIUM, keyFrameInterval: 2 });
  output.addVideoTrack(vSource, { frameRate: fps });
  let aSource = null;
  if (aCodec) {
    aSource = new AudioBufferSource({ codec: aCodec, quality: QUALITY_MEDIUM });
    output.addAudioTrack(aSource);
  }
  await output.start();

  const vSink = new CanvasSink(videoTrack, { width: W, height: H, fit: 'contain', poolSize: 3 });
  const aSink = aSource ? new AudioBufferSink(audioTrack) : null;
  const contrast = new Map();

  const frameCounts = ranges.map(r => Math.max(1, Math.round((r.e - r.s) * fps)));
  const totalFrames = frameCounts.reduce((a, b) => a + b, 0);
  let frameIdx = 0;
  const t0 = performance.now();

  try {
    for (let ri = 0; ri < ranges.length; ri++) {
      const r = ranges[ri];
      const n = frameCounts[ri];
      const startFrame = frameIdx;

      // --- video: resample to constant frame rate
      const stamps = (function* () { for (let k = 0; k < n; k++) yield r.s + tOffset + k / fps; })();
      for await (const wc of vSink.canvasesAtTimestamps(stamps)) {
        if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
        const tOut = frameIdx / fps;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, W, H);
        if (wc) ctx.drawImage(wc.canvas, 0, 0, W, H);
        drawCaptions(ctx, W, H, captions, style, tOut, contrast);
        await vSource.add(tOut, 1 / fps);
        frameIdx++;
        if (frameIdx % 5 === 0) {
          const el = (performance.now() - t0) / 1000;
          onProgress?.({ p: frameIdx / totalFrames, frame: frameIdx, total: totalFrames, speed: (frameIdx / fps) / el });
        }
      }

      // --- audio: exact sample count matching this range's frames (keeps A/V locked)
      if (aSource) {
        const segDur = n / fps;
        const want = Math.round(segDur * aInfo.sr);
        let got = 0;
        const from = r.s + tOffset, to = from + segDur;
        for await (const wb of aSink.buffers(from, to)) {
          if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
          const b = wb.buffer;
          const sr = b.sampleRate;
          let startF = Math.max(0, Math.round((from - wb.timestamp) * sr));
          let endF = Math.min(b.length, Math.round((to - wb.timestamp) * sr));
          endF = Math.min(endF, startF + (want - got));
          if (endF <= startF) continue;
          await aSource.add(slice(b, startF, endF, aInfo.ch));
          got += endF - startF;
        }
        if (got < want) await aSource.add(silence(want - got, aInfo.sr, aInfo.ch));
      }
      void startFrame;
    }
    onProgress?.({ p: 1, frame: totalFrames, total: totalFrames, finalizing: true });
    await output.finalize();
  } catch (err) {
    await output.cancel().catch(() => {});
    throw err;
  }
  return {
    blob: new Blob([output.target.buffer], { type: 'video/mp4' }),
    width: W, height: H, fps, codec: vCodec, audioCodec: aCodec,
    seconds: totalFrames / fps,
  };
}

function slice(buf, a, b, ch) {
  const out = new AudioBuffer({ length: b - a, numberOfChannels: ch, sampleRate: buf.sampleRate });
  for (let c = 0; c < ch; c++) {
    const srcCh = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1));
    out.copyToChannel(srcCh.subarray(a, b), c);
  }
  return out;
}

function silence(len, sr, ch) {
  return new AudioBuffer({ length: Math.max(1, len), numberOfChannels: ch, sampleRate: sr });
}

function even(x) { return Math.max(2, Math.round(x / 2) * 2); }
function clampFps(f) {
  if (!isFinite(f) || f < 10) return 30;
  // Snap to common rates.
  const common = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
  let best = common[0];
  for (const c of common) if (Math.abs(c - f) < Math.abs(best - f)) best = c;
  return Math.abs(best - f) < 1.5 ? best : Math.min(60, Math.round(f));
}
