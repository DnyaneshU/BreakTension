const $ = (id) => document.getElementById(id);

async function load() {
  const s = await chrome.runtime.sendMessage({ type: 'bt-status' });
  const c = s.settings ?? {};
  $('work').value = Math.round((c.workMs ?? 35 * 60000) / 60000);
  $('qs').value = c.quietStartHour ?? 22;
  $('qe').value = c.quietEndHour ?? 7;
  $('wd').checked = Boolean(c.workDaysOnly);
}

$('save').onclick = async () => {
  await chrome.runtime.sendMessage({
    type: 'bt-save-settings',
    settings: {
      workMs: Math.max(5, Number($('work').value) || 35) * 60000,
      quietStartHour: Number($('qs').value) || 0,
      quietEndHour: Number($('qe').value) || 0,
      workDaysOnly: $('wd').checked,
    },
  });
  $('saved').classList.add('on');
  setTimeout(() => $('saved').classList.remove('on'), 1400);
};

load();
