/* Readable shelf/bin text for 40 x 25 mm location labels only.
 * Layout never changes the stored locationCode or its barcode payload.
 */
const WIDTH_MM = 36.8;
export const locationQrPayload = value => String(value ?? '').trim(); // 37.7 mm content width, leaving room for rounding/bearings.
const FONT = '900 100px Arial, Helvetica, sans-serif';
const escape = value => String(value ?? '').replace(/[&<>"']/g, ch =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
let context;

function measure(text) {
  if (!context && typeof document !== 'undefined') {
    try { context = document.createElement('canvas').getContext('2d'); } catch {}
  }
  if (context) {
    context.font = FONT;
    const metrics = context.measureText(text);
    return Math.max(metrics.width,
      (metrics.actualBoundingBoxLeft || 0) + (metrics.actualBoundingBoxRight || 0));
  }
  // Conservative fallback for non-browser use; still never truncates the code.
  return Array.from(text).length * 105;
}

function fit(text, maximum, widthMm=WIDTH_MM) {
  const width = measure(text);
  const size = width > 0 ? Math.min(maximum, widthMm * 100 / width) : maximum;
  return Math.floor(size * 1000) / 1000;
}

export function locationTextLayout(value, widthMm=WIDTH_MM) {
  const code = locationQrPayload(value);
  if (!code) return {code, lines:[], sizes:[], small:false};
  // Prefer a meaningful break: BLUE 2 / BIN 14 (also BIN14 or BIN-14).
  const bin = code.match(/^(\S(?:.*?\S)?)\s+(BIN(?=\s|\d|[-:#]).+)$/i);
  let lines = bin ? [bin[1], bin[2]] : [code];
  // Long non-bin locations get a balanced two-line layout at a word boundary.
  if (!bin && fit(code, 5, widthMm) < 4.2 && /\s/.test(code)) {
    const words = code.split(/\s+/);
    let best = Infinity;
    for (let n = 1; n < words.length; n++) {
      // Keep shelf numbers with their names where possible.
      if (/^\d/.test(words[n])) continue;
      const candidate = [words.slice(0,n).join(' '), words.slice(n).join(' ')];
      const score = Math.max(...candidate.map(measure));
      if (score < best) { best = score; lines = candidate; }
    }
  }
  const sizes = lines.map(line => fit(line, lines.length > 1 ? 4.5 : 5, widthMm));
  return {code, lines, sizes, small:sizes.some(size => size < 2.3)};
}

export function locationTextWarning(value) {
  return locationTextLayout(value).small
    ? 'Long location code: the full name is included, but text is small on 40 × 25 mm. Check the preview and print one test label.'
    : '';
}

export function renderLocationText(value, typeText, widthMm=WIDTH_MM) {
  const layout = locationTextLayout(value,widthMm);
  const heading = String(typeText ?? 'STORE LOCATION');
  const typeSize = fit(heading, 1.8, widthMm);
  const lines = layout.lines.map((line,index) =>
    `<span class="location-code-line" style="font-size:${layout.sizes[index]}mm">${escape(line)}</span>`
  ).join(' ');
  return `<div class="location-type location-type-readable" style="font-size:${typeSize}mm">${escape(heading)}</div>` +
    `<div class="location-code location-code-readable" title="${escape(layout.code)}" aria-label="${escape(layout.code)}">${lines}</div>`;
}
