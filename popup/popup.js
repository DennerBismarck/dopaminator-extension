function formatTime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}min` : `${hours}h`;
}

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

    item.innerHTML = `
      <span class="site-domain">${site.domain}</span>
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

function normalizeDomain(input) {
  return input.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

async function addSite() {
  const domain = normalizeDomain(document.getElementById('domain-input').value);

  if (!domain || !domain.includes('.')) {
    showError('Digite um dominio valido. Ex: instagram.com');
    return;
  }

  const mode = document.getElementById('mode-select').value;
  const dailyLimitMinutes = parseInt(document.getElementById('limit-input').value) || 30;

  const sites = await getSites();

  if (sites.some(s => s.domain === domain)) {
    showError('Este site ja esta na lista.');
    return;
  }

  sites.push({
    id: crypto.randomUUID(),
    domain,
    mode,
    dailyLimitMinutes: mode === 'time_limit' ? dailyLimitMinutes : undefined,
  });

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

document.getElementById('mode-select').addEventListener('change', (e) => {
  document.getElementById('time-limit-row').classList.toggle('hidden', e.target.value !== 'time_limit');
});

document.getElementById('add-btn').addEventListener('click', addSite);

document.getElementById('domain-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addSite();
});

renderSites();
