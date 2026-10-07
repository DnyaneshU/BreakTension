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

test('every message the worker broadcasts to tabs is handled by the content script', () => {
  const src = read('background.js');
  const handled = messageTypesHandled(read('content.js'));

  // Derived from the source rather than a hardcoded list: a hardcoded list
  // silently passes when a NEW broadcast type is added, which is exactly the
  // bug this test is supposed to catch.
  const broadcast = new Set();
  for (const m of src.matchAll(/broadcastToTabs\(\s*\{\s*type:\s*'(bt-[a-z-]+)'/g)) broadcast.add(m[1]);
  for (const m of src.matchAll(/chrome\.tabs\.sendMessage\([^,]+,\s*\{\s*type:\s*'(bt-[a-z-]+)'/g)) broadcast.add(m[1]);

  assert.ok(broadcast.size >= 4, `expected several broadcast types, found ${[...broadcast]}`);

  for (const t of broadcast) {
    assert.ok(handled.has(t), `background.js sends ${t} to tabs but content.js has no handler`);
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

// --- escape hatches -------------------------------------------------------

test('hatch state is persisted and reloaded, so it survives a restart', () => {
  const src = read('background.js');
  // MV3 tears the worker down; anything not in storage is lost silently.
  assert.match(src, /chrome\.storage\.local\.get\(\[[^\]]*'hatches'/, 'hatches must be loaded on wake');
  assert.match(src, /chrome\.storage\.local\.set\(\{[^}]*hatches/, 'hatches must be saved');
});

test('every hatch action has a worker handler', () => {
  const handled = messageTypesHandled(read('background.js'));
  for (const t of ['bt-snooze', 'bt-skip', 'bt-set-meeting']) {
    assert.ok(handled.has(t), `missing handler: ${t}`);
  }
});

test('the hatches are reachable from the lock screen, not just the popup', () => {
  // Someone who genuinely cannot go outside is looking at the overlay.
  const src = read('content.js');
  for (const t of ['bt-snooze', 'bt-skip', 'bt-set-meeting']) {
    assert.ok(src.includes(t), `lock screen should offer ${t}`);
  }
});

test('a snooze or skip does not credit a break', () => {
  const src = read('background.js');
  const dismiss = src.match(/async function dismissLock\(\)[\s\S]*?\n\}/)[0];
  assert.doesNotMatch(dismiss, /creditBreak/, 'only a verified photo may credit a break');
  assert.match(dismiss, /\/reset/, 'the server session must be dropped so the token cannot be replayed');
});

test('a verified break restores the snooze for the next cycle', () => {
  const src = read('background.js');
  const unlock = src.match(/async function unlockAll\([\s\S]*?\n\}/)[0];
  assert.match(unlock, /resetCycle/);
  assert.match(unlock, /creditBreak/);
});

test('the popup explains what a pending break is waiting on', () => {
  // A timer sitting at zero with nothing happening looks broken.
  assert.match(read('background.js'), /deferredBy/);
  assert.match(read('popup.js'), /deferredBy/);
});
