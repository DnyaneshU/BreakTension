import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXT = join(import.meta.dirname, '..', 'extension');
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const read = (f) => readFileSync(join(EXT, f), 'utf8');

/**
 * Static checks for the things Chrome only complains about at load time, or
 * worse, at runtime in a way that is easy to miss.
 */

test('manifest is v3', () => {
  assert.equal(manifest.manifest_version, 3);
});

test('every file the manifest references exists', () => {
  const refs = [
    manifest.background?.service_worker,
    manifest.options_page,
    manifest.action?.default_popup,
    ...(manifest.content_scripts ?? []).flatMap((c) => c.js ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...(manifest.web_accessible_resources ?? []).flatMap((w) => w.resources ?? []),
  ].filter(Boolean);

  for (const f of refs) {
    assert.ok(existsSync(join(EXT, f)), `manifest references missing file: ${f}`);
  }
});

test('service worker is a module, since it uses import', () => {
  assert.equal(manifest.background.type, 'module');
  assert.match(read('background.js'), /^import /m);
});

test('the permissions actually used are declared', () => {
  const src = read('background.js');
  const needed = [];
  if (/chrome\.alarms/.test(src)) needed.push('alarms');
  if (/chrome\.storage/.test(src)) needed.push('storage');
  if (/chrome\.tabs/.test(src)) needed.push('tabs');
  if (/chrome\.idle/.test(src)) needed.push('idle');
  if (/chrome\.notifications/.test(src)) needed.push('notifications');

  for (const p of needed) {
    assert.ok(manifest.permissions.includes(p), `background.js uses chrome.${p} but it is not in permissions`);
  }
});

test('the server origin is in host_permissions', () => {
  // Without this, fetch() from the worker is blocked and the lock never arrives.
  const src = read('background.js');
  const m = src.match(/const SERVER = '([^']+)'/);
  assert.ok(m, 'background.js should define SERVER');
  const origin = new URL(m[1]).origin;
  const ok = (manifest.host_permissions ?? []).some((h) => h.startsWith(origin));
  assert.ok(ok, `${origin} must appear in host_permissions`);
});

test('background uses chrome.alarms rather than long setTimeout', () => {
  const src = read('background.js');
  assert.match(src, /chrome\.alarms\.create/, 'MV3 workers are killed when idle; alarms are what survive');

  // A long setTimeout in a worker silently never fires once it is torn down.
  for (const m of src.matchAll(/setTimeout\([^,]+,\s*(\d+)/g)) {
    assert.ok(Number(m[1]) <= 5000, `setTimeout of ${m[1]}ms will not survive the worker being killed`);
  }
});

test('content script injects into every url, or the lock is escapable', () => {
  const cs = manifest.content_scripts[0];
  assert.ok(cs.matches.includes('<all_urls>'));
});

test('the overlay is reattached on new tabs', () => {
  // Opening a new tab must not be a way out of the lock.
  assert.match(read('background.js'), /chrome\.tabs\.onUpdated/);
});

test('qr.js is web accessible, since the content script imports it by URL', () => {
  const resources = (manifest.web_accessible_resources ?? []).flatMap((w) => w.resources);
  assert.ok(resources.includes('qr.js'));
  // qr.js imports the vendored encoder, so that must be reachable too.
  assert.ok(resources.includes('vendor-qrcode.mjs'), 'qr.js imports vendor-qrcode.mjs at runtime');
});

test('content script escapes interpolated text', () => {
  const src = read('content.js');
  assert.match(src, /escapeHtml/, 'task text and URLs go into innerHTML');
  // Check the task and url are actually run through it.
  assert.match(src, /escapeHtml\(task/);
  assert.match(src, /escapeHtml\(captureUrl/);
});

test('unlock only happens on a server event, never on a message from the page', () => {
  const src = read('background.js');
  assert.match(src, /addEventListener\('verified'/, 'unlock must be driven by the server SSE');

  // The page must not be able to ask for an unlock directly.
  assert.doesNotMatch(src, /msg\.type === 'bt-unlock'/, 'a page-originated unlock would defeat the product');
});

test('popup and options talk to the worker over runtime messaging', () => {
  for (const f of ['popup.js', 'options.js']) {
    assert.match(read(f), /chrome\.runtime\.sendMessage/, `${f} should use messaging`);
  }
});

test('no remote script is loaded anywhere — the lock screen must work offline', () => {
  for (const f of ['background.js', 'content.js', 'popup.js', 'options.js', 'qr.js']) {
    const src = read(f);
    assert.doesNotMatch(src, /https?:\/\/(cdn|unpkg|cdnjs|code\.jquery)/, `${f} must not load a remote script`);
  }
  for (const f of ['popup.html', 'options.html']) {
    assert.doesNotMatch(read(f), /<script[^>]+src=["']https?:/, `${f} must not load a remote script`);
  }
});

// --- message protocol -----------------------------------------------------

/**
 * The worker and the content script talk through string message types. A
 * rename on one side is silent at load time and only shows up as an overlay
 * that never appears, so the two sides are cross-checked here.
 */

function messageTypesSent(src) {
  const types = new Set();
  for (const m of src.matchAll(/type:\s*'(bt-[a-z-]+)'/g)) types.add(m[1]);
  return types;
}

function messageTypesHandled(src) {
  const types = new Set();
  // `msg.type === 'x'`, a `'x':` handler-table key, or `'x': async`
  for (const m of src.matchAll(/msg\??\.type === '(bt-[a-z-]+)'/g)) types.add(m[1]);
  for (const m of src.matchAll(/^\s*'(bt-[a-z-]+)':/gm)) types.add(m[1]);
  return types;
}

test('every message the worker sends to tabs is handled by the content script', () => {
  const sent = messageTypesSent(read('background.js'));
  const handled = messageTypesHandled(read('content.js'));

  // Types the worker sends to tabs, as opposed to ones it receives.
  for (const t of ['bt-lock', 'bt-unlock', 'bt-stage', 'bt-failed']) {
    assert.ok(sent.has(t), `background.js should send ${t}`);
    assert.ok(handled.has(t), `content.js must handle ${t}`);
  }
});

test('every message the content script sends is handled by the worker', () => {
  const sent = messageTypesSent(read('content.js'));
  const handled = messageTypesHandled(read('background.js'));

  for (const t of sent) {
    assert.ok(handled.has(t), `content.js sends ${t} but background.js has no handler`);
  }
});

test('every message the popup and options send is handled by the worker', () => {
  const handled = messageTypesHandled(read('background.js'));
  for (const f of ['popup.js', 'options.js']) {
    for (const t of messageTypesSent(read(f))) {
      assert.ok(handled.has(t), `${f} sends ${t} but background.js has no handler`);
    }
  }
});

test('the server address appears in exactly one place', () => {
  // A second hardcoded host or port silently breaks BT_PORT.
  const offenders = [];
  for (const f of ['content.js', 'popup.js', 'options.js']) {
    if (/localhost:\d+/.test(read(f))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'only background.js should name the server');
});

test('the content script does not fetch the server directly', () => {
  // It runs on the host page's origin, so a direct fetch needs CORS and
  // duplicates the server address. It asks the worker instead.
  assert.doesNotMatch(read('content.js'), /fetch\(\s*['"`]https?:/);
});
