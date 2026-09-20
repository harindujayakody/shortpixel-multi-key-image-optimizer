import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import archiver from 'archiver';
import { scanDirectory, isSupportedFile, formatBytes, ensureDir, getImageDimensions, MIME_MAP } from '../core/file-utils.js';

export function createApiRouter(stateStore, keyManager, proxyManager, queue) {
  const router = express.Router();

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
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (isSupportedFile(file.originalname)) {
        cb(null, true);
      } else {
        cb(new Error(`Unsupported file type: ${path.extname(file.originalname)} (${file.originalname})`));
      }
    }
  });

  const sseClients = new Set();

  function broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      res.write(payload);
    }
  }

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
  keyManager.on('keysUpdated', keys => broadcastSSE('keysUpdated', { keys, stats: stateStore.getStats() }));
  keyManager.on('keyRotated', data => broadcastSSE('keyRotated', data));
  if (proxyManager) {
    proxyManager.on('proxiesUpdated', proxies => broadcastSSE('proxiesUpdated', { proxies }));
  }

  // ===================== SSE Stream =====================
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);

    res.write(`event: init\ndata: ${JSON.stringify({
      stats: stateStore.getStats(),
      keys: stateStore.getKeys(),
      proxies: stateStore.getProxies(),
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
      })),
      stats: stateStore.getStats()
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

      keyManager.syncKeysToFile();

      res.json({ success: true, count: results.length, keys: keyManager.getKeys(), stats: stateStore.getStats() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/keys/:key', (req, res) => {
    const { key } = req.params;
    keyManager.removeKey(key);
    keyManager.syncKeysToFile();
    res.json({ success: true, keys: keyManager.getKeys(), stats: stateStore.getStats() });
  });

  router.post('/keys/refresh', async (req, res) => {
    try {
      const { key } = req.body;
      if (key) {
        const updated = await keyManager.refreshKeyStatus(key);
        res.json({ success: true, key: updated, stats: stateStore.getStats() });
      } else {
        const results = await keyManager.refreshAllKeys();
        res.json({ success: true, keys: results, stats: stateStore.getStats() });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ===================== Proxies API =====================
  router.get('/proxies', (req, res) => {
    res.json({ success: true, proxies: stateStore.getProxies() });
  });

  router.post('/proxies', (req, res) => {
    try {
      const { proxy, proxies } = req.body;
      let toAdd = [];
      if (Array.isArray(proxies)) toAdd = proxies;
      else if (typeof proxies === 'string') toAdd = proxies.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      else if (proxy) toAdd = [proxy.trim()];

      const results = [];
      for (const p of toAdd) {
        const added = proxyManager.addProxy(p, true);
        if (added) results.push(added);
      }

      res.json({ success: true, count: results.length, proxies: stateStore.getProxies() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/proxies/:id', (req, res) => {
    proxyManager.removeProxy(req.params.id);
    res.json({ success: true, proxies: stateStore.getProxies() });
  });

  router.post('/proxies/test', async (req, res) => {
    try {
      const { id } = req.body;
      if (id) {
        const result = await proxyManager.testProxy(id);
        res.json({ success: true, result });
      } else {
        const results = await proxyManager.testAllProxies();
        res.json({ success: true, results, proxies: stateStore.getProxies() });
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

  // ===================== Image Thumbnail Preview =====================
  router.get('/preview/:id', (req, res) => {
    const item = stateStore.getQueue().find(i => i.id === req.params.id);
    if (!item) return res.status(404).send('Not found');

    const filePath = (item.status === 'COMPLETED' && item.outputPath && fs.existsSync(item.outputPath))
      ? item.outputPath
      : item.fullPath;

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      res.setHeader('Content-Type', MIME_MAP[ext] || 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    } else {
      res.status(404).send('File not found');
    }
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
        files: files.slice(0, 50),
        stats: stateStore.getStats()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/upload', (req, res) => {
    upload.array('images', 1000)(req, res, async err => {
      if (err) {
        return res.status(400).json({ success: false, error: err.message });
      }

      try {
        const files = req.files || [];
        if (files.length === 0) {
          return res.status(400).json({ success: false, error: 'No files uploaded' });
        }

        let relativePathsMap = {};
        if (req.body.relativePaths) {
          try {
            relativePathsMap = JSON.parse(req.body.relativePaths);
          } catch {}
        }

        const queueItems = [];
        for (const f of files) {
          const relPath = relativePathsMap[f.originalname] || f.originalname;
          const ext = path.extname(f.originalname).toLowerCase();
          const dims = await getImageDimensions(f.path);

          queueItems.push({
            name: path.basename(relPath),
            fullPath: path.resolve(f.path),
            relativePath: relPath,
            sourceDir: path.dirname(path.resolve(f.path)),
            size: f.size,
            mimeType: MIME_MAP[ext] || 'image/*',
            width: dims.width,
            height: dims.height
          });
        }

        const added = stateStore.addToQueue(queueItems);
        broadcastSSE('queueUpdated', { stats: stateStore.getStats() });

        res.json({
          success: true,
          uploadedCount: files.length,
          queuedCount: added.length,
          stats: stateStore.getStats()
        });
      } catch (innerErr) {
        res.status(500).json({ success: false, error: innerErr.message });
      }
    });
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
    const queue = stateStore.getQueue();
    const completedItems = queue.filter(i => i.status === 'COMPLETED' && i.outputPath && fs.existsSync(i.outputPath));

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="shortpixel_optimized_images.zip"');

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.pipe(res);

    if (completedItems.length > 0) {
      for (const item of completedItems) {
        archive.file(item.outputPath, { name: item.relativePath || item.fileName });
      }
    } else {
      // Fallback: entire default outDir if present
      const outDir = path.resolve(stateStore.getSettings().outputDir || './optimized');
      if (fs.existsSync(outDir)) {
        archive.directory(outDir, false);
      }
    }

    archive.finalize();
  });

  return router;
}
