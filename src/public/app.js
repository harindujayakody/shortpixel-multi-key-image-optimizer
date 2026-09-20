// State
let currentFilter = 'ALL';
let queueData = [];
let keysData = [];
let proxiesData = [];
let statsData = {};
let eventSource = null;

// DOM references
const keysListContainer = document.getElementById('keys-list-container');
const proxiesListContainer = document.getElementById('proxies-list-container');
const queueTableBody = document.getElementById('queue-table-body');
const activityLogEl = document.getElementById('activity-log');
const toastContainer = document.getElementById('toast-container');

// Progress & Status
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const progressPercent = document.getElementById('progress-percent');
const queueStatusPill = document.getElementById('queue-status-pill');

// Metrics
const metricSavedBytes = document.getElementById('metric-saved-bytes');
const metricRatio = document.getElementById('metric-ratio');
const metricOriginalTotal = document.getElementById('metric-original-total');
const metricRemainingQuota = document.getElementById('metric-remaining-quota');
const metricTotalQuota = document.getElementById('metric-total-quota');
const metricProcessedCount = document.getElementById('metric-processed-count');
const metricQueueStatus = document.getElementById('metric-queue-status');
const metricFailedCount = document.getElementById('metric-failed-count');
const metricActiveKeys = document.getElementById('metric-active-keys');
const metricProxyStatus = document.getElementById('metric-proxy-status');
const metricStrategyBadge = document.getElementById('metric-strategy-badge');
const quotaProgressBar = document.getElementById('quota-progress-bar');

const activeKeysBadgeCount = document.getElementById('active-keys-badge-count');
const aggregateQuotaBadge = document.getElementById('aggregate-quota-badge');
const countTabKeys = document.getElementById('count-tab-keys');
const countTabProxies = document.getElementById('count-tab-proxies');
const labelActiveOutputMode = document.getElementById('label-active-output-mode');

// Buttons & Actions
const btnStartQueue = document.getElementById('btn-start-queue');
const btnPauseQueue = document.getElementById('btn-pause-queue');
const btnResumeQueue = document.getElementById('btn-resume-queue');
const btnStopQueue = document.getElementById('btn-stop-queue');
const btnRetryFailed = document.getElementById('btn-retry-failed');
const btnClearQueue = document.getElementById('btn-clear-queue');

const btnThemeToggle = document.getElementById('btn-theme-toggle');
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsModal = document.getElementById('settings-modal');

const btnToggleAddKey = document.getElementById('btn-toggle-add-key');
const btnCancelAddKey = document.getElementById('btn-cancel-add-key');
const btnSaveNewKeys = document.getElementById('btn-save-new-keys');
const btnRefreshKeys = document.getElementById('btn-refresh-keys');
const boxAddKey = document.getElementById('box-add-key');
const inputNewKeys = document.getElementById('input-new-keys');

const btnToggleAddProxy = document.getElementById('btn-toggle-add-proxy');
const btnCancelAddProxy = document.getElementById('btn-cancel-add-proxy');
const btnSaveNewProxies = document.getElementById('btn-save-new-proxies');
const btnTestAllProxies = document.getElementById('btn-test-all-proxies');
const boxAddProxy = document.getElementById('box-add-proxy');
const inputNewProxies = document.getElementById('input-new-proxies');
const settingUseProxy = document.getElementById('setting-use-proxy');

const btnToggleFetchRemote = document.getElementById('btn-toggle-fetch-remote');
const btnCancelFetchRemote = document.getElementById('btn-cancel-fetch-remote');
const btnSubmitFetchRemote = document.getElementById('btn-submit-fetch-remote');
const boxFetchRemote = document.getElementById('box-fetch-remote');
const fetchRemoteProtocol = document.getElementById('fetch-remote-protocol');
const fetchRemoteLatency = document.getElementById('fetch-remote-latency');
const fetchRemoteLimit = document.getElementById('fetch-remote-limit');

const btnPickFiles = document.getElementById('btn-pick-files');
const btnPickFolder = document.getElementById('btn-pick-folder');
const fileUpload = document.getElementById('file-upload');
const folderUpload = document.getElementById('folder-upload');
const dropzone = document.getElementById('dropzone');

const btnScanFolder = document.getElementById('btn-scan-folder');
const inputFolderPath = document.getElementById('input-folder-path');
const scanRecursive = document.getElementById('scan-recursive');

// Initialize application
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initSSE();
  fetchInitialData();
  setupEventListeners();
  refreshIcons();
});

function refreshIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Theme Management (Light vs Pure Black Dark Mode)
function initTheme() {
  const savedTheme = localStorage.getItem('shortpixel_theme') || 'dark';
  if (savedTheme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }

  btnThemeToggle.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('shortpixel_theme', isDark ? 'dark' : 'light');
    refreshIcons();
  });
}

// Tab Switching
window.switchSidebarTab = function(tab) {
  const tabKeys = document.getElementById('tab-content-keys');
  const tabProxies = document.getElementById('tab-content-proxies');
  const btnKeys = document.getElementById('tab-btn-keys');
  const btnProxies = document.getElementById('tab-btn-proxies');

  if (tab === 'keys') {
    tabKeys.classList.remove('hidden');
    tabProxies.classList.add('hidden');
    btnKeys.classList.add('active');
    btnProxies.classList.remove('active');
  } else {
    tabKeys.classList.add('hidden');
    tabProxies.classList.remove('hidden');
    btnProxies.classList.add('active');
    btnKeys.classList.remove('active');
  }
  refreshIcons();
};

// SSE Live Event Hub
function initSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('init', e => {
    try {
      const data = JSON.parse(e.data);
      updateStats(data.stats);
      updateKeysList(data.keys);
      updateProxiesList(data.proxies);
      loadSettingsIntoModal(data.settings);
    } catch {}
  });

  eventSource.addEventListener('keysUpdated', e => {
    try {
      const data = JSON.parse(e.data);
      updateKeysList(data.keys);
      if (data.stats) updateStats(data.stats);
    } catch {}
  });

  eventSource.addEventListener('proxiesUpdated', e => {
    try {
      const data = JSON.parse(e.data);
      updateProxiesList(data.proxies);
    } catch {}
  });

  eventSource.addEventListener('keyRotated', e => {
    try {
      const data = JSON.parse(e.data);
      logActivity(`[Load-Balancer] Key rotated: ${data.previousKey || data.oldKey} -> ${data.nextKey || data.newKey || 'None'} (${data.reason || 'Rotation'})`, 'warn');
      showToast(`Key rotated: ${data.nextKey || data.newKey || 'None'} active`, 'warn');
      fetchKeys();
    } catch {}
  });

  eventSource.addEventListener('allKeysExhausted', () => {
    logActivity('[Alert] All API keys in the pool have been exhausted!', 'error');
    showToast('All API keys are exhausted! Add new keys to continue.', 'error');
    setRunningState(false, true);
  });

  eventSource.addEventListener('itemStarted', e => {
    try {
      const data = JSON.parse(e.data);
      logActivity(`Optimizing: ${data.item.fileName}...`);
      fetchQueue();
    } catch {}
  });

  eventSource.addEventListener('itemCompleted', e => {
    try {
      const data = JSON.parse(e.data);
      const item = data.item;
      logActivity(`Done: ${item.fileName} (${formatBytes(item.savedBytes)} saved, -${item.percentImprovement}%) [Key: ${item.keyUsed}]`);
      fetchQueue();
      fetchStats();
    } catch {}
  });

  eventSource.addEventListener('itemFailed', e => {
    try {
      const data = JSON.parse(e.data);
      logActivity(`Failed: ${data.item.fileName} - ${data.error}`, 'error');
      fetchQueue();
      fetchStats();
    } catch {}
  });

  eventSource.addEventListener('queueStarted', () => {
    logActivity('Queue processing started');
    setRunningState(true, false);
  });

  eventSource.addEventListener('queuePaused', () => {
    logActivity('Queue paused');
    setRunningState(false, true);
  });

  eventSource.addEventListener('queueResumed', () => {
    logActivity('Queue resumed');
    setRunningState(true, false);
  });

  eventSource.addEventListener('queueCompleted', () => {
    logActivity('Batch optimization completed! All files saved.');
    setRunningState(false, false);
    showToast('Optimization finished! All images processed.', 'success');

    const autoDownload = document.getElementById('setting-auto-download-modal');
    if (!autoDownload || autoDownload.checked) {
      logActivity('Downloading optimized ZIP archive...');
      setTimeout(() => {
        window.location.href = '/api/download-zip';
      }, 800);
    }
  });

  eventSource.addEventListener('queueUpdated', () => {
    fetchQueue();
    fetchStats();
  });

  eventSource.onerror = () => {
    setTimeout(initSSE, 3000);
  };
}

// Data Fetching
async function fetchInitialData() {
  await Promise.all([fetchKeys(), fetchProxies(), fetchQueue(), fetchStats(), fetchSettings()]);
}

async function fetchKeys() {
  try {
    const res = await fetch('/api/keys');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      keysData = data.keys;
      updateKeysList(data.keys);
      if (data.stats) updateStats(data.stats);
    }
  } catch (err) {
    console.error('Error fetching keys:', err);
  }
}

async function fetchProxies() {
  try {
    const res = await fetch('/api/proxies');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      proxiesData = data.proxies;
      updateProxiesList(data.proxies);
    }
  } catch (err) {
    console.error('Error fetching proxies:', err);
  }
}

async function fetchQueue() {
  try {
    const res = await fetch('/api/queue');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      queueData = data.queue;
      renderQueueTable();
      updateStats(data.stats);
    }
  } catch (err) {
    console.error('Error fetching queue:', err);
  }
}

async function fetchStats() {
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      statsData = data.stats;
      updateStats(data.stats);
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

async function fetchSettings() {
  try {
    const res = await fetch('/api/settings');
    if (!res.ok) return;
    const data = await res.json();
    if (data.success) {
      loadSettingsIntoModal(data.settings);
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  }
}

// Render Keys List
function updateKeysList(keys) {
  if (!keysListContainer) return;
  keysData = keys || [];
  countTabKeys.textContent = keysData.length;

  if (keysData.length === 0) {
    keysListContainer.innerHTML = `
      <div class="text-xs text-zinc-400 text-center py-6">
        No API keys loaded. Click "+ Add" to add your keys.
      </div>
    `;
    return;
  }

  keysListContainer.innerHTML = keysData.map(k => {
    let statusClass = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
    let statusLabel = 'Ready';

    if (k.status === 'ACTIVE') {
      statusClass = 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20';
      statusLabel = 'Active';
    } else if (k.status === 'EXHAUSTED') {
      statusClass = 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border border-rose-500/20';
      statusLabel = 'Exhausted';
    } else if (k.status === 'INVALID') {
      statusClass = 'bg-rose-500/10 text-rose-600 dark:text-rose-400';
      statusLabel = 'Invalid';
    }

    const creditsStr = k.creditsRemaining !== null ? `${k.creditsRemaining} left` : 'Unchecked';

    return `
      <div class="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-850 bg-zinc-50/50 dark:bg-black hover:border-zinc-300 dark:hover:border-zinc-700 transition flex items-center justify-between">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-semibold text-zinc-900 dark:text-zinc-100">${maskKey(k.key)}</span>
            <span class="px-1.5 py-0.2 rounded text-[10px] font-mono font-medium ${statusClass}">${statusLabel}</span>
          </div>
          <div class="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-2.5 font-mono">
            <span>Quota: <strong class="text-zinc-800 dark:text-zinc-200">${creditsStr}</strong></span>
            <span>•</span>
            <span>${k.lifetimeImages || 0} optimized</span>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="refreshSingleKey('${k.key}')" class="h-6 w-6 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white text-xs" title="Refresh Balance">
            <i data-lucide="rotate-cw" class="w-3 h-3"></i>
          </button>
          <button onclick="deleteKey('${k.key}')" class="h-6 w-6 rounded hover:bg-rose-500/10 flex items-center justify-center text-zinc-400 hover:text-rose-500 text-xs" title="Remove Key">
            <i data-lucide="trash-2" class="w-3 h-3"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  refreshIcons();
}

// Render Proxies List
function updateProxiesList(proxies) {
  if (!proxiesListContainer) return;
  proxiesData = proxies || [];
  countTabProxies.textContent = proxiesData.length;

  if (proxiesData.length === 0) {
    proxiesListContainer.innerHTML = `
      <div class="text-xs text-zinc-400 text-center py-6">
        No proxies in pool. Click "+ Add" to add HTTP/SOCKS proxies.
      </div>
    `;
    return;
  }

  proxiesListContainer.innerHTML = proxiesData.map(p => {
    let statusClass = 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400';
    if (p.status === 'ACTIVE') statusClass = 'bg-emerald-500/10 text-emerald-500 border border-emerald-500/20';
    if (p.status === 'OFFLINE') statusClass = 'bg-rose-500/10 text-rose-500 border border-rose-500/20';

    const latencyDisplay = p.latency ? `${p.latency}ms` : (p.status === 'OFFLINE' ? 'Failed' : 'Untested');

    return `
      <div class="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-850 bg-zinc-50/50 dark:bg-black hover:border-zinc-300 dark:hover:border-zinc-700 transition flex items-center justify-between">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs text-zinc-800 dark:text-zinc-200 truncate max-w-[160px]" title="${p.url}">${maskProxyUrl(p.url)}</span>
            <span class="px-1.5 py-0.2 rounded text-[10px] font-mono uppercase ${statusClass}">${p.protocol}</span>
          </div>
          <div class="text-[11px] text-zinc-400 font-mono flex items-center gap-2">
            <span>Ping: <strong class="${p.latency ? 'text-emerald-400' : 'text-zinc-400'}">${latencyDisplay}</strong></span>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="testSingleProxy('${p.id}')" class="h-6 w-6 rounded hover:bg-zinc-200 dark:hover:bg-zinc-800 flex items-center justify-center text-zinc-500 hover:text-zinc-900 dark:hover:text-white text-xs" title="Test Connection">
            <i data-lucide="activity" class="w-3 h-3"></i>
          </button>
          <button onclick="deleteProxy('${p.id}')" class="h-6 w-6 rounded hover:bg-rose-500/10 flex items-center justify-center text-zinc-400 hover:text-rose-500 text-xs" title="Delete Proxy">
            <i data-lucide="trash-2" class="w-3 h-3"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');

  refreshIcons();
}

// Render Rich Image Details Queue Table
function renderQueueTable() {
  if (!queueTableBody) return;

  const filtered = queueData.filter(item => {
    if (currentFilter === 'ALL') return true;
    return item.status === currentFilter;
  });

  const queueBadge = document.getElementById('queue-badge');
  if (queueBadge) queueBadge.textContent = queueData.length;

  if (filtered.length === 0) {
    queueTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="px-4 py-12 text-center text-zinc-400">
          <div class="flex flex-col items-center justify-center gap-2">
            <i data-lucide="images" class="w-8 h-8 text-zinc-300 dark:text-zinc-700"></i>
            <span>${queueData.length === 0 ? 'No images in queue. Drop files or choose a folder above.' : `No items with status "${currentFilter}".`}</span>
          </div>
        </td>
      </tr>
    `;
    refreshIcons();
    return;
  }

  queueTableBody.innerHTML = filtered.map(item => {
    let statusBadge = '';
    if (item.status === 'COMPLETED') {
      statusBadge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"><i data-lucide="check" class="w-3 h-3"></i> Done</span>';
    } else if (item.status === 'PROCESSING') {
      statusBadge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-indigo-500/10 text-indigo-500 border border-indigo-500/20 animate-pulse"><i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Converting</span>';
    } else if (item.status === 'SKIPPED') {
      statusBadge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-amber-500/10 text-amber-500 border border-amber-500/20"><i data-lucide="skip-forward" class="w-3 h-3"></i> Skipped</span>';
    } else if (item.status === 'FAILED') {
      statusBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono font-semibold bg-rose-500/10 text-rose-500 border border-rose-500/20" title="${item.error || 'Error'}"><i data-lucide="alert-circle" class="w-3 h-3"></i> Failed</span>`;
    } else {
      statusBadge = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono bg-zinc-100 dark:bg-zinc-800 text-zinc-500">Pending</span>';
    }

    const savingsHtml = item.percentImprovement
      ? `<div class="font-mono"><span class="text-emerald-600 dark:text-emerald-400 font-semibold">-${item.percentImprovement}%</span> <div class="text-[10px] text-zinc-400">(-${formatBytes(item.savedBytes)})</div></div>`
      : '<span class="text-zinc-400 font-mono">-</span>';

    const optimizedSizeHtml = item.compressedSize
      ? `<span class="font-mono text-zinc-800 dark:text-zinc-200 font-medium">${formatBytes(item.compressedSize)}</span>`
      : '<span class="text-zinc-400 font-mono">-</span>';

    const dimensionHtml = item.width && item.height
      ? `<span class="text-[10px] text-zinc-400 font-mono bg-zinc-100 dark:bg-zinc-900 px-1 py-0.5 rounded">${item.width}×${item.height}</span>`
      : '';

    const mimeShort = item.mimeType ? item.mimeType.replace('image/', '').toUpperCase() : '';

    return `
      <tr class="hover:bg-zinc-100/50 dark:hover:bg-zinc-900/40 transition cursor-pointer" onclick="inspectItem('${item.id}')">
        <td class="px-4 py-3">
          <div class="flex items-center gap-3">
            <div class="h-10 w-10 rounded-lg bg-zinc-100 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 flex items-center justify-center overflow-hidden flex-shrink-0">
              <img src="/api/preview/${item.id}" alt="" class="h-full w-full object-cover" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';">
              <i data-lucide="image" class="w-4 h-4 text-zinc-400 hidden"></i>
            </div>
            <div class="space-y-0.5 min-w-0">
              <div class="font-medium text-zinc-900 dark:text-zinc-100 truncate max-w-[200px]" title="${item.fullPath}">${item.fileName}</div>
              <div class="flex items-center gap-1.5">
                <span class="text-[10px] font-mono uppercase px-1 py-0.2 rounded bg-zinc-200/60 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400">${mimeShort}</span>
                ${dimensionHtml}
              </div>
            </div>
          </div>
        </td>
        <td class="px-3 py-3 font-mono text-zinc-500">${formatBytes(item.originalSize || item.size)}</td>
        <td class="px-3 py-3 font-mono">${optimizedSizeHtml}</td>
        <td class="px-3 py-3">${savingsHtml}</td>
        <td class="px-3 py-3 font-mono text-zinc-500 text-[11px]">
          <div>${item.keyUsed || '-'}</div>
          ${item.proxyUsed ? `<div class="text-[10px] text-zinc-400 truncate max-w-[90px]">${item.proxyUsed}</div>` : ''}
        </td>
        <td class="px-4 py-3 text-right">${statusBadge}</td>
      </tr>
    `;
  }).join('');

  refreshIcons();
}

// Update Top Metrics & Live Gauges
function updateStats(stats) {
  if (!stats) return;

  metricSavedBytes.textContent = formatBytes(stats.totalSavedBytes || 0);
  metricRatio.textContent = `-${stats.overallRatio || 0}%`;
  metricOriginalTotal.textContent = `From ${formatBytes(stats.totalOriginalBytes || 0)} original data`;

  metricRemainingQuota.textContent = (stats.totalRemainingQuota || 0).toLocaleString();
  metricTotalQuota.textContent = (stats.totalQuota || 0).toLocaleString();

  const quotaPercent = stats.totalQuota > 0 ? Math.round((stats.totalRemainingQuota / stats.totalQuota) * 100) : 0;
  quotaProgressBar.style.width = `${quotaPercent}%`;

  metricProcessedCount.textContent = (stats.totalProcessed || 0).toLocaleString();
  metricQueueStatus.textContent = `${stats.pendingCount || 0} queued`;
  metricFailedCount.textContent = `${stats.failedCount || 0} failed items`;

  metricActiveKeys.textContent = `${stats.activeKeysCount || 0} / ${stats.totalKeysCount || 0} Keys`;
  activeKeysBadgeCount.textContent = `${stats.activeKeysCount || 0}`;
  aggregateQuotaBadge.textContent = `${stats.totalRemainingQuota || 0}`;

  metricProxyStatus.textContent = `Proxies: ${stats.activeProxiesCount || 0} Online`;

  // Progress Bar
  const total = stats.queueCount || queueData.length || 0;
  const completed = stats.completedCount || 0;
  const pending = stats.pendingCount || 0;
  const processing = stats.processingCount || 0;

  const percent = total > 0 ? Math.round(((completed + (stats.skippedCount || 0)) / total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;

  if (stats.isRunning) {
    progressLabel.textContent = `Optimizing... (${processing} converting, ${pending} pending)`;
    queueStatusPill.textContent = 'Running';
    queueStatusPill.className = 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 font-semibold border border-emerald-500/20';
    setRunningState(true, false);
  } else if (stats.isPaused) {
    progressLabel.textContent = `Queue Paused (${pending} remaining)`;
    queueStatusPill.textContent = 'Paused';
    queueStatusPill.className = 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-500 font-semibold border border-amber-500/20';
    setRunningState(false, true);
  } else if (total > 0 && pending === 0 && processing === 0) {
    progressLabel.textContent = `All ${total} Images Optimized`;
    queueStatusPill.textContent = 'Finished';
    queueStatusPill.className = 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-200 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 font-semibold';
    setRunningState(false, false);
  } else {
    progressLabel.textContent = total > 0 ? `Queue Ready (${total} images)` : 'Queue Empty';
    queueStatusPill.textContent = 'Idle';
    queueStatusPill.className = 'text-[10px] font-mono px-2 py-0.5 rounded-full bg-zinc-100 dark:bg-zinc-800 text-zinc-500 font-medium';
    setRunningState(false, false);
  }
}

function setRunningState(isRunning, isPaused) {
  if (isRunning) {
    btnStartQueue.classList.add('hidden');
    btnPauseQueue.classList.remove('hidden');
    btnResumeQueue.classList.add('hidden');
    btnStopQueue.classList.remove('hidden');
  } else if (isPaused) {
    btnStartQueue.classList.add('hidden');
    btnPauseQueue.classList.add('hidden');
    btnResumeQueue.classList.remove('hidden');
    btnStopQueue.classList.remove('hidden');
  } else {
    btnStartQueue.classList.remove('hidden');
    btnPauseQueue.classList.add('hidden');
    btnResumeQueue.classList.add('hidden');
    btnStopQueue.classList.add('hidden');
  }
}

// Queue Filter Tabs
window.setQueueFilter = function(filter) {
  currentFilter = filter;
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-filter') === filter);
  });
  renderQueueTable();
};

// Activity Log
function logActivity(text, type = 'info') {
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = type === 'error' ? 'text-rose-500 dark:text-rose-400' : type === 'warn' ? 'text-amber-500 dark:text-amber-400' : 'text-zinc-700 dark:text-zinc-300';
  line.innerHTML = `<span class="text-zinc-400 dark:text-zinc-600 font-mono">[${time}]</span> ${text}`;
  activityLogEl.appendChild(line);
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
}

window.clearLogs = function() {
  activityLogEl.innerHTML = '<div class="text-zinc-400 dark:text-zinc-600">[System] Logs cleared.</div>';
};

// Toast Notifications
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `animate-toast pointer-events-auto flex items-center gap-3 p-3.5 rounded-xl border text-xs font-medium shadow-xl backdrop-blur-md ${
    type === 'error' ? 'bg-rose-950/90 border-rose-800 text-rose-200' :
    type === 'warn' ? 'bg-amber-950/90 border-amber-800 text-amber-200' :
    'bg-zinc-900/90 dark:bg-zinc-900 border-zinc-700 text-zinc-100'
  }`;

  const iconName = type === 'error' ? 'alert-circle' : type === 'warn' ? 'alert-triangle' : 'check-circle-2';
  toast.innerHTML = `
    <i data-lucide="${iconName}" class="w-4 h-4 flex-shrink-0"></i>
    <span class="flex-1">${message}</span>
  `;

  toastContainer.appendChild(toast);
  refreshIcons();

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Event Listeners Setup
function setupEventListeners() {
  // Key Actions
  btnToggleAddKey.addEventListener('click', () => {
    boxAddKey.classList.toggle('hidden');
    if (!boxAddKey.classList.contains('hidden')) inputNewKeys.focus();
  });

  btnCancelAddKey.addEventListener('click', () => {
    boxAddKey.classList.add('hidden');
    inputNewKeys.value = '';
  });

  btnSaveNewKeys.addEventListener('click', async () => {
    const raw = inputNewKeys.value.trim();
    if (!raw) return;

    btnSaveNewKeys.disabled = true;
    btnSaveNewKeys.textContent = 'Saving...';

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: raw })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        showToast(`Saved ${data.count} key(s) to pool and synced to keys.txt`, 'success');
        inputNewKeys.value = '';
        boxAddKey.classList.add('hidden');
        await fetchKeys();
      } else {
        showToast(`Error adding keys: ${data.error}`, 'error');
      }
    } catch (err) {
      showToast(`Network error: ${err.message}`, 'error');
    } finally {
      btnSaveNewKeys.disabled = false;
      btnSaveNewKeys.textContent = 'Save to Pool';
    }
  });

  btnRefreshKeys.addEventListener('click', async () => {
    showToast('Refreshing live API key balances...', 'info');
    await fetch('/api/keys/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    await fetchKeys();
  });

  // Proxy Actions
  btnToggleAddProxy.addEventListener('click', () => {
    boxAddProxy.classList.toggle('hidden');
    if (!boxAddProxy.classList.contains('hidden')) inputNewProxies.focus();
  });

  btnCancelAddProxy.addEventListener('click', () => {
    boxAddProxy.classList.add('hidden');
    inputNewProxies.value = '';
  });

  btnSaveNewProxies.addEventListener('click', async () => {
    const raw = inputNewProxies.value.trim();
    if (!raw) return;

    btnSaveNewProxies.disabled = true;
    btnSaveNewProxies.textContent = 'Adding...';

    try {
      const res = await fetch('/api/proxies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxies: raw })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        showToast(`Added ${data.count} proxy servers to pool`, 'success');
        inputNewProxies.value = '';
        boxAddProxy.classList.add('hidden');
        await fetchProxies();
      }
    } catch (err) {
      showToast(`Proxy add error: ${err.message}`, 'error');
    } finally {
      btnSaveNewProxies.disabled = false;
      btnSaveNewProxies.textContent = 'Add Proxies';
    }
  });

  btnTestAllProxies.addEventListener('click', async () => {
    showToast('Benchmarking proxy pool latency...', 'info');
    await fetch('/api/proxies/test', { method: 'POST' });
    await fetchProxies();
  });

  if (btnToggleFetchRemote) {
    btnToggleFetchRemote.addEventListener('click', () => {
      boxFetchRemote.classList.toggle('hidden');
      if (boxAddProxy) boxAddProxy.classList.add('hidden');
    });
  }

  if (btnCancelFetchRemote) {
    btnCancelFetchRemote.addEventListener('click', () => {
      boxFetchRemote.classList.add('hidden');
    });
  }

  if (btnSubmitFetchRemote) {
    btnSubmitFetchRemote.addEventListener('click', async () => {
      const protocol = fetchRemoteProtocol ? fetchRemoteProtocol.value : 'all';
      const maxLatency = fetchRemoteLatency ? parseInt(fetchRemoteLatency.value, 10) : 1200;
      const limit = fetchRemoteLimit ? parseInt(fetchRemoteLimit.value, 10) : 25;

      btnSubmitFetchRemote.disabled = true;
      btnSubmitFetchRemote.innerHTML = '<i data-lucide="loader-2" class="w-3 h-3 animate-spin"></i> Fetching...';
      refreshIcons();

      try {
        const res = await fetch('/api/proxies/fetch-remote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ protocol, maxLatency, limit })
        });
        const data = await res.json().catch(() => ({}));
        if (data.success) {
          showToast(`Imported ${data.count} fast proxies (from ${data.totalFetched} feed)!`, 'success');
          boxFetchRemote.classList.add('hidden');
          await fetchProxies();
        } else {
          showToast(`Fetch failed: ${data.error || 'Unknown error'}`, 'error');
        }
      } catch (err) {
        showToast(`Fetch error: ${err.message}`, 'error');
      } finally {
        btnSubmitFetchRemote.disabled = false;
        btnSubmitFetchRemote.innerHTML = '<i data-lucide="download-cloud" class="w-3 h-3"></i> Fetch & Import';
        refreshIcons();
      }
    });
  }

  settingUseProxy.addEventListener('change', async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ useProxy: settingUseProxy.checked })
    });
    showToast(`Proxy routing ${settingUseProxy.checked ? 'Enabled' : 'Disabled'}`, 'info');
  });

  // Queue Controls
  btnStartQueue.addEventListener('click', async () => {
    await fetch('/api/queue/start', { method: 'POST' });
  });

  btnPauseQueue.addEventListener('click', async () => {
    await fetch('/api/queue/pause', { method: 'POST' });
  });

  btnResumeQueue.addEventListener('click', async () => {
    await fetch('/api/queue/resume', { method: 'POST' });
  });

  btnStopQueue.addEventListener('click', async () => {
    await fetch('/api/queue/stop', { method: 'POST' });
  });

  btnRetryFailed.addEventListener('click', async () => {
    const res = await fetch('/api/queue/retry-failed', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    showToast(`Reset ${data.retriedCount || 0} failed items to pending.`, 'info');
    fetchQueue();
  });

  btnClearQueue.addEventListener('click', async () => {
    if (confirm('Clear the current queue?')) {
      await fetch('/api/queue/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      fetchQueue();
    }
  });

  // Local Folder Scanner
  btnScanFolder.addEventListener('click', async () => {
    const folderPath = inputFolderPath.value.trim();
    if (!folderPath) {
      alert('Please enter a directory path');
      return;
    }

    btnScanFolder.disabled = true;
    btnScanFolder.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> Scanning...';
    refreshIcons();

    try {
      const res = await fetch('/api/scan-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          folderPath,
          autoQueue: true,
          recursive: scanRecursive.checked
        })
      });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        showToast(`Discovered & queued ${data.scannedCount} images from folder!`, 'success');
        fetchQueue();
      } else {
        showToast(`Scan failed: ${data.error || 'Unknown error'}`, 'error');
      }
    } catch (err) {
      showToast(`Scan error: ${err.message}`, 'error');
    } finally {
      btnScanFolder.disabled = false;
      btnScanFolder.innerHTML = '<i data-lucide="scan-line" class="w-3.5 h-3.5"></i> Scan & Queue';
      refreshIcons();
    }
  });

  // Pick Files & Pick Folder
  btnPickFiles.addEventListener('click', e => {
    e.stopPropagation();
    fileUpload.click();
  });

  btnPickFolder.addEventListener('click', e => {
    e.stopPropagation();
    folderUpload.click();
  });

  dropzone.addEventListener('click', () => {
    fileUpload.click();
  });

  fileUpload.addEventListener('change', () => {
    if (fileUpload.files.length > 0) {
      uploadFiles(fileUpload.files);
    }
  });

  folderUpload.addEventListener('change', () => {
    if (folderUpload.files.length > 0) {
      uploadFiles(folderUpload.files, true);
    }
  });

  // Drag & Drop
  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dropzone-active');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dropzone-active');
  });

  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dropzone-active');
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files);
    }
  });

  // Settings Modal
  btnOpenSettings.addEventListener('click', () => settingsModal.classList.remove('hidden'));
  btnCloseSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  btnCancelSettings.addEventListener('click', () => settingsModal.classList.add('hidden'));
  btnSaveSettings.addEventListener('click', saveSettingsFromModal);

  document.getElementById('setting-outputLocationMode').addEventListener('change', e => {
    document.getElementById('box-custom-output-dir').classList.toggle('hidden', e.target.value !== 'custom');
  });
}

// Upload Files / Folders
async function uploadFiles(fileList, isFolder = false) {
  const formData = new FormData();
  const relativePathsMap = {};

  for (let i = 0; i < fileList.length; i++) {
    const file = fileList[i];
    formData.append('images', file);
    if (file.webkitRelativePath) {
      relativePathsMap[file.name] = file.webkitRelativePath;
    }
  }

  formData.append('relativePaths', JSON.stringify(relativePathsMap));

  showToast(`Uploading ${fileList.length} ${isFolder ? 'folder' : ''} files...`, 'info');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });

    const data = await res.json().catch(async () => {
      const text = await res.text();
      return { success: false, error: text.slice(0, 100) };
    });

    if (data.success) {
      showToast(`Loaded ${data.queuedCount || fileList.length} images with details ready!`, 'success');
      fetchQueue();
    } else {
      showToast(`Upload failed: ${data.error || 'Server error'}`, 'error');
    }
  } catch (err) {
    showToast(`Upload error: ${err.message}`, 'error');
  }
}

// Key & Proxy Management Handlers
window.deleteKey = async function(key) {
  if (confirm(`Remove key ${maskKey(key)} from pool and keys.txt?`)) {
    await fetch(`/api/keys/${encodeURIComponent(key)}`, { method: 'DELETE' });
    fetchKeys();
  }
};

window.refreshSingleKey = async function(key) {
  await fetch('/api/keys/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key })
  });
  fetchKeys();
};

window.deleteProxy = async function(id) {
  if (confirm('Remove proxy from pool?')) {
    await fetch(`/api/proxies/${encodeURIComponent(id)}`, { method: 'DELETE' });
    fetchProxies();
  }
};

window.testSingleProxy = async function(id) {
  showToast('Testing proxy connection...', 'info');
  await fetch('/api/proxies/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id })
  });
  fetchProxies();
};

// Item Inspection Modal
window.inspectItem = function(id) {
  const item = queueData.find(i => i.id === id);
  if (!item) return;

  const modal = document.getElementById('preview-modal');
  document.getElementById('preview-modal-title').textContent = item.fileName;
  document.getElementById('preview-modal-subtitle').textContent = item.fullPath;
  document.getElementById('preview-modal-image').src = `/api/preview/${item.id}`;

  const detailsEl = document.getElementById('preview-modal-details');
  detailsEl.innerHTML = `
    <div class="p-2 rounded bg-zinc-100 dark:bg-zinc-900">
      <span class="text-zinc-400 block text-[10px]">ORIGINAL SIZE</span>
      <span class="font-bold text-zinc-900 dark:text-zinc-100">${formatBytes(item.originalSize || item.size)}</span>
    </div>
    <div class="p-2 rounded bg-zinc-100 dark:bg-zinc-900">
      <span class="text-zinc-400 block text-[10px]">OPTIMIZED SIZE</span>
      <span class="font-bold text-emerald-500">${item.compressedSize ? formatBytes(item.compressedSize) : '-'}</span>
    </div>
    <div class="p-2 rounded bg-zinc-100 dark:bg-zinc-900">
      <span class="text-zinc-400 block text-[10px]">REDUCTION</span>
      <span class="font-bold text-cyan-500">${item.percentImprovement ? `-${item.percentImprovement}%` : '-'}</span>
    </div>
    <div class="p-2 rounded bg-zinc-100 dark:bg-zinc-900">
      <span class="text-zinc-400 block text-[10px]">DIMENSIONS</span>
      <span class="font-bold text-zinc-900 dark:text-zinc-100">${item.width && item.height ? `${item.width}×${item.height}` : 'Auto'}</span>
    </div>
  `;

  modal.classList.remove('hidden');
  refreshIcons();
};

window.closePreviewModal = function() {
  document.getElementById('preview-modal').classList.add('hidden');
};

// Settings Modal Helper
function loadSettingsIntoModal(settings) {
  if (!settings) return;
  document.getElementById('setting-lossy').value = settings.lossy ?? 1;
  document.getElementById('setting-outputLocationMode').value = settings.outputLocationMode || 'source_folder';
  document.getElementById('setting-outputDir').value = settings.outputDir || './optimized';
  document.getElementById('box-custom-output-dir').classList.toggle('hidden', settings.outputLocationMode !== 'custom');
  document.getElementById('setting-keyRotationStrategy').value = settings.keyRotationStrategy || 'random';
  document.getElementById('setting-webp').checked = !!settings.convertToWebP;
  document.getElementById('setting-avif').checked = !!settings.convertToAVIF;
  document.getElementById('setting-exif').checked = settings.keepExif !== 0;
  document.getElementById('setting-concurrency').value = settings.concurrency || 2;
  settingUseProxy.checked = !!settings.useProxy;

  const modeLabels = {
    source_folder: 'Uploaded Location /optimized',
    custom: settings.outputDir || './optimized',
    app_root: 'App Root (./optimized)'
  };
  labelActiveOutputMode.textContent = modeLabels[settings.outputLocationMode] || 'Uploaded Location /optimized';

  const strategyLabels = {
    random: 'Random Load Balanced',
    'round-robin': 'Round-Robin Rotation',
    sequential: 'Sequential Fallback'
  };
  metricStrategyBadge.textContent = strategyLabels[settings.keyRotationStrategy] || 'Random Load Balanced';
}

async function saveSettingsFromModal() {
  const newSettings = {
    lossy: parseInt(document.getElementById('setting-lossy').value, 10),
    outputLocationMode: document.getElementById('setting-outputLocationMode').value,
    outputDir: document.getElementById('setting-outputDir').value.trim() || './optimized',
    keyRotationStrategy: document.getElementById('setting-keyRotationStrategy').value,
    convertToWebP: document.getElementById('setting-webp').checked,
    convertToAVIF: document.getElementById('setting-avif').checked,
    keepExif: document.getElementById('setting-exif').checked ? 1 : 0,
    concurrency: parseInt(document.getElementById('setting-concurrency').value, 10)
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });
    const data = await res.json().catch(() => ({}));
    if (data.success) {
      loadSettingsIntoModal(data.settings);
      settingsModal.classList.add('hidden');
      showToast('Settings saved successfully!', 'success');
    }
  } catch (err) {
    showToast(`Error saving settings: ${err.message}`, 'error');
  }
}

// Helper Utilities
function maskKey(k) {
  if (!k) return '';
  const s = String(k).trim();
  if (s.length <= 8) return '****' + s.slice(-2);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function maskProxyUrl(url) {
  if (!url) return '';
  return url.replace(/:[^:@]+@/, ':***@');
}

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
