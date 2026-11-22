// Caption style model, presets, and cookie persistence.

export const FONTS = [
  { id: 'system', label: 'System Sans', css: 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { id: 'helvetica', label: 'Helvetica / Arial', css: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'impact', label: 'Impact', css: 'Impact, "Haettenschweiler", "Arial Narrow Bold", sans-serif' },
  { id: 'arialblack', label: 'Arial Black', css: '"Arial Black", "Arial Bold", Gadget, sans-serif' },
  { id: 'georgia', label: 'Georgia (serif)', css: 'Georgia, "Times New Roman", serif' },
  { id: 'palatino', label: 'Palatino (serif)', css: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
  { id: 'mono', label: 'Monospace', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  { id: 'trebuchet', label: 'Trebuchet', css: '"Trebuchet MS", "Lucida Grande", sans-serif' },
  { id: 'comic', label: 'Comic / casual', css: '"Comic Sans MS", "Comic Neue", "Chalkboard SE", cursive' },
];

export const DEFAULT_STYLE = {
  font: 'system',
  size: 6,            // % of video height
  weight: 800,
  uppercase: false,
  color: '#ffffff',
  strokeColor: '#000000',
  edgeAuto: true,     // with a custom text colour, pick a contrasting outline/box colour
  autoContrast: true, // pick light/dark text from what's behind it
  stroke: 14,         // outline width, % of font size
  shadow: 'soft',     // none | soft | hard
  raised: false,      // offset 3-D extrusion
  raisedDepth: 6,     // % of font size
  raisedAngle: 45,    // direction the extrusion falls: 0 = right, 90 = down, 45 = down-right
  box: 'none',        // none | box | band
  boxOpacity: 55,     // %
  position: 'bottom', // bottom | middle | top
  margin: 8,          // % of height from the edge
  align: 'center',
  maxWidth: 84,       // % of width
  lineHeight: 1.15,
  fade: true,
};

export const PRESETS = {
  clean:   { ...DEFAULT_STYLE },
  outline: { ...DEFAULT_STYLE, font: 'arialblack', stroke: 22, shadow: 'none', uppercase: true },
  raised:  { ...DEFAULT_STYLE, font: 'impact', weight: 400, raised: true, raisedDepth: 8, stroke: 8, shadow: 'hard', uppercase: true, size: 7.5 },
  boxed:   { ...DEFAULT_STYLE, box: 'box', stroke: 0, shadow: 'none', weight: 600, size: 5 },
  band:    { ...DEFAULT_STYLE, box: 'band', stroke: 0, shadow: 'none', weight: 600, size: 5, boxOpacity: 62, margin: 6 },
};

const COOKIE = 'cutline_style';

export function loadStyle() {
  try {
    const m = document.cookie.split('; ').find(c => c.startsWith(COOKIE + '='));
    if (!m) return { ...DEFAULT_STYLE };
    const saved = JSON.parse(decodeURIComponent(m.slice(COOKIE.length + 1)));
    return { ...DEFAULT_STYLE, ...saved };
  } catch { return { ...DEFAULT_STYLE }; }
}

export function saveStyle(style) {
  // Only store what differs from defaults to keep the cookie small.
  const diff = {};
  for (const k of Object.keys(style)) if (style[k] !== DEFAULT_STYLE[k]) diff[k] = style[k];
  const v = encodeURIComponent(JSON.stringify(diff));
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE}=${v}; Max-Age=${60 * 60 * 24 * 365}; Path=/; SameSite=Lax${secure}`;
}

export function fontCss(style) {
  return (FONTS.find(f => f.id === style.font) || FONTS[0]).css;
}
