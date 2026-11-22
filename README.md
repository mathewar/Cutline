# Cutline

A video cutter and captioner that runs entirely in the browser. It takes a file or a stream link and exports an MP4 of up to 2:00 with burned-in captions. It has no server component, and the video is never uploaded.

## Deploy to Vercel

The site is plain static files. `npm run build` copies the app and the two pinned libraries (from npm) into `dist/`; there is no bundling and no server code. `vercel.json` already sets the install/build commands and output directory, so importing this repo in Vercel (or `npx vercel deploy --prod`) just works.

You can also push the folder to a Git repo and import it in Vercel. Any other static host (Netlify, Cloudflare Pages, S3) works as well. To run it locally, use `npx serve .` and open http://localhost:3000. ES modules need http://, so opening `index.html` as a `file://` page won't work.

## How it works

- `js/source.js` opens a `File` or URL with [mediabunny](https://mediabunny.dev) (WebCodecs). It reads byte ranges on demand, so file size doesn't matter. HLS `.m3u8` playlists are supported. Preview uses a `<video>` element, with hls.js for HLS in browsers that lack native support.
- `js/analyze.js` builds the filmstrip and detects scene shifts. It samples about 700 key frames, which are cheap to decode, and adds uniform samples when key frames are sparse. Shifts are found with a colour histogram plus a luma grid, scored by robust z-score and local peaks.
- `js/ranges.js` holds the kept-segment interval set and the source ⇄ output time mapping.
- `js/captions.js` handles auto timing (about 15 chars/s, clamped to 1.2–7 s) and draws captions on a canvas. The same function draws the preview and the export.
- `js/style.js` holds caption styles and presets, saved in the `cutline_style` cookie.
- `js/export.js` resamples the kept ranges to constant fps, burns in the captions, and encodes H.264 + AAC (or Opus) into MP4 with WebCodecs.

The project state for each video (kept ranges, markers, captions) autosaves to `localStorage`.

## Browser support

Chrome or Edge (best), Safari 17+, and Firefox 130+. Firefox can't encode AAC, so its exports use Opus audio in MP4.
Stream links only work if the host sends CORS headers.

Vendored: mediabunny 1.66 (MPL-2.0), hls.js (Apache-2.0). Licenses are in `vendor/`.

## Privacy

Nothing you open, cut or caption is sent to the server that hosts this app.

- **Requests to the app's own server:** only `GET` requests for its static files (HTML, CSS, JS). They have no request bodies and no query strings. There's no API, no serverless function, no analytics, and no third-party script or font.
- **Video:** local files are read with `File`/`Blob` APIs and never uploaded. A stream link is fetched by the browser straight from the host you pasted. It doesn't go through this server.
- **What stays on the device:**
  - `localStorage`: the autosaved edit for each video (kept segments, markers, captions).
  - The `cutline_style` cookie: caption style preferences only. Note that browsers attach cookies to every request to the site.
- **Enforced by headers** (`vercel.json`):
  - A strict Content-Security-Policy: scripts only from this origin, no inline or eval scripts, no form posts, no framing.
  - `Referrer-Policy: no-referrer`, so stream hosts don't learn the app's URL.
  - A Permissions-Policy that disables camera, microphone and location.
- **The host:** like any web host, the hosting platform itself (e.g. Vercel) sees standard request metadata (IP address, user agent, path) for those static file requests. The app can't change that.
