import fs from 'fs';
import path from 'path';

export class StateStore {
  constructor(stateFilePath = './shortpixel_state.json') {
    this.stateFilePath = path.resolve(stateFilePath);
    this.state = {
      keys: [], // [{ key, status, creditsRemaining, totalCredits, lifetimeImages, lifetimeSavedBytes, lastUsed, lastChecked, error }]
      proxies: [], // [{ id, url, protocol, status, latency, lastChecked, error }]
      activeKeyIndex: 0,
      settings: {
        lossy: 1, // 1: Lossy, 2: Glossy, 0: Lossless
        keepExif: 1,
        convertToWebP: false,
        convertToAVIF: false,
        resize: { enabled: false, width: 1920, height: 1080, type: 'outer' },
        concurrency: 2,
        backupOriginal: true,
        outputLocationMode: 'source_folder', // 'source_folder' (source_dir/optimized), 'custom', 'app_root'
        outputDir: './optimized',
        replaceOriginal: false,
        keyRotationStrategy: 'random', // 'random', 'round-robin', 'sequential'
        useProxy: false,
        proxyStrategy: 'round-robin' // 'round-robin', 'random'
      },
      queue: [], // [{ id, fileName, fullPath, relativePath, sourceDir, hash, size, mimeType, width, height, previewUrl, status, originalSize, compressedSize, savedBytes, percentImprovement, keyUsed, proxyUsed, outputPath, error, startedAt, completedAt, durationMs }]
      history: {}, // hash -> { fileName, originalSize, compressedSize, savedBytes, percentImprovement, keyUsed, completedAt, outputPath }
      stats: {
        totalProcessed: 0,
        totalFailed: 0,
        totalOriginalBytes: 0,
        totalCompressedBytes: 0,
        totalSavedBytes: 0,
        overallRatio: 0
      },
      isPaused: false,
      isRunning: false,
      lastUpdated: new Date().toISOString()
    };

    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.stateFilePath)) {
        const data = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(data);
        this.state = {
          ...this.state,
          ...parsed,
          settings: { ...this.state.settings, ...(parsed.settings || {}) },
          stats: { ...this.state.stats, ...(parsed.stats || {}) },
          history: { ...this.state.history, ...(parsed.history || {}) },
          proxies: parsed.proxies || []
        };
        this.state.isRunning = false;
        if (Array.isArray(this.state.queue)) {
          this.state.queue.forEach(item => {
            if (item.status === 'PROCESSING') {
              item.status = 'PENDING';
            }
          });
        }
      }
    } catch (err) {
      console.error(`[StateStore] Error reading state file: ${err.message}. Starting fresh.`);
    }
  }

  save() {
    try {
      this.state.lastUpdated = new Date().toISOString();
      const tempPath = `${this.stateFilePath}.tmp`;
      const json = JSON.stringify(this.state, null, 2);
      fs.writeFileSync(tempPath, json, 'utf8');
      fs.renameSync(tempPath, this.stateFilePath);
    } catch (err) {
      console.error(`[StateStore] Error saving state: ${err.message}`);
    }
  }

  // ---- Key State Methods ----
  getKeys() {
    return this.state.keys;
  }

  setKeys(keysList) {
    const existingMap = new Map(this.state.keys.map(k => [k.key, k]));
    
    this.state.keys = keysList.map(keyStr => {
      const cleanKey = keyStr.trim();
      if (existingMap.has(cleanKey)) {
        return existingMap.get(cleanKey);
      }
      return {
        key: cleanKey,
        status: 'READY',
        creditsRemaining: null,
        totalCredits: null,
        lifetimeImages: 0,
        lifetimeSavedBytes: 0,
        lastUsed: null,
        lastChecked: null,
        error: null
      };
    });

    this.save();
    return this.state.keys;
  }

  addKey(keyStr) {
    const cleanKey = keyStr.trim();
    if (!cleanKey) return null;
    const exists = this.state.keys.find(k => k.key === cleanKey);
    if (exists) return exists;

    const newKeyObj = {
      key: cleanKey,
      status: 'READY',
      creditsRemaining: null,
      totalCredits: null,
      lifetimeImages: 0,
      lifetimeSavedBytes: 0,
      lastUsed: null,
      lastChecked: null,
      error: null
    };
    this.state.keys.push(newKeyObj);
    this.save();
    return newKeyObj;
  }

  removeKey(keyStr) {
    const cleanKey = keyStr.trim();
    this.state.keys = this.state.keys.filter(k => k.key !== cleanKey);
    this.save();
  }

  updateKey(keyStr, updates) {
    const cleanKey = keyStr.trim();
    const keyObj = this.state.keys.find(k => k.key === cleanKey);
    if (keyObj) {
      Object.assign(keyObj, updates);
      this.save();
    }
  }

  // ---- Proxy State Methods ----
  getProxies() {
    return this.state.proxies || [];
  }

  setProxies(proxies) {
    this.state.proxies = proxies;
    this.save();
    return this.state.proxies;
  }

  addProxy(proxyObj) {
    if (!this.state.proxies) this.state.proxies = [];
    this.state.proxies.push(proxyObj);
    this.save();
    return proxyObj;
  }

  removeProxy(proxyId) {
    if (!this.state.proxies) return;
    this.state.proxies = this.state.proxies.filter(p => p.id !== proxyId);
    this.save();
  }

  updateProxy(proxyId, updates) {
    if (!this.state.proxies) return;
    const proxy = this.state.proxies.find(p => p.id === proxyId);
    if (proxy) {
      Object.assign(proxy, updates);
      this.save();
    }
  }

  // ---- Queue Methods ----
  getQueue() {
    return this.state.queue;
  }

  addToQueue(items) {
    const added = [];
    const existingPaths = new Set(this.state.queue.map(i => i.fullPath));

    for (const item of items) {
      if (!existingPaths.has(item.fullPath)) {
        const queueItem = {
          id: item.id || `item_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
          fileName: item.name || path.basename(item.fullPath),
          fullPath: item.fullPath,
          relativePath: item.relativePath || item.name,
          sourceDir: item.sourceDir || path.dirname(item.fullPath),
          hash: item.hash || null,
          size: item.size || 0,
          mimeType: item.mimeType || null,
          width: item.width || null,
          height: item.height || null,
          previewUrl: item.previewUrl || null,
          status: item.status || 'PENDING',
          originalSize: item.size || 0,
          compressedSize: null,
          savedBytes: null,
          percentImprovement: null,
          keyUsed: null,
          proxyUsed: null,
          outputPath: null,
          error: null,
          startedAt: null,
          completedAt: null,
          durationMs: null
        };
        this.state.queue.push(queueItem);
        existingPaths.add(item.fullPath);
        added.push(queueItem);
      }
    }

    this.save();
    return added;
  }

  updateQueueItem(id, updates) {
    const item = this.state.queue.find(i => i.id === id);
    if (item) {
      Object.assign(item, updates);
      this.save();
    }
    return item;
  }

  clearQueue(statusFilter = null) {
    if (statusFilter) {
      this.state.queue = this.state.queue.filter(i => i.status !== statusFilter);
    } else {
      this.state.queue = [];
    }
    this.save();
  }

  // ---- History & Stats ----
  recordHistory(hash, record) {
    if (hash) {
      this.state.history[hash] = {
        ...record,
        completedAt: new Date().toISOString()
      };
    }

    if (record.savedBytes !== undefined) {
      this.state.stats.totalProcessed += 1;
      this.state.stats.totalOriginalBytes += record.originalSize || 0;
      this.state.stats.totalCompressedBytes += record.compressedSize || 0;
      this.state.stats.totalSavedBytes += Math.max(0, record.savedBytes || 0);

      if (this.state.stats.totalOriginalBytes > 0) {
        this.state.stats.overallRatio = parseFloat(
          (
            (this.state.stats.totalSavedBytes / this.state.stats.totalOriginalBytes) *
            100
          ).toFixed(2)
        );
      }
    }

    this.save();
  }

  getHistoryByHash(hash) {
    return this.state.history[hash] || null;
  }

  getSettings() {
    return this.state.settings;
  }

  updateSettings(newSettings) {
    this.state.settings = {
      ...this.state.settings,
      ...newSettings,
      resize: {
        ...this.state.settings.resize,
        ...(newSettings.resize || {})
      }
    };
    this.save();
    return this.state.settings;
  }

  getStats() {
    const keys = this.state.keys || [];
    let totalQuota = 0;
    let totalRemainingQuota = 0;
    let totalLifetimeOptimized = 0;

    keys.forEach(k => {
      totalQuota += (k.totalCredits || (k.creditsRemaining || 0));
      totalRemainingQuota += (k.creditsRemaining || 0);
      totalLifetimeOptimized += (k.lifetimeImages || 0);
    });

    const activeKeysCount = keys.filter(k => k.status === 'ACTIVE' || (k.status === 'READY' && (k.creditsRemaining > 0 || k.creditsRemaining === null))).length;
    const exhaustedKeysCount = keys.filter(k => k.status === 'EXHAUSTED').length;

    return {
      ...this.state.stats,
      totalQuota,
      totalRemainingQuota,
      totalUsedQuota: Math.max(0, totalQuota - totalRemainingQuota),
      activeKeysCount,
      exhaustedKeysCount,
      totalKeysCount: keys.length,
      proxiesCount: (this.state.proxies || []).length,
      activeProxiesCount: (this.state.proxies || []).filter(p => p.status === 'ACTIVE' || p.status === 'READY').length,
      queueCount: this.state.queue.length,
      pendingCount: this.state.queue.filter(i => i.status === 'PENDING').length,
      processingCount: this.state.queue.filter(i => i.status === 'PROCESSING').length,
      completedCount: this.state.queue.filter(i => i.status === 'COMPLETED').length,
      failedCount: this.state.queue.filter(i => i.status === 'FAILED').length,
      skippedCount: this.state.queue.filter(i => i.status === 'SKIPPED').length,
      isPaused: this.state.isPaused,
      isRunning: this.state.isRunning
    };
  }

  setPaused(isPaused) {
    this.state.isPaused = isPaused;
    this.save();
  }

  setRunning(isRunning) {
    this.state.isRunning = isRunning;
    this.save();
  }
}
