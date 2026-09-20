import EventEmitter from 'events';
import path from 'path';
import fs from 'fs';
import { ShortPixelClient, ShortPixelError } from './shortpixel-client.js';
import { getFileHash, ensureDir, formatBytes } from './file-utils.js';

export class OptimizerQueue extends EventEmitter {
  constructor(stateStore, keyManager, client = null) {
    super();
    this.stateStore = stateStore;
    this.keyManager = keyManager;
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
        // Paused, wait briefly
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Check if we have active workers capacity
      if (this.activeWorkers >= concurrency) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // Find next pending item
      const pendingItem = this.stateStore.getQueue().find(i => i.status === 'PENDING');
      if (!pendingItem) {
        // Check if any workers are still running
        if (this.activeWorkers === 0) {
          // All done!
          this.isProcessing = false;
          this.stateStore.setRunning(false);
          this.emit('queueCompleted', { stats: this.stateStore.getStats() });
          break;
        }
        await new Promise(r => setTimeout(r, 300));
        continue;
      }

      // Spawn worker for pendingItem
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
   * Process a single image file with automatic key rotation on quota exhaustion
   */
  async processItem(item, retryCount = 0) {
    const maxItemRetries = 3;
    const settings = this.stateStore.getSettings();

    // Mark item as PROCESSING
    this.stateStore.updateQueueItem(item.id, {
      status: 'PROCESSING',
      startedAt: new Date().toISOString(),
      error: null
    });

    this.emit('itemStarted', { item: this.stateStore.getQueue().find(i => i.id === item.id) });

    try {
      // 1. Check file exists
      if (!fs.existsSync(item.fullPath)) {
        throw new Error(`Original file not found at ${item.fullPath}`);
      }

      // 2. Hash file for deduplication check
      const hash = await getFileHash(item.fullPath);
      item.hash = hash;

      // 3. Determine output path
      const outDir = path.resolve(settings.outputDir || './optimized');
      await ensureDir(outDir);

      let targetOutputPath = path.join(outDir, item.relativePath || item.fileName);
      if (settings.replaceOriginal) {
        targetOutputPath = item.fullPath;
      }

      // If already processed with same hash and output exists, skip to save credits
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
          error: 'Skipped (Already optimized previously)'
        });
        this.emit('itemCompleted', { item: this.stateStore.getQueue().find(i => i.id === item.id) });
        return;
      }

      // 4. Retrieve an active, usable API key
      let activeKeyObj = this.keyManager.getActiveKey();
      if (!activeKeyObj) {
        // No keys available in pool!
        this.stateStore.updateQueueItem(item.id, {
          status: 'PENDING',
          error: 'All API keys exhausted or no keys configured'
        });
        this.pause();
        this.emit('noKeysAvailable', { item });
        return;
      }

      const activeKey = activeKeyObj.key;

      // 5. Send optimization request to ShortPixel
      const optOptions = {
        lossy: settings.lossy ?? 1,
        keepExif: settings.keepExif ?? 1,
        convertTo: settings.convertToAVIF ? '+avif' : settings.convertToWebP ? '+webp' : null,
        resize: settings.resize?.enabled ? settings.resize : null
      };

      let result;
      try {
        result = await this.client.optimizeLocalFile(item.fullPath, activeKey, optOptions);
      } catch (apiErr) {
        if (apiErr instanceof ShortPixelError) {
          // Case A: Quota Exceeded (-102) -> Rotate key & retry item!
          if (apiErr.isQuotaExceeded) {
            console.warn(`[OptimizerQueue] Key ${this.keyManager.maskKey(activeKey)} quota exceeded! Rotating to next key...`);
            const nextKey = this.keyManager.markKeyExhausted(activeKey, 'Quota limit reached during optimization');

            if (nextKey) {
              this.emit('keyRotated', {
                item: item.fileName,
                oldKey: this.keyManager.maskKey(activeKey),
                newKey: this.keyManager.maskKey(nextKey.key)
              });
              // Retry immediately with the new key
              return await this.processItem(item, retryCount);
            } else {
              // No more keys in pool!
              this.stateStore.updateQueueItem(item.id, {
                status: 'PENDING',
                error: 'All API keys exhausted'
              });
              this.pause();
              this.emit('allKeysExhausted');
              return;
            }
          }

          // Case B: Invalid API Key (-101) -> Mark invalid, rotate & retry
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

        // Other network/server errors -> retry up to maxItemRetries
        if (retryCount < maxItemRetries) {
          console.warn(`[OptimizerQueue] Retrying ${item.fileName} (Attempt ${retryCount + 1}/${maxItemRetries}) due to: ${apiErr.message}`);
          await new Promise(r => setTimeout(r, 2000));
          return await this.processItem(item, retryCount + 1);
        }

        throw apiErr;
      }

      // 6. Download optimized file to target directory
      const downloadUrl = result.lossyUrl || result.originalUrl;
      if (downloadUrl) {
        // Backup original if replacing in-place
        if (settings.replaceOriginal && settings.backupOriginal) {
          const backupPath = `${item.fullPath}.bak`;
          if (!fs.existsSync(backupPath)) {
            await fs.promises.copyFile(item.fullPath, backupPath);
          }
        }

        await this.client.downloadOptimizedImage(downloadUrl, targetOutputPath);

        // Download WebP / AVIF alongside if generated
        if (result.webPUrl) {
          const webpPath = targetOutputPath.replace(/\.[^.]+$/, '.webp');
          await this.client.downloadOptimizedImage(result.webPUrl, webpPath);
        }
        if (result.avifUrl) {
          const avifPath = targetOutputPath.replace(/\.[^.]+$/, '.avif');
          await this.client.downloadOptimizedImage(result.avifUrl, avifPath);
        }
      }

      // 7. Record usage on key and save state
      this.keyManager.recordUsage(activeKey, result.savedBytes);

      const completedRecord = {
        fileName: item.fileName,
        originalSize: result.originalSize || item.size,
        compressedSize: result.compressedSize || result.originalSize || item.size,
        savedBytes: result.savedBytes || 0,
        percentImprovement: result.percentImprovement || 0,
        keyUsed: this.keyManager.maskKey(activeKey),
        outputPath: targetOutputPath
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
        outputPath: targetOutputPath,
        completedAt: new Date().toISOString(),
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
        completedAt: new Date().toISOString()
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
