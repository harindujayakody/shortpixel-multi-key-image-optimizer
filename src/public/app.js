// State on the frontend
let currentFilter = 'ALL';
let queueData = [];
let keysData = [];
let statsData = {};
let eventSource = null;

// DOM Elements
const keysListEl = document.getElementById('keys-list');
const queueTableBody = document.getElementById('queue-table-body');
const activityLogEl = document.getElementById('activity-log');
const activeKeyLabel = document.getElementById('active-key-label');
const activeKeyCredits = document.getElementById('active-key-credits');

// Buttons
const btnStartQueue = document.getElementById('btn-start-queue');
const btnPauseQueue = document.getElementById('btn-pause-queue');
const btnResumeQueue = document.getElementById('btn-resume-queue');
const btnStopQueue = document.getElementById('btn-stop-queue');
const btnRetryFailed = document.getElementById('btn-retry-failed');
const btnClearQueue = document.getElementById('btn-clear-queue');
const btnShowAddKey = document.getElementById('btn-show-add-key');
const btnCancelAddKey = document.getElementById('btn-cancel-add-key');
const btnSubmitKeys = document.getElementById('btn-submit-keys');
const btnRefreshKeys = document.getElementById('btn-refresh-keys');
const addKeyContainer = document.getElementById('add-key-container');
const inputApiKeys = document.getElementById('input-api-keys');

const btnScanFolder = document.getElementById('btn-scan-folder');
const inputFolderPath = document.getElementById('input-folder-path');
const fileUpload = document.getElementById('file-upload');
const dropzone = document.getElementById('dropzone');

// Settings Modal
const btnOpenSettings = document.getElementById('btn-open-settings');
const btnCloseSettings = document.getElementById('btn-close-settings');
const btnCancelSettings = document.getElementById('btn-cancel-settings');
const btnSaveSettings = document.getElementById('btn-save-settings');
const settingsModal = document.getElementById('settings-modal');

// Alert Banner
const alertBanner = document.getElementById('alert-banner');
const alertMessage = document.getElementById('alert-message');
const alertIcon = document.getElementById('alert-icon');

// Progress
const progressBar = document.getElementById('progress-bar');
const progressLabel = document.getElementById('progress-label');
const progressPercent = document.getElementById('progress-percent');

// Init application
document.addEventListener('DOMContentLoaded', () => {
  initSSE();
  fetchInitialData();
  setupEventListeners();
});

// Setup Server-Sent Events (SSE) for zero-latency reactive updates
function initSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/events');

  eventSource.addEventListener('init', e => {
    const data = JSON.parse(e.data);
    updateStats(data.stats);
    updateKeysList(data.keys);
    loadSettingsIntoModal(data.settings);
  });

  eventSource.addEventListener('keysUpdated', e => {
    const data = JSON.parse(e.data);
    updateKeysList(data.keys);
    fetchStats();
  });

  eventSource.addEventListener('keyRotated', e => {
    const data = JSON.parse(e.data);
    logActivity(`[Auto-Rotation] Key exhausted (${data.previousKey || data.oldKey}) -> Switched to ${data.nextKey || data.newKey || 'None'}`);
    showAlert(`Auto-switched to key: ${data.nextKey || data.newKey || 'None'} (Previous key ran out of quota)`, 'warning');
    fetchKeys();
  });

  eventSource.addEventListener('allKeysExhausted', () => {
    logActivity('[Alert] ALL API keys in the pool have been exhausted!', 'error');
    showAlert('All API keys are exhausted! Please add new keys or wait for quota reset.', 'error');
    setRunningState(false, true);
  });

  eventSource.addEventListener('itemStarted', e => {
    const data = JSON.parse(e.data);
    logActivity(`Processing: ${data.item.fileName}...`);
    fetchQueue();
  });

  eventSource.addEventListener('itemCompleted', e => {
    const data = JSON.parse(e.data);
    const item = data.item;
    logActivity(`Done: ${item.fileName} (${formatBytes(item.savedBytes)} saved, -${item.percentImprovement}%) [Key: ${item.keyUsed}]`);
    fetchQueue();
    fetchStats();
  });

  eventSource.addEventListener('itemFailed', e => {
    const data = JSON.parse(e.data);
    logActivity(`Failed: ${data.item.fileName} - ${data.error}`, 'error');
    fetchQueue();
    fetchStats();
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
    logActivity('All images in queue completed!');
    setRunningState(false, false);
    showAlert('Optimization finished! All queued images have been processed.', 'success');
  });

  eventSource.addEventListener('queueUpdated', () => {
    fetchQueue();
    fetchStats();
  });

  eventSource.onerror = () => {
    // Retry in 3 seconds
    setTimeout(initSSE, 3000);
  };
}

// Fetch all initial data
async function fetchInitialData() {
  await Promise.all([fetchKeys(), fetchQueue(), fetchStats(), fetchSettings()]);
}

async function fetchKeys() {
  try {
    const res = await fetch('/api/keys');
    const data = await res.json();
    if (data.success) {
      keysData = data.keys;
      updateKeysList(data.keys);
    }
  } catch (err) {
    console.error('Error fetching keys:', err);
  }
}

async function fetchQueue() {
  try {
    const res = await fetch('/api/queue');
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
    const data = await res.json();
    if (data.success) {
      loadSettingsIntoModal(data.settings);
    }
  } catch (err) {
    console.error('Error fetching settings:', err);
  }
}

// Render Keys
function updateKeysList(keys) {
  if (!keysListEl) return;

  if (!keys || keys.length === 0) {
    keysListEl.innerHTML = `
      <div class="text-xs text-slate-500 text-center py-6">
        No API keys registered yet. Add one or more keys above!
      </div>
    `;
    activeKeyLabel.textContent = 'Active Key: None';
    activeKeyCredits.textContent = '';
    return;
  }

  // Find active key
  const activeKey = keys.find(k => k.status === 'ACTIVE' || (k.status === 'READY' && (k.creditsRemaining > 0 || k.creditsRemaining === null)));
  if (activeKey) {
    activeKeyLabel.textContent = `Active: ${maskKey(activeKey.key)}`;
    activeKeyCredits.textContent = activeKey.creditsRemaining !== null ? `(${activeKey.creditsRemaining} credits left)` : '';
  } else {
    activeKeyLabel.textContent = 'All Keys Exhausted';
    activeKeyCredits.textContent = '';
  }

  // Render cards
  keysListEl.innerHTML = keys.map((k, idx) => {
    let statusBadge = '';
    if (k.status === 'ACTIVE') {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><i class="fa-solid fa-circle text-[6px] mr-1"></i>Active</span>';
    } else if (k.status === 'READY') {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">Ready</span>';
    } else if (k.status === 'EXHAUSTED') {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20">Exhausted</span>';
    } else {
      statusBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400">Invalid</span>';
    }

    const creditsDisplay = k.creditsRemaining !== null ? `${k.creditsRemaining} left` : 'Unchecked';

    return `
      <div class="p-3 rounded-lg bg-slate-950/60 border border-slate-800/80 hover:border-slate-700 transition flex items-center justify-between">
        <div class="space-y-1">
          <div class="flex items-center gap-2">
            <span class="font-mono text-xs font-medium text-slate-200">${maskKey(k.key)}</span>
            ${statusBadge}
          </div>
          <div class="text-[11px] text-slate-400 flex items-center gap-3">
            <span><i class="fa-solid fa-coins text-amber-400/80 mr-1"></i>Credits: <strong class="text-slate-200">${creditsDisplay}</strong></span>
            <span><i class="fa-solid fa-check text-emerald-400 mr-1"></i>${k.lifetimeImages || 0} optimized</span>
          </div>
        </div>
        <div class="flex items-center gap-1">
          <button onclick="refreshSingleKey('${k.key}')" class="p-1.5 rounded hover:bg-slate-800 text-slate-400 hover:text-white text-xs" title="Refresh Balance">
            <i class="fa-solid fa-rotate"></i>
          </button>
          <button onclick="deleteKey('${k.key}')" class="p-1.5 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-400 text-xs" title="Remove Key">
            <i class="fa-solid fa-trash"></i>
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// Render Queue Table
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
        <td colspan="6" class="px-4 py-8 text-center text-slate-500">
          ${queueData.length === 0 ? 'No items in queue. Upload images or scan a folder above.' : `No items with status "${currentFilter}".`}
        </td>
      </tr>
    `;
    return;
  }

  queueTableBody.innerHTML = filtered.map(item => {
    let statusHtml = '';
    if (item.status === 'COMPLETED') {
      statusHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"><i class="fa-solid fa-check"></i> Completed</span>';
    } else if (item.status === 'PROCESSING') {
      statusHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-500/10 text-indigo-400 border border-indigo-500/20"><i class="fa-solid fa-circle-notch fa-spin"></i> Processing</span>';
    } else if (item.status === 'SKIPPED') {
      statusHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20" title="Already optimized"><i class="fa-solid fa-forward"></i> Skipped</span>';
    } else if (item.status === 'FAILED') {
      statusHtml = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/20" title="${item.error || 'Error'}"><i class="fa-solid fa-triangle-exclamation"></i> Failed</span>`;
    } else {
      statusHtml = '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-800 text-slate-400">Pending</span>';
    }

    const savingsDisplay = item.percentImprovement
      ? `<span class="text-emerald-400 font-semibold">-${item.percentImprovement}%</span> <span class="text-[10px] text-slate-500">(${formatBytes(item.savedBytes)})</span>`
      : '<span class="text-slate-500">-</span>';

    const optimizedSizeDisplay = item.compressedSize
      ? formatBytes(item.compressedSize)
      : '<span class="text-slate-500">-</span>';

    return `
      <tr class="hover:bg-slate-800/30 transition">
        <td class="px-4 py-3">
          <div class="font-medium text-slate-200 truncate max-w-[220px]" title="${item.fullPath}">${item.fileName}</div>
          <div class="text-[10px] text-slate-500 truncate max-w-[220px]">${item.relativePath || ''}</div>
        </td>
        <td class="px-4 py-3 text-slate-400">${formatBytes(item.originalSize || item.size)}</td>
        <td class="px-4 py-3 text-slate-300 font-mono">${optimizedSizeDisplay}</td>
        <td class="px-4 py-3">${savingsDisplay}</td>
        <td class="px-4 py-3 font-mono text-slate-400">${item.keyUsed || '-'}</td>
        <td class="px-4 py-3 text-right">${statusHtml}</td>
      </tr>
    `;
  }).join('');
}

// Update Top Stats & Progress Bar
function updateStats(stats) {
  if (!stats) return;

  document.getElementById('stat-processed').textContent = stats.totalProcessed || 0;
  document.getElementById('stat-saved-bytes').textContent = formatBytes(stats.totalSavedBytes || 0);
  document.getElementById('stat-original-size').textContent = `From ${formatBytes(stats.totalOriginalBytes || 0)} total`;
  document.getElementById('stat-ratio').textContent = `${stats.overallRatio || 0}%`;

  const keys = keysData || [];
  const usable = keys.filter(k => k.status === 'ACTIVE' || (k.status === 'READY' && (k.creditsRemaining > 0 || k.creditsRemaining === null))).length;
  document.getElementById('stat-keys-count').textContent = keys.length;
  document.getElementById('stat-keys-available').textContent = `${usable} usable keys in pool`;

  // Update Queue Info
  const total = stats.queueCount || queueData.length || 0;
  const completed = stats.completedCount || 0;
  const pending = stats.pendingCount || 0;
  const processing = stats.processingCount || 0;

  document.getElementById('stat-queue-info').textContent = `${pending} pending, ${completed} completed`;

  // Progress Bar
  const percent = total > 0 ? Math.round(((completed + (stats.skippedCount || 0)) / total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  progressPercent.textContent = `${percent}%`;

  if (stats.isRunning) {
    progressLabel.textContent = `Optimizing... (${processing} active, ${pending} remaining)`;
    setRunningState(true, false);
  } else if (stats.isPaused) {
    progressLabel.textContent = `Queue Paused (${pending} remaining)`;
    setRunningState(false, true);
  } else if (total > 0 && pending === 0 && processing === 0) {
    progressLabel.textContent = `Completed (${total} images)`;
    setRunningState(false, false);
  } else {
    progressLabel.textContent = total > 0 ? `Queue Ready (${total} images)` : 'Queue Empty';
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
  line.className = type === 'error' ? 'text-rose-400' : type === 'warn' ? 'text-amber-400' : 'text-slate-300';
  line.innerHTML = `<span class="text-slate-600">[${time}]</span> ${text}`;
  activityLogEl.appendChild(line);
  activityLogEl.scrollTop = activityLogEl.scrollHeight;
}

window.clearLogs = function() {
  activityLogEl.innerHTML = '<div class="text-slate-600">[System] Logs cleared.</div>';
};

// Alert Banner Helper
function showAlert(message, type = 'info') {
  alertMessage.textContent = message;
  alertBanner.className = `rounded-xl border p-4 text-sm flex items-center justify-between transition-all ${
    type === 'error' ? 'bg-rose-950/40 border-rose-800/80 text-rose-300' :
    type === 'warning' ? 'bg-amber-950/40 border-amber-800/80 text-amber-300' :
    'bg-emerald-950/40 border-emerald-800/80 text-emerald-300'
  }`;
  alertIcon.className = `fa-solid ${
    type === 'error' ? 'fa-triangle-exclamation text-rose-400' :
    type === 'warning' ? 'fa-triangle-exclamation text-amber-400' :
    'fa-circle-check text-emerald-400'
  }`;
  alertBanner.classList.remove('hidden');
}

window.dismissAlert = function() {
  alertBanner.classList.add('hidden');
};

// Event Listeners
function setupEventListeners() {
  // Key Actions
  btnShowAddKey.addEventListener('click', () => {
    addKeyContainer.classList.toggle('hidden');
    if (!addKeyContainer.classList.contains('hidden')) inputApiKeys.focus();
  });

  btnCancelAddKey.addEventListener('click', () => {
    addKeyContainer.classList.add('hidden');
    inputApiKeys.value = '';
  });

  btnSubmitKeys.addEventListener('click', async () => {
    const raw = inputApiKeys.value.trim();
    if (!raw) return;

    btnSubmitKeys.disabled = true;
    btnSubmitKeys.textContent = 'Verifying...';

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keys: raw })
      });
      const data = await res.json();
      if (data.success) {
        showAlert(`Successfully verified and added ${data.count} key(s) to the pool!`, 'success');
        inputApiKeys.value = '';
        addKeyContainer.classList.add('hidden');
        await fetchKeys();
      } else {
        showAlert(`Error adding keys: ${data.error}`, 'error');
      }
    } catch (err) {
      showAlert(`Network error: ${err.message}`, 'error');
    } finally {
      btnSubmitKeys.disabled = false;
      btnSubmitKeys.textContent = 'Verify & Add';
    }
  });

  btnRefreshKeys.addEventListener('click', async () => {
    btnRefreshKeys.innerHTML = '<i class="fa-solid fa-rotate fa-spin"></i>';
    try {
      await fetch('/api/keys/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      await fetchKeys();
      showAlert('Refreshed API key balances!', 'success');
    } finally {
      btnRefreshKeys.innerHTML = '<i class="fa-solid fa-rotate"></i>';
    }
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
    const data = await res.json();
    showAlert(`Reset ${data.retriedCount || 0} failed items to pending.`, 'info');
    fetchQueue();
  });

  btnClearQueue.addEventListener('click', async () => {
    if (confirm('Clear the current queue?')) {
      await fetch('/api/queue/clear', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      fetchQueue();
    }
  });

  // Folder Scanner
  btnScanFolder.addEventListener('click', async () => {
    const folderPath = inputFolderPath.value.trim();
    if (!folderPath) {
      alert('Please enter a folder path');
      return;
    }

    btnScanFolder.disabled = true;
    btnScanFolder.textContent = 'Scanning...';

    try {
      const res = await fetch('/api/scan-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath, autoQueue: true })
      });
      const data = await res.json();
      if (data.success) {
        showAlert(`Found ${data.scannedCount} images in folder and added to queue!`, 'success');
        fetchQueue();
      } else {
        showAlert(`Scan failed: ${data.error}`, 'error');
      }
    } catch (err) {
      showAlert(`Network error: ${err.message}`, 'error');
    } finally {
      btnScanFolder.disabled = false;
      btnScanFolder.textContent = 'Scan & Queue';
    }
  });

  // Drag & Drop Upload
  dropzone.addEventListener('click', () => fileUpload.click());

  fileUpload.addEventListener('change', () => {
    if (fileUpload.files.length > 0) {
      uploadFiles(fileUpload.files);
    }
  });

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
}

// Upload Files via multipart
async function uploadFiles(fileList) {
  const formData = new FormData();
  for (let i = 0; i < fileList.length; i++) {
    formData.append('images', fileList[i]);
  }

  showAlert(`Uploading ${fileList.length} files...`, 'info');

  try {
    const res = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await res.json();
    if (data.success) {
      showAlert(`Uploaded and queued ${data.queuedCount} images!`, 'success');
      fetchQueue();
    } else {
      showAlert(`Upload failed: ${data.error}`, 'error');
    }
  } catch (err) {
    showAlert(`Upload error: ${err.message}`, 'error');
  }
}

// Key actions
window.deleteKey = async function(key) {
  if (confirm(`Remove key ${maskKey(key)} from pool?`)) {
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

// Settings Modal Helper
function loadSettingsIntoModal(settings) {
  if (!settings) return;
  document.getElementById('setting-lossy').value = settings.lossy ?? 1;
  document.getElementById('setting-outputDir').value = settings.outputDir || './optimized';
  document.getElementById('setting-webp').checked = !!settings.convertToWebP;
  document.getElementById('setting-avif').checked = !!settings.convertToAVIF;
  document.getElementById('setting-exif').checked = settings.keepExif !== 0;
  document.getElementById('setting-concurrency').value = settings.concurrency || 2;
}

async function saveSettingsFromModal() {
  const newSettings = {
    lossy: parseInt(document.getElementById('setting-lossy').value, 10),
    outputDir: document.getElementById('setting-outputDir').value.trim() || './optimized',
    convertToWebP: document.getElementById('setting-webp').checked,
    convertToAVIF: document.getElementById('setting-avif').checked,
    keepExif: document.getElementById('setting-exif').checked ? 1 : 0,
    concurrency: parseInt(document.getElementById('setting-concurrency').value, 10)
  };

  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newSettings)
    });
    settingsModal.classList.add('hidden');
    showAlert('Settings updated successfully!', 'success');
  } catch (err) {
    showAlert(`Error saving settings: ${err.message}`, 'error');
  }
}

// Helpers
function maskKey(k) {
  if (!k) return '';
  const s = String(k).trim();
  if (s.length <= 8) return '****' + s.slice(-2);
  return `${s.slice(0, 4)}...${s.slice(-4)}`;
}

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
