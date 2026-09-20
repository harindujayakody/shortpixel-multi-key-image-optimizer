import fs from 'fs';
import EventEmitter from 'events';
import { ShortPixelClient } from './shortpixel-client.js';

export class KeyManager extends EventEmitter {
  constructor(stateStore, client = null, keysFilePath = './keys.txt') {
    super();
    this.stateStore = stateStore;
    this.client = client || new ShortPixelClient();
    this.keysFilePath = keysFilePath;
    this.currentKeyIndex = 0;
  }

  /**
   * Load keys from keys.txt
   */
  loadKeysFromFile(filePath = this.keysFilePath) {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

      return this.stateStore.setKeys(lines);
    } catch (err) {
      console.error(`[KeyManager] Error loading keys from file: ${err.message}`);
      return [];
    }
  }

  /**
   * Save and synchronize all active keys to keys.txt
   */
  syncKeysToFile(filePath = this.keysFilePath) {
    try {
      const keys = this.getKeys();
      const content = keys.map(k => k.key).join('\n') + '\n';
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.error(`[KeyManager] Error syncing keys to file: ${err.message}`);
    }
  }

  /**
   * Get all registered keys with their status
   */
  getKeys() {
    return this.stateStore.getKeys();
  }

  /**
   * Add a single API key to the pool and sync to keys.txt
   */
  async addKey(apiKey, verify = true) {
    const keyObj = this.stateStore.addKey(apiKey);
    if (!keyObj) return null;

    this.syncKeysToFile();

    if (verify) {
      await this.refreshKeyStatus(apiKey);
    }

    this.emit('keysUpdated', this.getKeys());
    return this.getKey(apiKey);
  }

  /**
   * Remove a key from pool and sync to keys.txt
   */
  removeKey(apiKey) {
    this.stateStore.removeKey(apiKey);
    this.syncKeysToFile();
    this.emit('keysUpdated', this.getKeys());
  }

  /**
   * Get specific key object
   */
  getKey(apiKey) {
    return this.getKeys().find(k => k.key === apiKey.trim());
  }

  /**
   * Refresh balance and status for a single key
   */
  async refreshKeyStatus(apiKey) {
    const status = await this.client.checkKeyStatus(apiKey);
    this.stateStore.updateKey(apiKey, {
      status: status.status,
      creditsRemaining: status.creditsRemaining,
      totalCredits: status.totalCredits || null,
      lastChecked: new Date().toISOString(),
      error: status.valid ? null : status.message
    });
    return this.getKey(apiKey);
  }

  /**
   * Refresh balances for all keys in the pool
   */
  async refreshAllKeys() {
    const keys = this.getKeys();
    const results = [];

    for (const k of keys) {
      const updated = await this.refreshKeyStatus(k.key);
      results.push(updated);
    }

    this.emit('keysUpdated', this.getKeys());
    return results;
  }

  /**
   * Get an active key according to the configured load balancing strategy:
   * 'random' (default) - picks randomly from all available keys to distribute load
   * 'round-robin' - rotates sequentially among all usable keys
   * 'sequential' - uses key 1 until exhausted, then key 2
   */
  getActiveKey() {
    const keys = this.getKeys();
    if (!keys || keys.length === 0) return null;

    const usableKeys = keys.filter(k => this.isKeyUsable(k));
    if (usableKeys.length === 0) return null;

    const settings = this.stateStore.getSettings();
    const strategy = settings.keyRotationStrategy || 'random';

    if (strategy === 'random') {
      const randomIdx = Math.floor(Math.random() * usableKeys.length);
      return usableKeys[randomIdx];
    } else if (strategy === 'round-robin') {
      this.currentKeyIndex = (this.currentKeyIndex + 1) % usableKeys.length;
      return usableKeys[this.currentKeyIndex];
    }

    // Default to first usable (sequential)
    return usableKeys[0];
  }

  /**
   * Check if a key is eligible to process requests
   */
  isKeyUsable(keyObj) {
    if (!keyObj) return false;
    if (keyObj.status === 'INVALID' || keyObj.status === 'EXHAUSTED') {
      return false;
    }
    if (keyObj.creditsRemaining !== null && keyObj.creditsRemaining <= 0) {
      return false;
    }
    return true;
  }

  /**
   * Mark a key as exhausted (quota depleted) and rotate to next key
   */
  markKeyExhausted(apiKey, reason = 'Quota exhausted') {
    const keyObj = this.getKey(apiKey);
    if (!keyObj) return null;

    console.warn(`[KeyManager] Key ${this.maskKey(apiKey)} marked EXHAUSTED: ${reason}`);

    this.stateStore.updateKey(apiKey, {
      status: 'EXHAUSTED',
      creditsRemaining: 0,
      error: reason,
      lastChecked: new Date().toISOString()
    });

    const previousKey = apiKey;
    const nextKey = this.getActiveKey();

    this.emit('keyRotated', {
      previousKey: this.maskKey(previousKey),
      nextKey: nextKey ? this.maskKey(nextKey.key) : null,
      reason
    });

    this.emit('keysUpdated', this.getKeys());
    return nextKey;
  }

  /**
   * Mark a key as invalid
   */
  markKeyInvalid(apiKey, reason = 'Invalid API key') {
    console.error(`[KeyManager] Key ${this.maskKey(apiKey)} marked INVALID: ${reason}`);

    this.stateStore.updateKey(apiKey, {
      status: 'INVALID',
      error: reason,
      lastChecked: new Date().toISOString()
    });

    const nextKey = this.getActiveKey();
    this.emit('keyRotated', {
      previousKey: this.maskKey(apiKey),
      nextKey: nextKey ? this.maskKey(nextKey.key) : null,
      reason
    });
    this.emit('keysUpdated', this.getKeys());
    return nextKey;
  }

  /**
   * Record successful image compression usage on a key
   */
  recordUsage(apiKey, savedBytes = 0) {
    const keyObj = this.getKey(apiKey);
    if (!keyObj) return;

    const remaining = keyObj.creditsRemaining !== null ? Math.max(0, keyObj.creditsRemaining - 1) : null;
    const newStatus = remaining === 0 ? 'EXHAUSTED' : keyObj.status === 'READY' ? 'ACTIVE' : keyObj.status;

    this.stateStore.updateKey(apiKey, {
      lifetimeImages: (keyObj.lifetimeImages || 0) + 1,
      lifetimeSavedBytes: (keyObj.lifetimeSavedBytes || 0) + savedBytes,
      creditsRemaining: remaining,
      status: newStatus,
      lastUsed: new Date().toISOString()
    });

    if (newStatus === 'EXHAUSTED') {
      this.markKeyExhausted(apiKey, 'Credits reached zero');
    }
  }

  /**
   * Mask API key for logs and UI display (e.g. abcd****efgh)
   */
  maskKey(keyStr) {
    if (!keyStr) return '';
    const clean = keyStr.trim();
    if (clean.length <= 8) return '****' + clean.slice(-2);
    return `${clean.slice(0, 4)}...${clean.slice(-4)}`;
  }
}
