import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './session.js';
import { judgeStaged } from './gemma.js';
import { bestLanAddress } from './net.js';
import { ensureCert } from './certs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.BT_PORT ?? 8787);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// One session per laptop. Single user by design — nothing leaves this machine.
const session = new Session();

/** Everyone listening for state changes: the extension, and any open phone page. */
const listeners = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(frame);
    } catch {
      listeners.delete(res);
    }
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    // The extension's lock overlay runs on arbitrary pages, so it needs to
    // reach this origin. Only ever served on the LAN, to one user.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(payload);
}

async function readBody(req, limitBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, urlPath) {
  // normalize + strip leading separators so "../" cannot escape PUBLIC
  const rel = normalize(urlPath).replace(/^([/\\]|\.\.([/\\]|$))+/, '');
  const file = join(PUBLIC, rel || 'capture.html');
  if (!file.startsWith(PUBLIC)) return json(res, 403, { error: 'forbidden' });

  try {
    const buf = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  }
}

const handler = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  // --- extension-facing -------------------------------------------------

  if (path === '/state') {
    return json(res, 200, { ...session.toJSON(), lan: LAN, port: PORT });
  }

  // The break timer fired. Mint a token and tell everyone to lock.
  if (path === '/due' && req.method === 'POST') {
    const { token, task } = session.markDue();
    const captureUrl = `https://${LAN}:${PORT}/capture?t=${token}`;
    broadcast('due', { task: { id: task.id, text: task.text }, captureUrl });
    return json(res, 200, { token, task, captureUrl });
  }

  // Back to work; start the next cycle.
  if (path === '/reset' && req.method === 'POST') {
    session.reset();
    broadcast('reset', {});
    return json(res, 200, session.toJSON());
  }

  // Server-sent events: the only channel that can unlock the browser.
  if (path === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: hello\ndata: ${JSON.stringify(session.toJSON())}\n\n`);
    listeners.add(res);

    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
      }
    }, 20_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      listeners.delete(res);
    });
    return;
  }

  // --- phone-facing -----------------------------------------------------

  if (path === '/capture') {
    const token = url.searchParams.get('t');
    if (!session.isTokenValid(token)) {
      res.writeHead(410, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
          '<body style="font:16px system-ui;padding:2rem;background:#0b0f0c;color:#e8f0ea">' +
          '<h1 style="font-size:1.2rem">Link expired</h1>' +
          '<p style="opacity:.7">Scan the QR code on your laptop again.</p>'
      );
    }
    session.claim(token);
    return serveStatic(res, 'capture.html');
  }

  // What am I supposed to do? Asked by the phone page on load.
  if (path === '/task') {
    const token = url.searchParams.get('t');
    if (!session.isTokenValid(token)) return json(res, 410, { error: 'expired' });
    return json(res, 200, {
      task: session.task ? { id: session.task.id, text: session.task.text } : null,
      attempts: session.attempts,
      state: session.state,
    });
  }

  // The photo. This is the only path that can lead to an unlock.
  if (path === '/verify' && req.method === 'POST') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { ok: false, reason: `Could not read the photo (${err.message}).` });
    }

    const token = body?.token;
    if (!session.isTokenValid(token)) {
      return json(res, 410, { ok: false, reason: 'This link expired. Scan the QR code again.' });
    }
    if (!session.claim(token)) {
      return json(res, 409, { ok: false, reason: 'This break is no longer open.' });
    }

    broadcast('judging', { attempts: session.attempts });

    const verdict = await judgeStaged({
      imageB64: body.image,
      task: session.task,
      onProgress: (stage) => broadcast('stage', { stage }),
    });

    if (!verdict.ok) {
      session.fail(verdict.reason);
      broadcast('failed', { reason: verdict.reason, stage: verdict.stage, attempts: session.attempts });
      return json(res, 200, { ok: false, ...verdict });
    }

    const durationMs = session.pass();
    broadcast('verified', { durationMs, task: session.task?.text });
    return json(res, 200, { ok: true, ...verdict, durationMs });
  }

  if (path === '/' || path === '') {
    return json(res, 200, {
      name: 'BreakTension',
      state: session.state,
      lan: LAN,
      hint: 'Lock your browser until you go outside. Verified locally by Gemma.',
    });
  }

  return serveStatic(res, path.slice(1));
};

// --- boot -----------------------------------------------------------------

const LAN = bestLanAddress() ?? '127.0.0.1';

const cert = ensureCert({ dir: join(process.cwd(), 'certs'), host: LAN });
let server;
let scheme;

if (cert) {
  server = createHttpsServer({ key: cert.key, cert: cert.cert }, handler);
  scheme = 'https';
} else {
  // Without a cert the phone cannot open its camera, but localhost still can,
  // so run anyway and say plainly what is lost.
  server = createHttpServer(handler);
  scheme = 'http';
  console.warn('\n!  No certificate could be generated (is openssl installed?).');
  console.warn('!  Running over HTTP: the phone camera will NOT work, only localhost.\n');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  BreakTension server`);
  console.log(`  ├─ laptop : ${scheme}://localhost:${PORT}`);
  console.log(`  └─ phone  : ${scheme}://${LAN}:${PORT}`);
  console.log(`\n  Model: ${process.env.BT_MODEL ?? 'gemma4:e4b'} via Ollama. Nothing leaves this machine.\n`);
});

export { handler, session };
