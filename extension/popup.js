const $ = (id) => document.getElementById(id);

function render(s) {
  const mins = Math.ceil((s.remainingMs ?? 0) / 60000);
  $('left').innerHTML = `${mins}<span> min left</span>`;

  const total = (s.settings?.workMs ?? 35 * 60000);
  const pct = Math.min(100, 100 * (1 - (s.remainingMs ?? 0) / total));
  $('fill').style.width = `${pct}%`;

  $('srv').textContent = s.serverUp ? 'running' : 'not running';
  $('srvdot').className = `dot ${s.serverUp ? 'up' : 'down'}`;
  $('state').textContent = s.locked ? 'locked' : s.enabled ? 'counting' : 'paused';
  $('toggle').textContent = s.enabled ? 'Pause' : 'Resume';
  $('force').disabled = !s.serverUp;
}

async function refresh() {
  try { render(await chrome.runtime.sendMessage({ type: 'bt-status' })); } catch {}
}

$('force').onclick = async () => {
  await chrome.runtime.sendMessage({ type: 'bt-force-break' });
  window.close();
};

$('toggle').onclick = async () => {
  const s = await chrome.runtime.sendMessage({ type: 'bt-status' });
  await chrome.runtime.sendMessage({ type: 'bt-set-enabled', value: !s.enabled });
  refresh();
};

$('opts').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

refresh();
setInterval(refresh, 2000);
