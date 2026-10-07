/**
 * QR rendering for the lock screen.
 *
 * Wraps a vendored copy of qrcode-generator (MIT, no runtime deps) rather
 * than a CDN script tag: the product claims to work with no network, and the
 * lock screen is exactly where that has to be true.
 *
 * A from-scratch encoder was written first and thrown away — it produced a
 * matrix that looked plausible but failed to decode in OpenCV. qr.test.js
 * now decodes the real output on every run, so that failure cannot come
 * back silently.
 */
import qrcode from './vendor-qrcode.mjs';

/** The module matrix as booleans, row-major. */
export function qrMatrix(text, { ec = 'L' } = {}) {
  const qr = qrcode(0, ec);
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) =>
    Array.from({ length: n }, (_, c) => (qr.isDark(r, c) ? 1 : 0))
  );
}

/** An SVG string. Crisp at any size, no canvas, no network. */
export function qrSVG(text, { size = 240, margin = 3, dark = '#0b0f0c', light = '#ffffff' } = {}) {
  const m = qrMatrix(text);
  const n = m.length;
  const total = n + margin * 2;

  let path = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (m[r][c]) path += `M${c + margin} ${r + margin}h1v1h-1z`;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    `<rect width="${total}" height="${total}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/></svg>`
  );
}
