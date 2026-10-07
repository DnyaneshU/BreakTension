import { ActivityTimer, breakAllowed, DEFAULTS } from './timer.js';

/**
 * The service worker.
 *
 * MV3 kills this worker after ~30 seconds idle, so nothing long-lived can
 * live in a closure here: the timer's accrued state is written to
 * chrome.storage on every tick and reloaded on wake. chrome.alarms, not
 * setTimeout, is what survives the worker being torn down.
 */

const SERVER = 'https://localhost:8787';
const ALARM = 'bt-tick';
const TICK_MINUTES = 0.5;

let timer = new ActivityTimer();
let settings = {
  workMs: DEFAULTS.workMs,
  quietStartHour: 22,
  quietEndHour: 7,
  workDaysOnly: false,
  enabled: true,
};
let locked = false;
let sse = null;

// --- persistence ----------------------------------------------------------

async function load() {
  const got = await chrome.storage.local.get(['activeMs', 'lastTick', 'settings', 'locked']);
  settings = { ...settings, ...(got.settings ?? {}) };
  timer = new ActivityTimer({ config: { workMs: settings.workMs } });
  timer.activeMs = got.activeMs ?? 0;
  timer.lastTick = got.lastTick ?? null;
  locked = got.locked ?? false;
}

async function save() {
  await chrome.storage.local.set({ activeMs: timer.activeMs, lastTick: timer.lastTick, locked });
}

// --- server ---------------------------------------------------------------

async function serverFetch(path, opts) {
  try {
    const res = await fetch(`${SERVER}${path}`, opts);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // server down; handled by the caller
  }
}

/**
 * Listen for the server's unlock event.
 *
 * The extension never unlocks because the phone said so — only because the
 * server, which owns the session and called Gemma, said so.
 */
function connectEvents() {
  try {
    sse?.close();
  } catch {}

  try {
    sse = new EventSource(`${SERVER}/events`);
  } catch {
    return;
  }

  sse.addEventListener('verified', async (e) => {
    let durationMs = null;
    try {
      durationMs = JSON.parse(e.data).durationMs;
    } catch {}
    await unlockAll(durationMs);
  });

  sse.addEventListener('failed', (e) => {
    let reason = '';
    try {
      reason = JSON.parse(e.data).reason ?? '';
    } catch {}
    broadcastToTabs({ type: 'bt-failed', reason });
  });

  sse.addEventListener('stage', (e) => {
    try {
      broadcastToTabs({ type: 'bt-stage', stage: JSON.parse(e.data).stage });
    } catch {}
  });

  sse.onerror = () => {
    try {
      sse.close();
    } catch {}
    sse = null;
  };
}

// --- locking --------------------------------------------------------------

async function broadcastToTabs(message) {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(
    tabs.map((t) => (t.id ? chrome.tabs.sendMessage(t.id, message).catch(() => {}) : null))
  );
}

async function lockAll() {
  const due = await serverFetch('/due', { method: 'POST' });

  if (!due) {
    // The server is the only thing that can verify a break. Without it we
    // say so rather than locking the browser with no way out.
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icon128.png',
      title: 'BreakTension needs its server',
      message: 'Run `npm run server` to start the local verifier. Not locking until then.',
    });
    return;
  }

  locked = true;
  await save();
  connectEvents();

  await broadcastToTabs({
    type: 'bt-lock',
    task: due.task?.text ?? '',
    captureUrl: due.captureUrl,
  });
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#f0b254' });
}

async function unlockAll(durationMs) {
  locked = false;
  timer.creditBreak(Date.now());
  await save();
  await serverFetch('/reset', { method: 'POST' });
  await broadcastToTabs({ type: 'bt-unlock', durationMs });
  chrome.action.setBadgeText({ text: '' });
  try {
    sse?.close();
  } catch {}
  sse = null;
}

// --- the tick -------------------------------------------------------------

async function tick() {
  await load();
  if (!settings.enabled || locked) return;

  const state = await chrome.idle.queryState(60);
  const now = Date.now();

  if (state === 'active') {
    timer.tick(now);
  } else {
    // Idle or locked screen: record the timestamp so the next active tick
    // measures a real gap, but accrue nothing.
    timer.lastTick = now;
  }

  await save();

  const mins = Math.ceil(timer.remainingMs() / 60000);
  chrome.action.setTitle({ title: `BreakTension — ${mins} min of desk time left` });

  if (!timer.isDue()) return;

  const gate = breakAllowed({
    date: new Date(),
    quietStartHour: settings.quietStartHour,
    quietEndHour: settings.quietEndHour,
    workDaysOnly: settings.workDaysOnly,
  });
  if (!gate.allowed) return;

  await lockAll();
}

// --- wiring ---------------------------------------------------------------

chrome.runtime.onInstalled.addListener(async () => {
  await load();
  chrome.alarms.create(ALARM, { periodInMinutes: TICK_MINUTES });
});

chrome.runtime.onStartup.addListener(async () => {
  await load();
  chrome.alarms.create(ALARM, { periodInMinutes: TICK_MINUTES });
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) tick();
});

// A newly opened or navigated tab must be covered too, or the lock is
// trivially escapable by opening a new tab.
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete' || !locked) return;
  const due = await serverFetch('/state');
  if (!due || due.state === 'idle') return;
  chrome.tabs
    .sendMessage(tabId, { type: 'bt-lock', task: due.task?.text ?? '', captureUrl: `https://${due.lan}:${due.port}/capture` })
    .catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    await load();

    if (msg.type === 'bt-status') {
      const srv = await serverFetch('/state');
      reply({
        ...timer.toJSON(),
        locked,
        enabled: settings.enabled,
        serverUp: Boolean(srv),
        settings,
      });
      return;
    }

    if (msg.type === 'bt-force-break') {
      await lockAll();
      reply({ ok: true });
      return;
    }

    if (msg.type === 'bt-set-enabled') {
      settings.enabled = Boolean(msg.value);
      await chrome.storage.local.set({ settings });
      reply({ ok: true, enabled: settings.enabled });
      return;
    }

    if (msg.type === 'bt-save-settings') {
      settings = { ...settings, ...msg.settings };
      await chrome.storage.local.set({ settings });
      reply({ ok: true, settings });
      return;
    }

    reply({ ok: false });
  })();
  return true; // async reply
});

load().then(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: TICK_MINUTES });
  if (locked) connectEvents();
});
