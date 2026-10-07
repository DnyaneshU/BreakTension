import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { qrMatrix, qrSVG } from '../extension/qr.js';

const URL_UNDER_TEST = 'https://192.168.0.111:8787/capture?t=afc4d5ca05a2d6fee7e237e30ebd569a';

test('matrix is square and plausibly sized', () => {
  const m = qrMatrix(URL_UNDER_TEST);
  assert.ok(m.length >= 21);
  for (const row of m) assert.equal(row.length, m.length);
});

test('finder patterns are present in all three corners', () => {
  const m = qrMatrix(URL_UNDER_TEST);
  const n = m.length;
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(m[r0][c0], 1, 'finder corner should be dark');
    assert.equal(m[r0 + 1][c0 + 1], 0, 'finder ring should have a light band');
    assert.equal(m[r0 + 3][c0 + 3], 1, 'finder centre should be dark');
  }
});

test('svg contains a path and the right viewBox', () => {
  const svg = qrSVG(URL_UNDER_TEST, { size: 200 });
  assert.match(svg, /^<svg /);
  assert.match(svg, /<path d="M/);
  assert.match(svg, /width="200"/);
});

test('different payloads produce different matrices', () => {
  const a = JSON.stringify(qrMatrix('https://example.com/a'));
  const b = JSON.stringify(qrMatrix('https://example.com/b'));
  assert.notEqual(a, b);
});

/**
 * The test that matters: a real decoder must read it back.
 *
 * The hand-rolled encoder this replaced produced a matrix that passed every
 * structural check above and still decoded to nothing. Skipped when OpenCV
 * is unavailable so the suite stays runnable anywhere.
 */
test('a real decoder reads the generated code back', (t) => {
  let haveCv2 = false;
  try {
    execFileSync('python', ['-I', '-c', 'import cv2'], { stdio: 'ignore' });
    haveCv2 = true;
  } catch {}
  if (!haveCv2) return t.skip('OpenCV not installed');

  const m = qrMatrix(URL_UNDER_TEST);
  const n = m.length;
  const S = 8;
  const pad = 4 * S;
  const dim = n * S + pad * 2;
  const buf = Buffer.alloc(dim * dim, 255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!m[r][c]) continue;
      for (let y = 0; y < S; y++) {
        for (let x = 0; x < S; x++) buf[(pad + r * S + y) * dim + (pad + c * S + x)] = 0;
      }
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'bt-qr-'));
  const pgm = join(dir, 'qr.pgm');
  writeFileSync(pgm, Buffer.concat([Buffer.from(`P5\n${dim} ${dim}\n255\n`), buf]));

  const out = execFileSync(
    'python',
    ['-I', '-c', 'import sys,cv2;d,_,_=cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1],cv2.IMREAD_GRAYSCALE));sys.stdout.write(d)', pgm],
    { encoding: 'utf8' }
  );

  assert.equal(out.trim(), URL_UNDER_TEST, 'the lock screen QR must actually scan');
});
