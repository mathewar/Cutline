// Opens a local file or a remote URL (MP4 / MOV / WebM / MKV / HLS .m3u8) for both
// preview (a <video> element that streams lazily) and frame-accurate access (mediabunny).
import {
  Input, ALL_FORMATS, BlobSource, UrlSource, EncodedPacketSink, HLS,
} from '../vendor/mediabunny.min.mjs';

export async function openSource(arg, videoEl) {
  const isFile = arg instanceof File;
  const name = isFile ? arg.name : arg;
  const source = isFile
    ? new BlobSource(arg)
    : new UrlSource(arg, { maxCacheSize: 128 * 1024 * 1024, parallelism: 4 });

  const input = new Input({
    source,
    formats: ALL_FORMATS,
    formatOptions: { hls: { offsetTimestampsByDateTime: false } },
  });

  let format, videoTrack, audioTrack;
  try {
    format = await input.getFormat();
    videoTrack = await input.getPrimaryVideoTrack();
  } catch (err) {
    input.dispose();
    const e = new Error(isFile
      ? `This file couldn't be read (${err.message}). Supported: MP4, MOV, WebM, MKV, MPEG-TS.`
      : `Couldn't read that link from the browser. The host must allow cross-origin (CORS) access, and the link must point at a video file or .m3u8 playlist, not a web page (YouTube/Vimeo page links won't work). Detail: ${err.message}`);
    e.cause = err;
    throw e;
  }
  if (!videoTrack) { input.dispose(); throw new Error('No video track found.'); }
  if (await videoTrack.isLive?.()) {
    input.dispose();
    throw new Error('Live streams aren\'t supported yet. Use a finished (VOD) stream or a file.');
  }
  if (!(await videoTrack.canDecode())) {
    input.dispose();
    throw new Error(`This browser can't decode the video codec (${await videoTrack.getCodec()}). Try Chrome or Edge, or a H.264 file.`);
  }
  audioTrack = await input.getPrimaryAudioTrack().catch(() => null);
  if (audioTrack && !(await audioTrack.canDecode().catch(() => false))) audioTrack = null;

  const width = await videoTrack.getDisplayWidth();
  const height = await videoTrack.getDisplayHeight();
  const firstTs = await videoTrack.getFirstTimestamp().catch(() => 0);
  // Streams (e.g. MPEG-TS) often start at a large PTS; the <video> element starts near 0.
  const tOffset = firstTs > 0.5 ? firstTs : 0;

  let duration = await input.getDurationFromMetadata([videoTrack]).catch(() => null);
  if (!duration || !isFinite(duration)) duration = await input.computeDuration([videoTrack]);
  duration = Math.max(0.1, duration - tOffset);

  let fps = 30;
  try {
    const stats = await videoTrack.computePacketStats(120);
    if (isFinite(stats.averagePacketRate) && stats.averagePacketRate > 1) fps = stats.averagePacketRate;
  } catch { /* keep default */ }

  const isHls = format === HLS;
  const previewUrl = isFile ? URL.createObjectURL(arg) : arg;
  await attachPreview(videoEl, previewUrl, { isHls, crossOrigin: !isFile });

  return {
    kind: isFile ? 'file' : 'url',
    id: isFile ? `${arg.name}|${arg.size}|${arg.lastModified}` : arg,
    name: isFile ? arg.name : name.split('/').pop().split('?')[0] || 'stream',
    size: isFile ? arg.size : null,
    input, videoTrack, audioTrack,
    packetSink: new EncodedPacketSink(videoTrack),
    width, height, fps, duration, tOffset, isHls,
    previewUrl,
    dispose() {
      try { input.dispose(); } catch {}
      if (isFile) URL.revokeObjectURL(previewUrl);
      detachPreview(videoEl);
    },
  };
}

let hlsInstance = null;

async function attachPreview(video, url, { isHls, crossOrigin }) {
  detachPreview(video);
  if (crossOrigin) video.crossOrigin = 'anonymous'; else video.removeAttribute('crossorigin');
  video.preload = 'auto';
  if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
    const { default: Hls } = await import('../vendor/hls.min.mjs');
    if (!Hls.isSupported()) throw new Error('HLS playback is not supported in this browser.');
    hlsInstance = new Hls({ maxBufferLength: 30 });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
  } else {
    video.src = url;
  }
  await new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('The browser could not play this video for preview.')); };
    const cleanup = () => { video.removeEventListener('loadeddata', ok); video.removeEventListener('error', bad); };
    video.addEventListener('loadeddata', ok);
    video.addEventListener('error', bad);
  });
}

function detachPreview(video) {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.removeAttribute('src');
  video.load();
}
