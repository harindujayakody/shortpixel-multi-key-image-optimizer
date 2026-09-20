import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import archiver from 'archiver';
import { scanDirectory, isSupportedFile, formatBytes, ensureDir } from '../core/file-utils.js';

export function createApiRouter(stateStore, keyManager, queue) {
  const router = express.Router();

  // Configure upload directory for web-uploaded images
  const uploadDir = path.resolve('./uploads');
  ensureDir(uploadDir);

  const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e6);
      cb(null, `${uniqueSuffix}-${file.originalname}`);
    }
  });

  const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB per file
    fileFilter: (req, file, cb) => {
      if (isSupportedFile(file.originalname)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${path.extname(file.originalname)}`));
      }
    }
  });

  // Keep track of active SSE client connections
  const sseClients = new Set();

  function broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

  // Bind queue & key events to SSE broadcast
  queue.on('queueStarted', data => broadcastSSE('queueStarted', data));
  queue.on('queuePaused', data => broadcastSSE('queuePaused', data));
  queue.on('queueResumed', data => broadcastSSE('queueResumed', data));
  queue.on('queueStopped', () => broadcastSSE('queueStopped', {}));
  queue.on('queueCompleted', data => broadcastSSE('queueCompleted', data));
  queue.on('itemStarted', data => broadcastSSE('itemStarted', data));
  queue.on('itemCompleted', data => broadcastSSE('itemCompleted', data));
  queue.on('itemFailed', data => broadcastSSE('itemFailed', data));
  queue.on('keyRotated', data => broadcastSSE('keyRotated', data));
  queue.on('noKeysAvailable', data => broadcastSSE('noKeysAvailable', data));
  queue.on('allKeysExhausted', () => broadcastSSE('allKeysExhausted', {}));
  keyManager.on('keysUpdated', keys => broadcastSSE('keysUpdated', { keys }));
  keyManager.on('keyRotated', data => broadcastSSE('keyRotated', data));

  // ===================== SSE Stream =====================
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    // Initial state push
    res.write(`event: init\ndata: ${JSON.stringify({
      stats: stateStore.getStats(),
      keys: stateStore.getKeys(),
      settings: stateStore.getSettings()
    })}\n\n`);

    req.on('close', () => {
      sseClients.delete(res);
    });
  });

  // ===================== Keys API =====================
  router.get('/keys', (req, res) => {
    const keys = keyManager.getKeys();
    res.json({
      success: true,
      keys: keys.map(k => ({
        ...k,
        maskedKey: keyManager.maskKey(k.key)
      }))
    });
  });

  router.post('/keys', async (req, res) => {
    try {
      const { key, keys } = req.body;
      let toAdd = [];

      if (Array.isArray(keys)) {
        toAdd = keys;
      } else if (typeof keys === 'string') {
        toAdd = keys.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      } else if (key && typeof key === 'string') {
        toAdd = [key.trim()];
      }

      const results = [];
      for (const k of toAdd) {
        if (k && !k.startsWith('#')) {
          const added = await keyManager.addKey(k, true);
          if (added) results.push(added);
        }
      }

      res.json({ success: true, count: results.length, keys: keyManager.getKeys() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/keys/:key', (req, res) => {
    const { key } = req.params;
    keyManager.removeKey(key);
    res.json({ success: true, keys: keyManager.getKeys() });
  });

  router.post('/keys/refresh', async (req, res) => {
    try {
      const { key } = req.body;
      if (key) {
        const updated = await keyManager.refreshKeyStatus(key);
        res.json({ success: true, key: updated });
      } else {
        const results = await keyManager.refreshAllKeys();
        res.json({ success: true, keys: results });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===================== Queue Controls =====================
  router.get('/queue', (req, res) => {
    res.json({
      success: true,
      queue: stateStore.getQueue(),
      stats: stateStore.getStats()
    });
  });

  router.post('/queue/start', async (req, res) => {
    queue.start();
    res.json({ success: true, message: 'Queue started', stats: stateStore.getStats() });
  });

  router.post('/queue/pause', (req, res) => {
    queue.pause();
    res.json({ success: true, message: 'Queue paused', stats: stateStore.getStats() });
  });

  router.post('/queue/resume', (req, res) => {
    queue.resume();
    res.json({ success: true, message: 'Queue resumed', stats: stateStore.getStats() });
  });

  router.post('/queue/stop', (req, res) => {
    queue.stop();
    res.json({ success: true, message: 'Queue stopped', stats: stateStore.getStats() });
  });

  router.post('/queue/clear', (req, res) => {
    const { status } = req.body;
    stateStore.clearQueue(status || null);
    broadcastSSE('queueUpdated', { stats: stateStore.getStats() });
    res.json({ success: true, message: 'Queue cleared', stats: stateStore.getStats() });
  });

  router.post('/queue/retry-failed', (req, res) => {
    const retried = queue.retryFailed();
    res.json({ success: true, retriedCount: retried, stats: stateStore.getStats() });
  });

  // ===================== Folder Scan & Uploads =====================
  router.post('/scan-folder', async (req, res) => {
    try {
      const { folderPath, autoQueue = true, recursive = true } = req.body;
      if (!folderPath) {
        return res.status(400).json({ success: false, error: 'folderPath is required' });
      }

      const cleanPath = path.resolve(folderPath.trim());
      const files = await scanDirectory(cleanPath, { recursive });

      let queued = [];
      if (autoQueue && files.length > 0) {
        queued = stateStore.addToQueue(files);
        broadcastSSE('queueUpdated', { stats: stateStore.getStats() });
      }

      res.json({
        success: true,
        scannedCount: files.length,
        queuedCount: queued.length,
        folderPath: cleanPath,
        files: files.slice(0, 50)
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/upload', upload.array('images', 100), (req, res) => {
    try {
      const files = req.files || [];
      if (files.length === 0) {
        return res.status(400).json({ success: false, error: 'No files uploaded' });
      }

      const queueItems = files.map(f => ({
        name: f.originalname,
        fullPath: path.resolve(f.path),
        relativePath: f.originalname,
        size: f.size
      }));

      const added = stateStore.addToQueue(queueItems);
      broadcastSSE('queueUpdated', { stats: stateStore.getStats() });

      res.json({
        success: true,
        uploadedCount: files.length,
        queuedCount: added.length,
        stats: stateStore.getStats()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===================== Settings & Stats =====================
  router.get('/settings', (req, res) => {
    res.json({ success: true, settings: stateStore.getSettings() });
  });

  router.post('/settings', (req, res) => {
    const updated = stateStore.updateSettings(req.body);
    res.json({ success: true, settings: updated });
  });

  router.get('/stats', (req, res) => {
    const stats = stateStore.getStats();
    res.json({
      success: true,
      stats: {
        ...stats,
        formattedOriginal: formatBytes(stats.totalOriginalBytes),
        formattedCompressed: formatBytes(stats.totalCompressedBytes),
        formattedSaved: formatBytes(stats.totalSavedBytes)
      }
    });
  });

  // ===================== Download Zip =====================
  router.get('/download-zip', (req, res) => {
    const settings = stateStore.getSettings();
    const outDir = path.resolve(settings.outputDir || './optimized');

    if (!fs.existsSync(outDir)) {
      return res.status(404).send('No optimized images found.');
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="shortpixel_optimized_images.zip"');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);
    archive.directory(outDir, false);
    archive.finalize();
  });

  return router;
}
