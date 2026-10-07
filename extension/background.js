import { ActivityTimer, breakAllowed, DEFAULTS } from './timer.js';

/**
 * The service worker.
 *
 * MV3 tears this worker down after ~30 seconds idle, so nothing durable can
 * live in a module-level variable: everything that must survive is written to
 * chrome.storage each tick and reloaded on wake. chrome.alarms, not
 * setTimeout, is what still fires after a teardown.
 *
 * The current lock — task text and capture URL, token included — is stored
 * too. Without it, a tab that loads while the browser is locked has no way to
 * learn what to display, and `/state` deliberately does not hand out the
 * token.
 */

const SERVER = 'https://localhost:8787';
const ALARM = 'bt-tick';
const TICK_MINUTES = 0.5;

const DEFAULT_SETTINGS = {
  workMs: DEFAULTS.workMs,
  quietStartHour: 22,
  quietEndHour: 7,
  workDaysOnly: false,
  enabled: true,
};

let timer = new ActivityTimer();
let settings = { ...DEFAULT_SETTINGS };
let lock = null; // { task, captureUrl } while locked, else null
let sse = null;

// ── persistence ────────────────────────────────────────────────────────────

async function load() {
  const got = await chrome.storage.local.get(['activeMs', 'lastTick', 'settings', 'lock']);
  settings = { ...DEFAULT_SETTINGS, ...(got.settings ?? {}) };
  timer = new ActivityTimer({ config: { workMs: settings.workMs } });
  timer.activeMs = got.activeMs ?? 0;
  timer.lastTick = got.lastTick ?? null;
  lock = got.lock ?? null;
}

const save = () =>
  chrome.storage.local.set({ activeMs: timer.activeMs, lastTick: timer.lastTick, lock });

const saveSettings = () => chrome.storage.local.set({ settings });

// ── server ─────────────────────────────────────────────────────────────────

/** Returns parsed JSON, or null if the server is down or unhappy. */
async function serverFetch(path, opts) {
  try {
    const res = await fetch(`${SERVER}${path}`, opts);
    return res.ok ? await res.json() : null;
  } catch {
    return null; // server down; every caller treats null as "cannot verify"
  }
}

const parseData = (e) => {
  try {
    return JSON.parse(e.data);
  } catch {
    return {};
  }
};

/**
 * Listen for the server's events.
 *
 * The extension never unlocks because a page or the phone asked it to — only
 * because the server, which owns the session and called Gemma, said so.
 */
function connectEvents() {
  closeEvents();

  try {
    sse = new EventSource(`${SERVER}/events`);
  } catch {
    return;
  }

  sse.addEventListener('verified', (e) => unlockAll(parseData(e).durationMs));
  sse.addEventListener('failed', (e) =>
    broadcastToTabs({ type: 'bt-failed', reason: parseData(e).reason ?? '' })
  );
  sse.addEventListener('stage', (e) =>
    broadcastToTabs({ type: 'bt-stage', stage: parseData(e).stage })
  );
  sse.onerror = closeEvents;
}

function closeEvents() {
  try {
    sse?.close();
  } catch {}
  sse = null;
}

// ── locking ────────────────────────────────────────────────────────────────

async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.filter((t) => t.id).map((t) => chrome.tabs.sendMessage(t.id, message).catch(() => {}))
  );
}

function setBadge(locked) {
  chrome.action.setBadgeText({ text: locked ? '!' : '' });
  if (locked) chrome.action.setBadgeBackgroundColor({ color: '#f0b254' });
}

async function lockAll() {
  const due = await serverFetch('/due', { method: 'POST' });

  if (!due) {
    // The server is the only thing that can verify a break, so without it we
    // say so rather than locking the browser with no way back out.
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'BreakTension needs its server',
      message: 'Run `npm run server` to start the local verifier. Not locking until then.',
    });
    return false;
  }

  lock = { task: due.task?.text ?? '', captureUrl: due.captureUrl };
  await save();
  connectEvents();

  await broadcastToTabs({ type: 'bt-lock', ...lock });
  setBadge(true);
  return true;
}

async function unlockAll(durationMs) {
  lock = null;
  timer.creditBreak(Date.now());
  await save();
  await serverFetch('/reset', { method: 'POST' });
  await broadcastToTabs({ type: 'bt-unlock', durationMs });
  setBadge(false);
  closeEvents();
}

// ── the tick ───────────────────────────────────────────────────────────────

async function tick() {
  await load();
  if (!settings.enabled || lock) return;

  const idleState = await chrome.idle.queryState(60);
  const now = Date.now();

  if (idleState === 'active') {
    timer.tick(now);
  } else {
    // Idle or locked screen: record the timestamp so the next active tick
    // measures a real gap, but accrue nothing.
    timer.lastTick = now;
  }
  await save();

  chrome.action.setTitle({
    title: `BreakTension — ${Math.ceil(timer.remainingMs() / 60000)} min of desk time left`,
  });

  if (!timer.isDue()) return;

  const gate = breakAllowed({ date: new Date(), ...settings });
  if (gate.allowed) await lockAll();
}

// ── messages ───────────────────────────────────────────────────────────────

const HANDLERS = {
  'bt-status': async () => ({
    ...timer.toJSON(),
    locked: Boolean(lock),
    enabled: settings.enabled,
    serverUp: Boolean(await serverFetch('/state')),
    settings,
  }),

  // What a tab needs to render the overlay, including the token-bearing URL.
  'bt-lock-state': async () => ({ locked: Boolean(lock), ...(lock ?? {}) }),

  'bt-force-break': async () => ({ ok: await lockAll() }),

  'bt-set-enabled': async (msg) => {
    settings.enabled = Boolean(msg.value);
    await saveSettings();
    return { ok: true, enabled: settings.enabled };
  },

  'bt-save-settings': async (msg) => {
    settings = { ...settings, ...msg.settings };
    await saveSettings();
    return { ok: true, settings };
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const handler = HANDLERS[msg?.type];
  if (!handler) return false; // not ours; let other listeners answer

  (async () => {
    await load();
    reply(await handler(msg));
  })();
  return true; // reply is async
});

// ── wiring ─────────────────────────────────────────────────────────────────

const startAlarm = () => chrome.alarms.create(ALARM, { periodInMinutes: TICK_MINUTES });

chrome.runtime.onInstalled.addListener(() => load().then(startAlarm));
chrome.runtime.onStartup.addListener(() => load().then(startAlarm));

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

// A newly opened or navigated tab must be covered too, or opening a new tab
// is a trivial way out of the lock.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  await load();
  if (!lock) return;
  chrome.tabs.sendMessage(tabId, { type: 'bt-lock', ...lock }).catch(() => {});
});

load().then(() => {
  startAlarm();
  if (lock) connectEvents();
});
