// ── Utilities ──────────────────────────────────────────────────────

function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}min` : `${hours}h`;
}

function normalizeDomain(input) {
  return input.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '');
}

// ── Storage helpers ─────────────────────────────────────────────────

async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get('sites');
  return sites;
}

async function saveSites(sites) {
  await chrome.storage.sync.set({ sites });
}

async function getUsageForSite(domain) {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'get_usage', domain });
    return response?.seconds || 0;
  } catch {
    const { usage = {} } = await chrome.storage.local.get('usage');
    const today = new Date().toISOString().split('T')[0];
    return usage[domain]?.[today] || 0;
  }
}

// ── Sites tab ───────────────────────────────────────────────────────

const modeLabels = {
  blocked: 'Bloqueado',
  time_limit: 'Tempo',
  confirm: 'Confirmacao',
};

async function renderSites() {
  const sites = await getSites();
  const list = document.getElementById('sites-list');

  if (sites.length === 0) {
    list.innerHTML = '<div class="empty-state">Nenhum site configurado ainda.<br>Adicione um site abaixo para comecar.</div>';
    return;
  }

  list.innerHTML = '';

  for (const site of sites) {
    const item = document.createElement('div');
    item.className = 'site-item';

    let usageHtml = '';
    if (site.mode === 'time_limit') {
      const usedSeconds = await getUsageForSite(site.domain);
      const limitSeconds = (site.dailyLimitMinutes || 30) * 60;
      usageHtml = `<span class="site-usage">${formatTime(usedSeconds)}/${formatTime(limitSeconds)}</span>`;
    }

    let metaParts = [];
    if (site.pathPrefix) metaParts.push('caminho: ' + site.pathPrefix);
    if (site.schedule) metaParts.push(`${site.schedule.startHour}h-${site.schedule.endHour}h`);
    const metaHtml = metaParts.length
      ? `<div class="site-meta">${metaParts.join(' · ')}</div>`
      : '';

    item.innerHTML = `
      <div class="site-info">
        <div class="site-domain">${site.domain}</div>
        ${metaHtml}
      </div>
      ${usageHtml}
      <span class="mode-badge badge-${site.mode}">${modeLabels[site.mode]}</span>
      <button class="delete-btn" data-id="${site.id}" title="Remover">x</button>
    `;

    list.appendChild(item);
  }

  list.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const sites = await getSites();
      await saveSites(sites.filter(s => s.id !== btn.dataset.id));
      renderSites();
    });
  });
}

async function addSite() {
  const rawInput = normalizeDomain(document.getElementById('domain-input').value);

  // Separate domain from optional path (e.g. "youtube.com/shorts" -> domain + pathPrefix)
  const slashIdx = rawInput.indexOf('/');
  const domain = slashIdx >= 0 ? rawInput.slice(0, slashIdx) : rawInput;
  const pathPrefix = slashIdx >= 0 ? rawInput.slice(slashIdx) : '';

  if (!domain || !domain.includes('.')) {
    showError('Digite um dominio valido. Ex: instagram.com');
    return;
  }

  const mode = document.getElementById('mode-select').value;
  const dailyLimitMinutes = parseInt(document.getElementById('limit-input').value) || 30;

  const useSchedule = document.getElementById('schedule-check').checked;
  const scheduleStart = parseInt(document.getElementById('schedule-start').value);
  const scheduleEnd = parseInt(document.getElementById('schedule-end').value);

  const sites = await getSites();

  const duplicate = sites.find(s =>
    s.domain === domain && (s.pathPrefix || '') === pathPrefix
  );
  if (duplicate) {
    showError('Este site ja esta na lista.');
    return;
  }

  const newSite = {
    id: crypto.randomUUID(),
    domain,
    mode,
    dailyLimitMinutes: mode === 'time_limit' ? dailyLimitMinutes : undefined,
    pathPrefix: pathPrefix || undefined,
    schedule: useSchedule ? { startHour: scheduleStart, endHour: scheduleEnd } : undefined,
  };

  sites.push(newSite);
  await saveSites(sites);
  document.getElementById('domain-input').value = '';
  clearError();
  renderSites();
}

function showError(msg) {
  let el = document.querySelector('.error-msg');
  if (!el) {
    el = document.createElement('div');
    el.className = 'error-msg';
    document.getElementById('add-btn').before(el);
  }
  el.textContent = msg;
}

function clearError() {
  document.querySelector('.error-msg')?.remove();
}

// ── Stats tab ───────────────────────────────────────────────────────

function getLast7Days() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(d.toISOString().split('T')[0]);
  }
  return days;
}

const DAY_LABELS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab'];

async function renderStats() {
  const container = document.getElementById('stats-content');
  const sites = await getSites();

  if (sites.length === 0) {
    container.innerHTML = '<div class="stats-empty">Nenhum site configurado ainda.</div>';
    return;
  }

  let response;
  try {
    response = await chrome.runtime.sendMessage({ type: 'get_weekly_stats' });
  } catch {
    const { usage = {} } = await chrome.storage.local.get('usage');
    response = { usage };
  }

  const usage = response?.usage || {};
  const days = getLast7Days();

  container.innerHTML = '';

  for (const site of sites) {
    const domainUsage = usage[site.domain] || {};
    const values = days.map(d => domainUsage[d] || 0);
    const maxVal = Math.max(...values, 1);
    const totalSeconds = values.reduce((a, b) => a + b, 0);

    const div = document.createElement('div');
    div.className = 'stats-site';

    const barsHtml = days.map((d, i) => {
      const val = values[i];
      const pct = Math.round((val / maxVal) * 100);
      const dayOfWeek = new Date(d + 'T12:00:00').getDay();
      const label = DAY_LABELS[dayOfWeek];
      return `
        <div class="stats-day">
          <div class="stats-bar ${val === 0 ? 'empty' : ''}" style="height:${Math.max(pct * 0.4, val > 0 ? 4 : 2)}px"></div>
          <div class="stats-day-label">${label}</div>
        </div>
      `;
    }).join('');

    div.innerHTML = `
      <div class="stats-domain">${site.domain}</div>
      <div class="stats-days">${barsHtml}</div>
      <div class="stats-total">Total esta semana: ${formatTime(totalSeconds)}</div>
    `;

    container.appendChild(div);
  }
}

// ── Config tab ──────────────────────────────────────────────────────

async function renderConfig() {
  const { masterPin } = await chrome.storage.sync.get('masterPin');
  const status = document.getElementById('pin-status');
  status.textContent = masterPin ? 'PIN configurado.' : '';
}

async function savePin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (!pin) return;
  await chrome.storage.sync.set({ masterPin: pin });
  document.getElementById('pin-input').value = '';
  const status = document.getElementById('pin-status');
  status.textContent = 'PIN salvo!';
  setTimeout(() => { status.textContent = 'PIN configurado.'; }, 2000);
}

async function clearPin() {
  await chrome.storage.sync.remove('masterPin');
  document.getElementById('pin-status').textContent = 'PIN removido.';
  setTimeout(() => { document.getElementById('pin-status').textContent = ''; }, 2000);
}

// ── Tab switching ───────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.add('hidden'));

    btn.classList.add('active');
    const tabEl = document.getElementById('tab-' + btn.dataset.tab);
    tabEl.classList.remove('hidden');

    if (btn.dataset.tab === 'stats') renderStats();
    if (btn.dataset.tab === 'config') renderConfig();
  });
});

// ── Event listeners ─────────────────────────────────────────────────

document.getElementById('mode-select').addEventListener('change', (e) => {
  document.getElementById('time-limit-row').classList.toggle('hidden', e.target.value !== 'time_limit');
});

document.getElementById('schedule-check').addEventListener('change', (e) => {
  document.getElementById('schedule-row').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('add-btn').addEventListener('click', addSite);

document.getElementById('domain-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSite();
});

document.getElementById('pin-save-btn').addEventListener('click', savePin);
document.getElementById('pin-clear-btn').addEventListener('click', clearPin);

// ── Init ─────────────────────────────────────────────────────────────

renderSites();
