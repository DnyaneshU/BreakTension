const vscode = require('vscode');
const https = require('node:https');
const http = require('node:http');

/**
 * BreakTension for VS Code.
 *
 * The case for an editor client: someone driving an agent in Claude Code is
 * the *most* sedentary person in the building. You are not even typing — you
 * are watching a model work. The browser extension never sees that time, so
 * the editor reports it into the same shared budget.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It never interferes with your work. No blocked saves, no intercepted edits,
 * no closed editors, no cancelled tasks. A modal appears, and if you dismiss
 * it, it comes back. That is the whole mechanism.
 *
 * The reason is simple: an editor holds work in progress. A break reminder
 * that risks losing someone's unsaved thought is worse than no reminder,
 * because it gets uninstalled within the hour. Friction has to come from
 * persistence, not from taking anything away.
 */

const CLIENT_NAME = 'editor';
const TICK_MS = 30 * 1000;

let statusBar;
let tickTimer;
let remindTimer;
let lastPromptAt = 0;
let locked = false;
let paused = false;

// ── talking to the local server ────────────────────────────────────────────

function config() {
  return vscode.workspace.getConfiguration('breaktension');
}

/**
 * A small fetch that tolerates the self-signed certificate.
 *
 * The server generates its own cert so the phone can open its camera over
 * the LAN. `rejectUnauthorized: false` is scoped to this request to a
 * loopback address the user started themselves — it is not a blanket
 * relaxation of TLS.
 */
function request(path, { method = 'GET', body } = {}) {
  const base = config().get('serverUrl') ?? 'https://localhost:8787';
  const url = new URL(path, base);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = mod.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
        timeout: 5000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );

    req.on('error', () => resolve(null)); // server not running
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ── activity ───────────────────────────────────────────────────────────────

/**
 * Has the user touched the editor recently?
 *
 * `window.state.focused` is the honest signal: if VS Code is not focused, the
 * user may be in the browser, and the browser client is reporting that time
 * instead. Double reporting is harmless — the server counts wall clock once —
 * but reporting while the laptop is shut would be wrong.
 */
function userIsHere() {
  return vscode.window.state.focused;
}

async function tick() {
  if (paused || !config().get('enabled')) return render({ offline: false, paused: true });

  if (!userIsHere()) {
    // Not focused: let the browser client account for this time.
    const state = await request('/state');
    return render({ offline: state === null, remainingMs: state?.remainingMs });
  }

  const res = await request('/tick', { method: 'POST', body: { client: CLIENT_NAME } });

  if (res === null) {
    return render({ offline: true });
  }

  if (res.due) {
    locked = true;
    render({ remainingMs: 0, due: true });
    await promptBreak(res.task?.text, res.captureUrl);
    return;
  }

  locked = false;
  render({ remainingMs: res.remainingMs, clients: res.clients });
}

// ── the prompt ─────────────────────────────────────────────────────────────

/**
 * Ask the user to go outside.
 *
 * A modal, because a toast is dismissed without being read. It reappears on
 * a timer while the break is still owed, which is the only pressure this
 * client applies.
 */
async function promptBreak(taskText, captureUrl) {
  const now = Date.now();
  const everyMs = Math.max(1, Number(config().get('remindEveryMinutes') ?? 3)) * 60 * 1000;
  if (now - lastPromptAt < everyMs) return;
  lastPromptAt = now;

  const task = taskText ? `Your task: ${taskText}` : 'Go outside and take a photo.';

  const choice = await vscode.window.showWarningMessage(
    'Time to go outside.',
    {
      modal: true,
      detail:
        `${task}\n\n` +
        'Scan the QR on your laptop, or open the capture link on your phone. ' +
        'Gemma checks the photo locally — nothing is uploaded.\n\n' +
        'Your work is untouched: nothing here is blocked, saved, or closed.',
    },
    'Copy capture link',
    'Snooze 5 min',
    'Skip this break'
  );

  if (choice === 'Copy capture link' && captureUrl) {
    await vscode.env.clipboard.writeText(captureUrl);
    vscode.window.showInformationMessage('Capture link copied. Open it on your phone.');
    return;
  }

  if (choice === 'Snooze 5 min') {
    await request('/defer', { method: 'POST', body: { ms: 5 * 60 * 1000, reason: 'snooze' } });
    locked = false;
    lastPromptAt = 0;
    vscode.window.setStatusBarMessage('BreakTension: snoozed 5 minutes', 4000);
    return;
  }

  if (choice === 'Skip this break') {
    await confirmSkip();
  }
  // Dismissed with Escape: the reminder comes back on the next interval.
}

/**
 * Skipping asks twice.
 *
 * Same ladder as the browser lock screen. The product's claim is that a break
 * is not dismissible in a quarter of a second, and a one-click skip in the
 * editor would quietly take that away on whichever surface the user prefers.
 */
async function confirmSkip() {
  const first = await vscode.window.showWarningMessage(
    'Skip this break?',
    { modal: true, detail: 'You have been at the screen a while.' },
    'Yes, skip it'
  );
  if (first !== 'Yes, skip it') return;

  const second = await vscode.window.showWarningMessage(
    'Are you really sure?',
    {
      modal: true,
      detail: 'This spends one of your 2 skips today, and your streak resets.',
    },
    'I am sure, skip it'
  );
  if (second !== 'I am sure, skip it') return;

  await request('/defer', { method: 'POST', body: { reason: 'skip' } });
  locked = false;
  lastPromptAt = 0;
  vscode.window.setStatusBarMessage('BreakTension: break skipped', 4000);
}

// ── status bar ─────────────────────────────────────────────────────────────

function render({ offline, paused: isPaused, remainingMs, due, clients } = {}) {
  if (!statusBar) return;

  if (isPaused) {
    statusBar.text = '$(debug-pause) BreakTension paused';
    statusBar.tooltip = 'Editor time is not being counted. Click to resume.';
    statusBar.backgroundColor = undefined;
    return;
  }

  if (offline) {
    statusBar.text = '$(debug-disconnect) BreakTension';
    statusBar.tooltip =
      'The local verifier is not running.\nStart it with: npm run server\n\nNo break can be verified without it.';
    statusBar.backgroundColor = undefined;
    return;
  }

  if (due) {
    statusBar.text = '$(alert) Go outside';
    statusBar.tooltip = 'A break is owed. Click for the capture link.';
    statusBar.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    return;
  }

  const mins = Math.ceil((remainingMs ?? 0) / 60000);
  statusBar.text = `$(organization) ${mins}m`;
  statusBar.tooltip =
    `${mins} minutes of desk time left before a break.\n` +
    (clients?.length ? `Shared with: ${clients.join(', ')}` : 'Shared budget with the browser extension.');
  statusBar.backgroundColor = undefined;
}

// ── lifecycle ──────────────────────────────────────────────────────────────

function activate(context) {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'breaktension.status';
  statusBar.show();
  context.subscriptions.push(statusBar);

  render({ offline: true });

  context.subscriptions.push(
    vscode.commands.registerCommand('breaktension.status', async () => {
      const state = await request('/state');
      if (!state) {
        const pick = await vscode.window.showWarningMessage(
          'The BreakTension verifier is not running.',
          'How do I start it?'
        );
        if (pick) {
          vscode.window.showInformationMessage(
            'In the project directory run: npm run server — it runs Gemma locally through Ollama.'
          );
        }
        return;
      }

      if (state.state !== 'idle' && state.origin) {
        await promptBreak(state.task?.text, `${state.origin}/capture`);
        return;
      }

      const mins = Math.ceil((state.remainingMs ?? 0) / 60000);
      vscode.window.showInformationMessage(
        `BreakTension: ${mins} min of desk time left. Sharing the budget with: ${
          state.clients?.join(', ') || 'this editor only'
        }.`
      );
    }),

    vscode.commands.registerCommand('breaktension.breakNow', async () => {
      const res = await request('/due', { method: 'POST' });
      if (!res) {
        vscode.window.showWarningMessage('The verifier is not running. Start it with: npm run server');
        return;
      }
      lastPromptAt = 0;
      await promptBreak(res.task?.text, res.captureUrl);
    }),

    vscode.commands.registerCommand('breaktension.pause', () => {
      paused = !paused;
      render({ paused });
      vscode.window.setStatusBarMessage(
        paused ? 'BreakTension paused' : 'BreakTension counting again',
        3000
      );
    })
  );

  tickTimer = setInterval(tick, TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(tickTimer) });

  // While a break is owed, keep asking.
  remindTimer = setInterval(() => {
    if (locked && userIsHere() && !paused) tick();
  }, 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(remindTimer) });

  tick();
}

function deactivate() {
  clearInterval(tickTimer);
  clearInterval(remindTimer);
}

module.exports = { activate, deactivate };
