import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(import.meta.dirname, '..', 'server', 'index.js'), 'utf8');

/**
 * Static checks on the HTTP surface.
 *
 * index.js starts a listening server on import, so these read the source
 * rather than booting it. Live behaviour is covered by running the server;
 * what matters here are the invariants that are easy to break while editing
 * and silent when broken.
 */

test('the route table is keyed by method and path', () => {
  const keys = [...SRC.matchAll(/^\s*'(GET|POST) (\/[a-z]*)':/gm)].map((m) => `${m[1]} ${m[2]}`);
  for (const r of ['GET /state', 'POST /due', 'POST /reset', 'GET /events', 'GET /capture', 'GET /task', 'POST /verify']) {
    assert.ok(keys.includes(r), `missing route: ${r}`);
  }
});

test('/state does not hand out the session token', () => {
  // Only the QR carries the token. A tab that could read it from /state
  // could verify a break without anyone going outside.
  const route = SRC.match(/'GET \/state':[^\n]*\n?[^\n]*/)[0];
  assert.doesNotMatch(route, /\btoken\b/);
});

test('the capture URL is built from origin, not a hardcoded scheme', () => {
  const due = SRC.match(/'POST \/due':[\s\S]*?\n  \},/)[0];
  assert.match(due, /\$\{origin\}/, 'must use the resolved origin');
  assert.doesNotMatch(due, /https:\/\/\$\{/, 'a hardcoded https breaks the HTTP fallback');
});

test('origin is derived from whether a certificate exists', () => {
  assert.match(SRC, /const scheme = cert \? 'https' : 'http'/);
  assert.match(SRC, /origin = `\$\{scheme\}:\/\/\$\{LAN\}:\$\{PORT\}`/);
});

test('/verify validates the token before doing any work', () => {
  const verify = SRC.match(/'POST \/verify':[\s\S]*?\n  \},/)[0];
  const tokenCheck = verify.indexOf('isTokenValid');
  const judgeCall = verify.indexOf('judgeStaged');
  assert.ok(tokenCheck > -1 && judgeCall > -1);
  assert.ok(tokenCheck < judgeCall, 'an invalid token must not reach the model');
});

test('/verify fails the session on a bad verdict rather than passing it', () => {
  const verify = SRC.match(/'POST \/verify':[\s\S]*?\n  \},/)[0];
  assert.match(verify, /if \(!verdict\.ok\)[\s\S]*session\.fail/);
  assert.match(verify, /session\.pass\(\)/);
});

test('the upload body is size-limited', () => {
  assert.match(SRC, /MAX_UPLOAD_BYTES/);
  assert.match(SRC, /payload too large/);
});

test('static file serving cannot escape the public directory', () => {
  assert.match(SRC, /normalize\(/);
  assert.match(SRC, /startsWith\(PUBLIC\)/, 'the resolved path must be confined to PUBLIC');
});

test('a wrong method gets 405 rather than falling through to a file read', () => {
  assert.match(SRC, /if \(req\.method === 'GET'\) return serveStatic/);
  assert.match(SRC, /405/);
});

test('EADDRINUSE is reported readably instead of as a stack trace', () => {
  assert.match(SRC, /EADDRINUSE/);
  assert.match(SRC, /BT_PORT=/, 'tell the user how to pick another port');
});

test('the server binds all interfaces so the phone can reach it', () => {
  assert.match(SRC, /listen\(PORT, '0\.0\.0\.0'/);
});

test('a missing certificate is explained, not left to fail silently', () => {
  // getUserMedia needs a secure context; without it the camera is a black
  // rectangle with no error the user can act on.
  assert.match(SRC, /camera will NOT work/i);
});
