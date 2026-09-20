import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import { ShortPixelClient, ShortPixelError } from './shortpixel-client.js';
import { getFileHash, ensureDir, formatBytes } from './file-utils.js';

export class OptimizerQueue extends EventEmitter {
  constructor(stateStore, keyManager, proxyManager = null, client = null) {
    super();
    this.stateStore = stateStore;
    this.keyManager = keyManager;
    this.proxyManager = proxyManager;
    this.client = client || new ShortPixelClient();

    this.isProcessing = false;
    this.activeWorkers = 0;
    this.shouldStop = false;
  }

  /**
   * Start or resume queue processing
   */
  async start() {
    if (this.isProcessing) return;

    this.isProcessing = true;
    this.shouldStop = false;
    this.stateStore.setPaused(false);
    this.stateStore.setRunning(true);

    this.emit('queueStarted', { stats: this.stateStore.getStats() });
    this.processQueueLoop();
  }

  /**
   * Pause queue processing gracefully
   */
  pause() {
    this.stateStore.setPaused(true);
    this.stateStore.setRunning(false);
    this.emit('queuePaused', { activeWorkers: this.activeWorkers });
  }

  /**
   * Resume queue processing
   */
  resume() {
    this.stateStore.setPaused(false);
    this.stateStore.setRunning(true);
    this.emit('queueResumed', { stats: this.stateStore.getStats() });
    if (!this.isProcessing) {
      this.isProcessing = true;
      this.shouldStop = false;
      this.processQueueLoop();
    }
  }

  /**
   * Stop queue processing completely
   */
  stop() {
    this.shouldStop = true;
    this.stateStore.setRunning(false);
    this.stateStore.setPaused(false);
    this.emit('queueStopped');
  }

  /**
   * Reset failed items to PENDING so they can be retried
   */
  retryFailed() {
    const queue = this.stateStore.getQueue();
    let count = 0;
    queue.forEach(item => {
      if (item.status === 'FAILED') {
        item.status = 'PENDING';
        item.error = null;
        count++;
      }
    });
    this.stateStore.save();
    this.emit('queueUpdated', { retryCount: count });
    return count;
  }

  /**
   * Core queue worker loop
   */
  async processQueueLoop() {
    const settings = this.stateStore.getSettings();
    const concurrency = Math.max(1, settings.concurrency || 2);

    while (this.isProcessing && !this.shouldStop) {
      if (this.stateStore.state.isPaused) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (this.activeWorkers >= concurrency) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      const pendingItem = this.stateStore.getQueue().find(i => i.status === 'PENDING');
      if (!pendingItem) {
        if (this.activeWorkers === 0) {
          this.isProcessing = false;
          this.stateStore.setRunning(false);
          this.emit('queueCompleted', { stats: this.stateStore.getStats() });
          break;
        }
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      this.activeWorkers++;
      this.processItem(pendingItem)
        .catch(err => {
          console.error(`[OptimizerQueue] Unhandled item error: ${err.message}`);
        })
        .finally(() => {
          this.activeWorkers--;
        });
    }

    if (this.shouldStop) {
      this.isProcessing = false;
      this.stateStore.setRunning(false);
    }
  }

  /**
   * Resolve target output path according to settings
   */
  resolveOutputPath(item, settings) {
    if (settings.replaceOriginal) {
      return item.fullPath;
    }

    // Default requirement: Uploaded Location /optimized
    if (settings.outputLocationMode === 'source_folder' && item.sourceDir) {
      const sourceOptimizedDir = path.join(item.sourceDir, 'optimized');
      return path.join(sourceOptimizedDir, item.relativePath || item.fileName);
    }

    // Custom output folder
    const customDir = path.resolve(settings.outputDir || './optimized');
    return path.join(customDir, item.relativePath || item.fileName);
  }

  /**
   * Process a single image file with multi-key rotation and optional proxy routing
   */
  async processItem(item, retryCount = 0) {
    const maxItemRetries = 3;
    const settings = this.stateStore.getSettings();
    const startTime = Date.now();

    this.stateStore.updateQueueItem(item.id, {
      status: 'PROCESSING',
      startedAt: new Date().toISOString(),
      error: null
    });

    this.emit('itemStarted', { item: this.stateStore.getQueue().find(i => i.id === item.id) });

    try {
      if (!fs.existsSync(item.fullPath)) {
        throw new Error(`Original file not found at ${item.fullPath}`);
      }

      const hash = await getFileHash(item.fullPath);
      item.hash = hash;

      const targetOutputPath = this.resolveOutputPath(item, settings);
      await ensureDir(path.dirname(targetOutputPath));

      // Skip already optimized files
      const existingRecord = this.stateStore.getHistoryByHash(hash);
      if (existingRecord && fs.existsSync(existingRecord.outputPath || targetOutputPath)) {
        this.stateStore.updateQueueItem(item.id, {
          status: 'SKIPPED',
          hash,
          originalSize: existingRecord.originalSize,
          compressedSize: existingRecord.compressedSize,
          savedBytes: existingRecord.savedBytes,
          percentImprovement: existingRecord.percentImprovement,
          keyUsed: existingRecord.keyUsed,
          outputPath: existingRecord.outputPath || targetOutputPath,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - startTime,
          error: 'Skipped (Already optimized previously)'
        });
        this.emit('itemCompleted', { item: this.stateStore.getQueue().find(i => i.id === item.id) });
        return;
      }

      // Pick active key (distributed via random / round-robin)
      let activeKeyObj = this.keyManager.getActiveKey();
      if (!activeKeyObj) {
        this.stateStore.updateQueueItem(item.id, {
          status: 'PENDING',
          error: 'All API keys exhausted or no keys configured'
        });
        this.pause();
        this.emit('noKeysAvailable', { item });
        return;
      }

      const activeKey = activeKeyObj.key;

      // Check proxy
      let proxyAgent = null;
      let proxyUsedStr = null;
      if (this.proxyManager && settings.useProxy) {
        const proxyObj = this.proxyManager.getNextProxy();
        if (proxyObj) {
          proxyAgent = this.proxyManager.createAgent(proxyObj.url);
          proxyUsedStr = proxyObj.url.replace(/:[^:@]+@/, ':***@'); // mask credentials
        }
      }

      const optOptions = {
        lossy: settings.lossy ?? 1,
        keepExif: settings.keepExif ?? 1,
        convertTo: settings.convertToAVIF ? '+avif' : settings.convertToWebP ? '+webp' : null,
        resize: settings.resize?.enabled ? settings.resize : null,
        proxyAgent
      };

      let result;
      try {
        result = await this.client.optimizeLocalFile(item.fullPath, activeKey, optOptions);
      } catch (apiErr) {
        if (apiErr instanceof ShortPixelError) {
          // Quota Exceeded (-102) -> Rotate key & retry item seamlessly
          if (apiErr.isQuotaExceeded) {
            console.warn(`[OptimizerQueue] Key ${this.keyManager.maskKey(activeKey)} quota exceeded! Rotating key...`);
            const nextKey = this.keyManager.markKeyExhausted(activeKey, 'Quota limit reached during optimization');

            if (nextKey) {
              this.emit('keyRotated', {
                item: item.fileName,
                oldKey: this.keyManager.maskKey(activeKey),
                newKey: this.keyManager.maskKey(nextKey.key)
              });
              return await this.processItem(item, retryCount);
            } else {
              this.stateStore.updateQueueItem(item.id, {
                status: 'PENDING',
                error: 'All API keys exhausted'
              });
              this.pause();
              this.emit('allKeysExhausted');
              return;
            }
          }

          // Invalid Key (-101)
          if (apiErr.isInvalidKey) {
            console.error(`[OptimizerQueue] Key ${this.keyManager.maskKey(activeKey)} invalid! Rotating...`);
            const nextKey = this.keyManager.markKeyInvalid(activeKey, 'Invalid API Key');
            if (nextKey) {
              return await this.processItem(item, retryCount);
            } else {
              this.stateStore.updateQueueItem(item.id, {
                status: 'PENDING',
                error: 'No valid API keys remaining'
              });
              this.pause();
              return;
            }
          }
        }

        if (retryCount < maxItemRetries) {
          console.warn(`[OptimizerQueue] Retrying ${item.fileName} (${retryCount + 1}/${maxItemRetries}) due to: ${apiErr.message}`);
          await new Promise(r => setTimeout(r, 2000));
          return await this.processItem(item, retryCount + 1);
        }

        throw apiErr;
      }

      // Download optimized image
      const downloadUrl = result.lossyUrl || result.originalUrl;
      if (downloadUrl) {
        if (settings.replaceOriginal && settings.backupOriginal) {
          const backupPath = `${item.fullPath}.bak`;
          if (!fs.existsSync(backupPath)) {
            await fs.promises.copyFile(item.fullPath, backupPath);
          }
        }

        await this.client.downloadOptimizedImage(downloadUrl, targetOutputPath, proxyAgent);

        if (result.webPUrl) {
          const webpPath = targetOutputPath.replace(/\.[^.]+$/, '.webp');
          await this.client.downloadOptimizedImage(result.webPUrl, webpPath, proxyAgent);
        }
        if (result.avifUrl) {
          const avifPath = targetOutputPath.replace(/\.[^.]+$/, '.avif');
          await this.client.downloadOptimizedImage(result.avifUrl, avifPath, proxyAgent);
        }
      }

      this.keyManager.recordUsage(activeKey, result.savedBytes);

      const durationMs = Date.now() - startTime;
      const completedRecord = {
        fileName: item.fileName,
        originalSize: result.originalSize || item.size,
        compressedSize: result.compressedSize || result.originalSize || item.size,
        savedBytes: result.savedBytes || 0,
        percentImprovement: result.percentImprovement || 0,
        keyUsed: this.keyManager.maskKey(activeKey),
        proxyUsed: proxyUsedStr,
        outputPath: targetOutputPath,
        durationMs
      };

      this.stateStore.recordHistory(hash, completedRecord);

      this.stateStore.updateQueueItem(item.id, {
        status: 'COMPLETED',
        hash,
        originalSize: completedRecord.originalSize,
        compressedSize: completedRecord.compressedSize,
        savedBytes: completedRecord.savedBytes,
        percentImprovement: completedRecord.percentImprovement,
        keyUsed: this.keyManager.maskKey(activeKey),
        proxyUsed: proxyUsedStr,
        outputPath: targetOutputPath,
        completedAt: new Date().toISOString(),
        durationMs,
        error: null
      });

      this.emit('itemCompleted', {
        item: this.stateStore.getQueue().find(i => i.id === item.id),
        stats: this.stateStore.getStats()
      });

    } catch (err) {
      console.error(`[OptimizerQueue] Failed to optimize ${item.fileName}: ${err.message}`);
      this.stateStore.updateQueueItem(item.id, {
        status: 'FAILED',
        error: err.message,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - startTime
      });
      this.stateStore.state.stats.totalFailed += 1;
      this.stateStore.save();

      this.emit('itemFailed', {
        item: this.stateStore.getQueue().find(i => i.id === item.id),
        error: err.message
      });
    }
  }
}
