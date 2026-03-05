// trackingMap: tabId -> { domain, startTime }
const trackingMap = new Map();

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function matchesDomain(urlDomain, configDomain) {
  const a = urlDomain.replace(/^www\./, '').toLowerCase();
  const b = configDomain.replace(/^www\./, '').toLowerCase();
  return a === b || a.endsWith('.' + b);
}

// Returns true if the URL matches the site's domain (and optional path prefix)
function matchesUrl(url, site) {
  const urlDomain = getDomain(url);
  if (!urlDomain || !matchesDomain(urlDomain, site.domain)) return false;
  if (site.pathPrefix) {
    try {
      return new URL(url).pathname.startsWith(site.pathPrefix);
    } catch {
      return false;
    }
  }
  return true;
}

// Returns true if the current time falls inside the block window
function isInBlockWindow(site) {
  if (!site.schedule) return true; // no schedule = always active
  const { startHour, endHour } = site.schedule;
  const h = new Date().getHours();
  if (startHour <= endHour) {
    return h >= startHour && h < endHour;
  } else {
    // wraps around midnight (e.g. 22 -> 08)
    return h >= startHour || h < endHour;
  }
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

async function getSites() {
  const { sites = [] } = await chrome.storage.sync.get('sites');
  return sites;
}

async function getStoredUsageToday(domain) {
  const { usage = {} } = await chrome.storage.local.get('usage');
  return usage[domain]?.[getToday()] || 0;
}

async function getCurrentUsageSeconds(domain) {
  const stored = await getStoredUsageToday(domain);
  let inProgress = 0;
  const now = Date.now();
  for (const entry of trackingMap.values()) {
    if (entry.domain === domain) {
      inProgress += Math.floor((now - entry.startTime) / 1000);
    }
  }
  return stored + inProgress;
}

async function saveUsage(domain, seconds) {
  const { usage = {} } = await chrome.storage.local.get('usage');
  const today = getToday();
  if (!usage[domain]) usage[domain] = {};
  usage[domain][today] = (usage[domain][today] || 0) + seconds;
  await chrome.storage.local.set({ usage });
}

async function stopTracking(tabId) {
  const entry = trackingMap.get(tabId);
  if (!entry) return;
  trackingMap.delete(tabId);
  const elapsed = Math.floor((Date.now() - entry.startTime) / 1000);
  if (elapsed > 0) {
    await saveUsage(entry.domain, elapsed);
  }
}

function startTracking(tabId, domain) {
  trackingMap.set(tabId, { domain, startTime: Date.now() });
}

async function isTemporarilyAllowed(domain) {
  try {
    const { allowed = {} } = await chrome.storage.session.get('allowed');
    const ts = allowed[domain];
    if (!ts) return false;
    return Date.now() - ts < 30 * 60 * 1000;
  } catch {
    return false;
  }
}

async function setTemporarilyAllowed(domain) {
  try {
    const { allowed = {} } = await chrome.storage.session.get('allowed');
    allowed[domain] = Date.now();
    await chrome.storage.session.set({ allowed });
  } catch (e) {
    console.error('Error setting temporary allow:', e);
  }
}

function blockedUrl(site, originalUrl, reason) {
  let url = chrome.runtime.getURL('pages/blocked.html') +
    '?domain=' + encodeURIComponent(site.domain) +
    '&return=' + encodeURIComponent(originalUrl);
  if (reason) url += '&reason=' + reason;
  if (reason === 'time_limit') {
    // caller adds used/limit params separately
  }
  if (site.schedule) {
    url += '&scheduleStart=' + site.schedule.startHour +
           '&scheduleEnd=' + site.schedule.endHour;
  }
  return url;
}

async function handleUrl(tabId, url) {
  const sites = await getSites();
  const site = sites.find(s => matchesUrl(url, s));
  if (!site) return;

  // If outside the block window, allow through
  if (!isInBlockWindow(site)) return;

  if (site.mode === 'blocked') {
    chrome.tabs.update(tabId, {
      url: blockedUrl(site, url, 'blocked')
    });
    return;
  }

  if (site.mode === 'time_limit') {
    const limitSeconds = (site.dailyLimitMinutes || 30) * 60;
    const usedSeconds = await getCurrentUsageSeconds(site.domain);

    if (usedSeconds >= limitSeconds) {
      chrome.tabs.update(tabId, {
        url: blockedUrl(site, url, 'time_limit') +
          '&used=' + usedSeconds +
          '&limit=' + limitSeconds
      });
      return;
    }

    startTracking(tabId, site.domain);
    return;
  }

  if (site.mode === 'confirm') {
    if (await isTemporarilyAllowed(site.domain)) return;

    chrome.tabs.update(tabId, {
      url: chrome.runtime.getURL('pages/confirm.html') +
        '?domain=' + encodeURIComponent(site.domain) +
        '&return=' + encodeURIComponent(url)
    });
  }
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' || !changeInfo.url) return;

  if (trackingMap.has(tabId)) {
    await stopTracking(tabId);
  }

  if (!changeInfo.url.startsWith('http')) return;
  await handleUrl(tabId, changeInfo.url);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  stopTracking(tabId);
});

// Alarm to enforce time limits on already-open tabs
chrome.alarms.create('check_limits', { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'check_limits') return;

  const sites = await getSites();
  const timeLimitSites = sites.filter(s => s.mode === 'time_limit');

  for (const [tabId, entry] of [...trackingMap.entries()]) {
    const site = timeLimitSites.find(s => matchesDomain(entry.domain, s.domain));
    if (!site) continue;

    // If schedule ended, stop tracking but don't block
    if (!isInBlockWindow(site)) {
      await stopTracking(tabId);
      continue;
    }

    const limitSeconds = (site.dailyLimitMinutes || 30) * 60;
    const usedSeconds = await getCurrentUsageSeconds(site.domain);

    if (usedSeconds >= limitSeconds) {
      await stopTracking(tabId);
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) return;
        chrome.tabs.update(tabId, {
          url: blockedUrl(site, tab.url || '', 'time_limit') +
            '&used=' + usedSeconds +
            '&limit=' + limitSeconds
        });
      });
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'confirm_allow') {
    setTemporarilyAllowed(message.domain).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === 'get_usage') {
    getCurrentUsageSeconds(message.domain).then(seconds => sendResponse({ seconds }));
    return true;
  }
  if (message.type === 'get_weekly_stats') {
    chrome.storage.local.get('usage').then(({ usage = {} }) => sendResponse({ usage }));
    return true;
  }
  if (message.type === 'verify_pin') {
    chrome.storage.sync.get('masterPin').then(({ masterPin }) => {
      sendResponse({ ok: masterPin && masterPin === message.pin });
    });
    return true;
  }
});
