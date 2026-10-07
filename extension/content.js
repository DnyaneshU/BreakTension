/**
 * The lock overlay.
 *
 * Injected into every tab. Lives in a closed shadow root so the host page's
 * CSS cannot restyle it and page scripts cannot easily reach in and remove
 * it. This is not a security boundary — a determined user has devtools — but
 * it does stop the overlay from being broken accidentally by whatever page
 * happens to be open, which is the realistic failure.
 */

const HOST_ID = 'breaktension-lock-host';
let host = null;
let root = null;
let qrLoaded = null;

const STAGE_LABELS = {
  outdoor: 'Checking you are outdoors…',
  glass: 'Checking it is not through a window…',
  screen: 'Checking it is a real scene…',
  task: 'Checking the task…',
};

function ensureHost() {
  if (host && document.documentElement.contains(host)) return root;

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647';
  root = host.attachShadow({ mode: 'closed' });
  document.documentElement.appendChild(host);
  return root;
}

function teardown() {
  try {
    host?.remove();
  } catch {}
  host = null;
  root = null;
  document.documentElement.style.overflow = '';
}

/** Load the QR renderer lazily; it is only needed while locked. */
async function renderQR(url, size) {
  qrLoaded ??= import(chrome.runtime.getURL('qr.js'));
  try {
    const { qrSVG } = await qrLoaded;
    return qrSVG(url, { size, margin: 3, dark: '#0b140d', light: '#ffffff' });
  } catch {
    return null;
  }
}

async function showLock({ task, captureUrl }) {
  const r = ensureHost();
  document.documentElement.style.overflow = 'hidden';

  r.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing:border-box; margin:0; }
      .wrap {
        position:fixed; inset:0;
        background:
          radial-gradient(1200px 600px at 50% -10%, #16301f 0%, transparent 60%),
          #080c09;
        color:#e9f1ea;
        font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
        display:grid; place-items:center; padding:28px; overflow:auto;
      }
      .card { width:100%; max-width:560px; text-align:center; }
      .eyebrow { font-size:11px; letter-spacing:.18em; text-transform:uppercase; color:#7f9a8a; }
      h1 { font-size:clamp(26px,5vw,40px); font-weight:650; letter-spacing:-.02em; margin:10px 0 8px; }
      .sub { color:#9bb0a3; font-size:15px; margin-bottom:22px; }
      .task {
        border:1px solid #27382e; background:#101710; border-radius:14px;
        padding:16px 18px; margin-bottom:20px;
      }
      .task .lbl { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:#7f9a8a; }
      .task .txt { font-size:19px; font-weight:600; color:#6fe39a; margin-top:5px; }
      .qr { background:#fff; border-radius:16px; padding:14px; display:inline-block; line-height:0; }
      .qr svg { display:block; width:200px; height:200px; }
      .hint { color:#9bb0a3; font-size:14px; margin-top:16px; }
      .url {
        margin-top:10px; font:12px/1.5 ui-monospace,monospace; color:#7f9a8a;
        word-break:break-all; max-width:42ch; margin-inline:auto;
      }
      .status { margin-top:18px; font-size:14px; min-height:22px; color:#6fe39a; }
      .status.bad { color:#f09a8a; }
      .hatches {
        margin-top:22px; display:flex; gap:9px; justify-content:center; flex-wrap:wrap;
      }
      .hatches button {
        font:inherit; font-size:13px; color:#9bb0a3; background:transparent;
        border:1px solid #27382e; border-radius:9px; padding:8px 13px; cursor:pointer;
      }
      .hatches button:hover:not([disabled]) { color:#e9f1ea; border-color:#3a5244; }
      .hatches button[disabled] { opacity:.35; cursor:default; }
      .hatch-note { margin-top:11px; color:#6d8478; font-size:12px; min-height:16px; }
      .why { margin-top:26px; padding-top:18px; border-top:1px solid #1c2a21; color:#6d8478; font-size:13px; }
      .ok { font-size:30px; font-weight:650; color:#6fe39a; }
      @media (prefers-reduced-motion:no-preference) {
        .card { animation:rise .28s ease-out both; }
        @keyframes rise { from { opacity:0; transform:translateY(8px); } }
      }
    </style>
    <div class="wrap">
      <div class="card">
        <div class="eyebrow">BreakTension</div>
        <h1>Time to go outside</h1>
        <p class="sub">You have been at the screen for a while. Your browser is locked until you prove you stepped out.</p>

        <div class="task">
          <div class="lbl">Your task</div>
          <div class="txt" id="task">${escapeHtml(task || '—')}</div>
        </div>

        <div class="qr" id="qr"><div style="width:200px;height:200px"></div></div>

        <p class="hint">Scan with your phone, go outside, take the photo.</p>
        <div class="url" id="url">${escapeHtml(captureUrl || '')}</div>

        <div class="status" id="status"></div>

        <div class="hatches">
          <button id="bt-snooze">Snooze 5 min</button>
          <button id="bt-skip">Emergency skip</button>
          <button id="bt-meeting">I'm in a meeting</button>
        </div>
        <div class="hatch-note" id="hatch-note"></div>

        <p class="why">
          The photo is judged by Gemma on your own laptop. Nothing is uploaded,
          no account, no internet.
        </p>
      </div>
    </div>`;

  const svg = await renderQR(captureUrl, 200);
  const slot = r.getElementById('qr');
  if (svg && slot) slot.innerHTML = svg;
  else if (slot) slot.innerHTML = '<div style="width:200px;padding:20px;color:#333;font:13px system-ui">Open the link below on your phone.</div>';

  await wireHatches(r);
}

/**
 * The escape hatches, on the lock screen itself.
 *
 * They have to be reachable from here, not only the popup: someone who
 * genuinely cannot step outside right now is looking at this overlay, and
 * telling them to hunt through a toolbar menu is how a tool gets uninstalled.
 *
 * Each button is still a limited resource, and the note under them says what
 * it costs, so the honest choice stays visible.
 */
async function wireHatches(r) {
  const note = r.getElementById('hatch-note');
  const snoozeBtn = r.getElementById('bt-snooze');
  const skipBtn = r.getElementById('bt-skip');
  const meetingBtn = r.getElementById('bt-meeting');
  if (!snoozeBtn) return;

  const status = await chrome.runtime.sendMessage({ type: 'bt-status' }).catch(() => null);

  if (status) {
    snoozeBtn.disabled = !status.canSnooze;
    skipBtn.disabled = status.skipsLeft <= 0;
    skipBtn.textContent = `Emergency skip (${status.skipsLeft} left today)`;
    if (note) {
      note.textContent = status.canSnooze
        ? 'One snooze per break. Skips reset tomorrow.'
        : 'Already snoozed this break.';
    }
  }

  const act = async (type, pending) => {
    for (const b of [snoozeBtn, skipBtn, meetingBtn]) b.disabled = true;
    if (note) note.textContent = pending;

    const res = await chrome.runtime.sendMessage({ type }).catch(() => null);
    // On success the worker broadcasts bt-dismiss and this overlay goes away,
    // so there is nothing to re-enable. On failure, say why.
    if (!res?.ok && note) {
      note.textContent = res?.reason ?? 'That did not work.';
      if (status) {
        snoozeBtn.disabled = !status.canSnooze;
        skipBtn.disabled = status.skipsLeft <= 0;
        meetingBtn.disabled = false;
      }
    }
  };

  snoozeBtn.onclick = () => act('bt-snooze', 'Snoozing…');
  skipBtn.onclick = () => act('bt-skip', 'Skipping…');
  meetingBtn.onclick = async () => {
    for (const b of [snoozeBtn, skipBtn, meetingBtn]) b.disabled = true;
    if (note) note.textContent = 'Holding breaks for an hour…';
    const res = await chrome.runtime
      .sendMessage({ type: 'bt-set-meeting', value: true })
      .catch(() => null);
    if (!res?.ok && note) note.textContent = 'That did not work.';
  };
}

function setStatus(text, bad) {
  const el = root?.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = bad ? 'status bad' : 'status';
}

async function showUnlocked(durationMs) {
  if (!root) return teardown();
  const mins = durationMs ? Math.max(1, Math.round(durationMs / 60000)) : null;
  const card = root.querySelector('.card');
  if (card) {
    card.innerHTML = `
      <div class="eyebrow">BreakTension</div>
      <h1>Welcome back</h1>
      <p class="ok">${mins ? `${mins} minute${mins === 1 ? '' : 's'} outside` : 'Verified'}</p>
      <p class="sub" style="margin-top:14px">Unlocking…</p>`;
  }
  setTimeout(teardown, 1400);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'bt-lock') showLock(msg);
  else if (msg?.type === 'bt-unlock') showUnlocked(msg.durationMs);
  // Snoozed or skipped: the overlay goes away without the "welcome back"
  // celebration, because nobody went anywhere.
  else if (msg?.type === 'bt-dismiss') teardown();
  else if (msg?.type === 'bt-stage') setStatus(STAGE_LABELS[msg.stage] ?? 'Checking…', false);
  else if (msg?.type === 'bt-failed') setStatus(msg.reason || 'That did not pass. Try again.', true);
});

// If the worker locked things while this tab was loading, catch up.
//
// The worker is asked for the lock details rather than this script fetching
// the server itself: a content script runs on the host page's origin, so a
// direct fetch needs CORS and would duplicate the server address in a second
// place. Asking the worker keeps one source of truth for the port.
chrome.runtime
  .sendMessage({ type: 'bt-lock-state' })
  .then((lock) => {
    if (lock?.locked && lock.task) {
      showLock({ task: lock.task, captureUrl: lock.captureUrl });
    }
  })
  .catch(() => {});
