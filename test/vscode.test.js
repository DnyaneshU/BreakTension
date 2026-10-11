import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join(import.meta.dirname, '..', 'vscode');
const manifest = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'));
const src = readFileSync(join(DIR, 'extension.js'), 'utf8');

/**
 * The VS Code client.
 *
 * The hard requirement, stated by the user and the reason this client is a
 * modal rather than a lock: it must never interfere with work in progress.
 * An editor holds unsaved thought. A reminder that risks losing it is worse
 * than no reminder, because it gets uninstalled within the hour.
 *
 * These tests exist to keep that promise from eroding.
 */

// --- the promise ----------------------------------------------------------

test('never blocks or modifies the user\'s work', () => {
  const forbidden = [
    // Each of these can lose or disrupt work in progress.
    [/workspace\.applyEdit/, 'editing the user\'s files'],
    [/\.save\(\)/, 'forcing a save'],
    [/workbench\.action\.files\.save/, 'forcing a save'],
    [/workbench\.action\.closeAllEditors/, 'closing editors'],
    [/closeActiveEditor/, 'closing editors'],
    [/onWillSaveTextDocument/, 'intercepting saves'],
    [/tasks\.executeTask|terminal\.sendText/, 'running commands on the user\'s behalf'],
    [/setContext.*readonly|readonly.*setContext/i, 'making files read-only'],
  ];

  for (const [pattern, why] of forbidden) {
    assert.doesNotMatch(src, pattern, `must not interfere with work by ${why}`);
  }
});

test('does not register any save or edit interceptor', () => {
  assert.doesNotMatch(src, /onDidSaveTextDocument|onWillSave|onDidChangeTextDocument/);
});

test('the modal tells the user their work is safe', () => {
  // The promise should be visible to the person reading the dialog, not only
  // true in the source.
  assert.match(src, /work is untouched|nothing here is blocked/i);
});

// --- manifest -------------------------------------------------------------

test('the entry point exists and matches the manifest', () => {
  assert.ok(manifest.main);
  assert.ok(existsSync(join(DIR, manifest.main.replace('./', ''))));
});

test('activates without needing a particular language or file', () => {
  // Agent-driven work happens in every language; gating on one would miss it.
  assert.deepEqual(manifest.activationEvents, ['onStartupFinished']);
});

test('every contributed command is implemented', () => {
  for (const { command } of manifest.contributes.commands) {
    assert.ok(
      src.includes(`'${command}'`),
      `${command} is contributed but never registered`
    );
  }
});

test('the server URL is configurable and defaults to the local verifier', () => {
  const prop = manifest.contributes.configuration.properties['breaktension.serverUrl'];
  assert.match(prop.default, /^https?:\/\/localhost:\d+$/);
});

// --- sharing the budget ---------------------------------------------------

test('reports activity to the server rather than keeping its own timer', () => {
  // Two independent timers would mean switching apps dodges the break.
  assert.match(src, /'\/tick'/);
  assert.match(src, /client: CLIENT_NAME/);
  assert.doesNotMatch(src, /class ActivityTimer|new ActivityTimer/, 'the server owns the budget');
});

test('identifies itself so the server can report which clients are live', () => {
  assert.match(src, /CLIENT_NAME = 'editor'/);
});

test('does not report time while the window is unfocused', () => {
  // That time belongs to the browser client, or to nobody.
  assert.match(src, /window\.state\.focused/);
  assert.match(src, /if \(!userIsHere\(\)\)/);
});

// --- skipping -------------------------------------------------------------

test('skipping asks twice here too', () => {
  const fn = src.match(/async function confirmSkip\(\)[\s\S]*?\n\}/)[0];
  const modals = [...fn.matchAll(/showWarningMessage/g)];
  assert.equal(modals.length, 2, 'one prompt is not the ladder');
  assert.match(fn, /really sure/i);
});

test('both confirmations are required before the skip is sent', () => {
  const fn = src.match(/async function confirmSkip\(\)[\s\S]*?\n\}/)[0];
  const firstGuard = fn.indexOf("if (first !==");
  const secondGuard = fn.indexOf("if (second !==");
  const send = fn.indexOf("'/defer'");

  assert.ok(firstGuard > -1 && secondGuard > -1 && send > -1);
  assert.ok(firstGuard < send, 'the first confirmation must gate the request');
  assert.ok(secondGuard < send, 'so must the second');
});

// --- failure behaviour ----------------------------------------------------

test('a missing server is reported, not crashed on', () => {
  assert.match(src, /req\.on\('error'/);
  assert.match(src, /offline/);
  assert.match(src, /npm run server/, 'tell the user how to fix it');
});

test('requests time out rather than hanging the extension host', () => {
  assert.match(src, /timeout: \d+/);
  assert.match(src, /req\.on\('timeout'/);
});

test('the self-signed cert exception is scoped to the local request', () => {
  assert.match(src, /rejectUnauthorized: false/);
  // A global override would weaken TLS for everything in the extension host.
  assert.doesNotMatch(src, /NODE_TLS_REJECT_UNAUTHORIZED/);
});

test('the reminder interval is bounded so it cannot be set to zero', () => {
  assert.match(src, /Math\.max\(1,/);
});

// --- developer experience -------------------------------------------------

test('F5 has something to launch', () => {
  // Without .vscode/launch.json, pressing F5 in the extension folder does
  // nothing at all, with no error. That is a dead end for anyone trying to
  // run this, including its author.
  const launchPath = join(DIR, '.vscode', 'launch.json');
  assert.ok(existsSync(launchPath), 'vscode/.vscode/launch.json must exist');

  const launch = JSON.parse(readFileSync(launchPath, 'utf8'));
  const cfg = launch.configurations?.[0];

  assert.equal(cfg.type, 'extensionHost', 'must launch an extension host');
  assert.ok(
    cfg.args.some((a) => a.includes('--extensionDevelopmentPath')),
    'the host needs to be pointed at this folder'
  );
});
