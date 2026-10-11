import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Session } from './session.js';
import { Clients } from './clients.js';
import { judgeStaged } from './gemma.js';
import { bestLanAddress } from './net.js';
import { ensureCert } from './certs.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(HERE, 'public');
const PORT = Number(process.env.BT_PORT ?? 8787);
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

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

/**
 * The shared desk-time budget.
 *
 * It lives here rather than in a client because the browser and the editor
 * share one 35-minute stretch: switching apps is not a break. Each client
 * POSTs /tick while the user is active and the server decides when a break
 * is due.
 */
const clients = new Clients({ workMs: Number(process.env.BT_WORK_MS ?? 35 * 60 * 1000) });

/** Everyone listening for state changes: the extension, and any open phone page. */
const listeners = new Set();

// Set during boot, and used to build the capture URL. Not a constant: without
// a certificate the server falls back to HTTP, and a QR pointing at https on
// an http server fails with nothing useful shown to the user.
let origin = '';

// ── helpers ────────────────────────────────────────────────────────────────

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

function html(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">' +
      '<body style="font:16px system-ui;padding:2rem;background:#0b0f0c;color:#e8f0ea">' +
      body
  );
}

async function readBody(req, limitBytes = MAX_UPLOAD_BYTES) {
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
  // normalize, then strip leading separators and ".." so the path cannot
  // escape PUBLIC.
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

// ── routes ─────────────────────────────────────────────────────────────────
// Keyed by "METHOD /path". A table rather than an if-chain so a route cannot
// be shadowed by an earlier partial match, and the whole API is readable.

const ROUTES = {
  'GET /': (_req, res) =>
    json(res, 200, {
      name: 'BreakTension',
      state: session.state,
      origin,
      hint: 'Lock your browser until you go outside. Verified locally by Gemma.',
    }),

  // A liveness ping for the extension. Deliberately does not return the
  // token: only the QR carries that.
  'GET /state': (_req, res) =>
    json(res, 200, {
      ...session.toJSON(),
      origin,
      remainingMs: clients.remainingMs(),
      clients: clients.activeClients(),
    }),

  /**
   * A client reports that the user is active.
   *
   * The response tells it what to do, so a client needs no timer logic of its
   * own: it reports, and reacts to `due`.
   */
  'POST /tick': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {
      // A tick with no body is still a valid "I am here".
    }

    clients.report(body.client ?? 'unknown');

    // The client that noticed may not be the one that should lock, so the
    // decision is made once, here, and broadcast to all of them.
    if (clients.isDue() && session.state === 'idle' && !body.deferred) {
      const { token, task } = session.markDue();
      const captureUrl = `${origin}/capture?t=${token}`;
      broadcast('due', { task: { id: task.id, text: task.text }, captureUrl });
      return json(res, 200, { due: true, task, captureUrl, remainingMs: 0 });
    }

    json(res, 200, {
      due: session.state !== 'idle',
      remainingMs: clients.remainingMs(),
      clients: clients.activeClients(),
    });
  },

  // The break timer fired. Mint a token and tell everyone to lock.
  'POST /due': (_req, res) => {
    const { token, task } = session.markDue();
    const captureUrl = `${origin}/capture?t=${token}`;
    broadcast('due', { task: { id: task.id, text: task.text }, captureUrl });
    json(res, 200, { token, task, captureUrl });
  },

  // Back to work; start the next cycle.
  'POST /reset': (_req, res) => {
    session.reset();
    broadcast('reset', {});
    json(res, 200, session.toJSON());
  },

  // A verified break clears the shared budget for every client at once.
  'POST /credit': (_req, res) => {
    clients.creditBreak();
    json(res, 200, { remainingMs: clients.remainingMs() });
  },

  // Snooze or skip: stand the budget down without crediting a break.
  'POST /defer': async (req, res) => {
    let body = {};
    try {
      body = JSON.parse(await readBody(req, 4096));
    } catch {}

    if (body.ms) clients.snooze(Number(body.ms));
    else clients.creditBreak(); // a skip ends the cycle

    session.reset();
    broadcast('dismiss', { reason: body.reason ?? 'deferred' });
    json(res, 200, { remainingMs: clients.remainingMs() });
  },

  // The only channel that can unlock the browser.
  'GET /events': (req, res) => {
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
  },

  // The phone page. Claiming here means a reload mid-break is harmless.
  'GET /capture': (_req, res, url) => {
    const token = url.searchParams.get('t');
    if (!session.isTokenValid(token)) {
      return html(res, 410, '<h1 style="font-size:1.2rem">Link expired</h1><p style="opacity:.7">Scan the QR code on your laptop again.</p>');
    }
    session.claim(token);
    return serveStatic(res, 'capture.html');
  },

  // What am I supposed to do? Asked by the phone page on load.
  'GET /task': (_req, res, url) => {
    const token = url.searchParams.get('t');
    if (!session.isTokenValid(token)) return json(res, 410, { error: 'expired' });
    json(res, 200, {
      task: session.task ? { id: session.task.id, text: session.task.text } : null,
      attempts: session.attempts,
      state: session.state,
    });
  },

  // The photo. The only path that can lead to an unlock.
  'POST /verify': async (req, res) => {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch (err) {
      return json(res, 400, { ok: false, reason: `Could not read the photo (${err.message}).` });
    }

    const { token } = body ?? {};
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
    json(res, 200, { ok: true, ...verdict, durationMs });
  },
};

const handler = async (req, res) => {
  // The scheme here only matters for parsing; `origin` is what we hand out.
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  const route = ROUTES[`${req.method} ${url.pathname}`];
  if (route) return route(req, res, url);

  // Anything else is a static asset request from the phone page.
  if (req.method === 'GET') return serveStatic(res, url.pathname.slice(1));

  return json(res, 405, { error: 'method not allowed' });
};

// ── boot ───────────────────────────────────────────────────────────────────

const LAN = bestLanAddress() ?? '127.0.0.1';

const cert = ensureCert({ dir: join(process.cwd(), 'certs'), host: LAN });
const scheme = cert ? 'https' : 'http';
origin = `${scheme}://${LAN}:${PORT}`;

const server = cert
  ? createHttpsServer({ key: cert.key, cert: cert.cert }, handler)
  : createHttpServer(handler);

/**
 * A plain-HTTP companion on loopback, for the browser extension.
 *
 * The phone needs HTTPS: getUserMedia refuses to open a camera on a
 * non-secure origin over the LAN, which is why the self-signed certificate
 * exists at all. But that certificate is untrusted, and an MV3 service worker
 * cannot show a "proceed anyway" interstitial the way a tab can -- its fetch
 * just fails, and the extension reports the server as not running while it is
 * sitting there answering requests.
 *
 * `localhost` is a secure context even over plain HTTP, by specification. So
 * the extension gets an HTTP port bound to 127.0.0.1 only. It is not
 * reachable from the network, and the phone still gets TLS.
 */
const LOCAL_PORT = Number(process.env.BT_LOCAL_PORT ?? PORT + 1);
const localServer = cert ? createHttpServer(handler) : null;

if (!cert) {
  // getUserMedia needs a secure context, so without a certificate the phone
  // cannot open its camera at all. Say so rather than letting it fail later
  // as an unexplained black rectangle.
  console.warn('\n!  No certificate could be generated (is openssl installed?).');
  console.warn('!  Running over HTTP: the phone camera will NOT work, only localhost.\n');
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use.`);
    console.error(`  Another BreakTension server is probably running.`);
    console.error(`  Stop it, or start this one on another port:  BT_PORT=8788 npm run server\n`);
    process.exit(1);
  }
  throw err;
});

if (localServer) {
  localServer.on('error', (err) => {
    // Non-fatal: the HTTPS port is the one that matters for the phone.
    console.warn(`!  Could not open the local HTTP port ${LOCAL_PORT}: ${err.code}`);
  });
  localServer.listen(LOCAL_PORT, '127.0.0.1');
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  BreakTension server`);
  if (localServer) console.log(`  ├─ extension : http://localhost:${LOCAL_PORT}  (loopback only)`);
  console.log(`  ├─ laptop    : ${scheme}://localhost:${PORT}`);
  console.log(`  └─ phone     : ${origin}`);
  console.log(`\n  Model: ${process.env.BT_MODEL ?? 'gemma4:e4b'} via Ollama. Nothing leaves this machine.\n`);
});

export { handler, session, ROUTES };
