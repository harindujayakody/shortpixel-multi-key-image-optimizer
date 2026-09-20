import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import chalk from 'chalk';
import { StateStore } from './core/state-store.js';
import { KeyManager } from './core/key-manager.js';
import { OptimizerQueue } from './core/optimizer-queue.js';
import { ShortPixelClient } from './core/shortpixel-client.js';
import { createApiRouter } from './api/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const STATE_FILE = process.env.STATE_FILE || './shortpixel_state.json';
const KEYS_FILE = './keys.txt';

// Initialize core components
const stateStore = new StateStore(STATE_FILE);
const client = new ShortPixelClient();
const keyManager = new KeyManager(stateStore, client);
const queue = new OptimizerQueue(stateStore, keyManager, client);

// Auto-load keys from keys.txt if present
if (fs.existsSync(KEYS_FILE)) {
  console.log(chalk.cyan(`[Startup] Loading keys from ${KEYS_FILE}...`));
  keyManager.loadKeysFromFile(KEYS_FILE);
  keyManager.refreshAllKeys().catch(err => {
    console.error(`[Startup] Failed to refresh keys: ${err.message}`);
  });
}

// Log rotation events to console
keyManager.on('keyRotated', ({ previousKey, nextKey, reason }) => {
  console.log(
    chalk.yellow(`\n[KEY ROTATION] Key ${previousKey} exhausted (${reason}) -> Swapped to ${nextKey || 'NONE'}`)
  );
});

keyManager.on('allKeysExhausted', () => {
  console.log(chalk.red.bold('\n[WARNING] All API keys in the pool have run out of quota!'));
});

// Setup Express App
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Mount API router
app.use('/api', createApiRouter(stateStore, keyManager, queue));

// Fallback to index.html for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Graceful shutdown
function handleShutdown() {
  console.log(chalk.yellow('\n[Shutdown] Saving state and shutting down gracefully...'));
  queue.stop();
  stateStore.save();
  process.exit(0);
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Start server
app.listen(PORT, () => {
  const keys = keyManager.getKeys();
  const usable = keys.filter(k => k.status !== 'EXHAUSTED' && k.status !== 'INVALID').length;

  console.log(chalk.green.bold('\n======================================================'));
  console.log(chalk.green.bold('  ShortPixel Multi-Key Image Optimizer & Dashboard'));
  console.log(chalk.green.bold('======================================================'));
  console.log(chalk.white(`  Web Dashboard : `) + chalk.cyan.bold(`http://localhost:${PORT}`));
  console.log(chalk.white(`  Key Pool Size : `) + chalk.yellow(`${keys.length} keys (${usable} usable)`));
  console.log(chalk.white(`  State File    : `) + chalk.dim(path.resolve(STATE_FILE)));
  console.log(chalk.green.bold('======================================================\n'));
});

export { stateStore, keyManager, queue, client };
