import fs from 'fs';
import EventEmitter from 'events';
import { ShortPixelClient } from './shortpixel-client.js';

export class KeyManager extends EventEmitter {
  constructor(stateStore, client = null) {
    super();
    this.stateStore = stateStore;
    this.client = client || new ShortPixelClient();
    this.currentKeyIndex = 0;
  }

  /**
   * Load keys from a text file (one key per line)
   */
  loadKeysFromFile(filePath) {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));

    return this.stateStore.setKeys(lines);
  }

  /**
   * Get all registered keys with their status
   */
  getKeys() {
    return this.stateStore.getKeys();
  }

  /**
   * Add a single API key to the pool
   */
  async addKey(apiKey, verify = true) {
    const keyObj = this.stateStore.addKey(apiKey);
    if (!keyObj) return null;

    if (verify) {
      await this.refreshKeyStatus(apiKey);
    }

    this.emit('keysUpdated', this.getKeys());
    return this.getKey(apiKey);
  }

  /**
   * Remove a key from pool
   */
  removeKey(apiKey) {
    this.stateStore.removeKey(apiKey);
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
   * Get the current active key or automatically find the next available healthy key
   */
  getActiveKey() {
    const keys = this.getKeys();
    if (!keys || keys.length === 0) {
      return null;
    }

    // Try current index first
    const current = keys[this.currentKeyIndex];
    if (current && this.isKeyUsable(current)) {
      return current;
    }

    // Find next usable key starting from index 0
    for (let i = 0; i < keys.length; i++) {
      const candidate = keys[i];
      if (this.isKeyUsable(candidate)) {
        this.currentKeyIndex = i;
        return candidate;
      }
    }

    return null;
  }

  /**
   * Check if a key is eligible to process requests
   */
  isKeyUsable(keyObj) {
    if (!keyObj) return false;
    if (keyObj.status === 'INVALID' || keyObj.status === 'EXHAUSTED') {
      return false;
    }
    // If credits are known and 0, mark exhausted
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
    // Rotate to next key
    const nextKey = this.rotateToNextKey();

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

    const nextKey = this.rotateToNextKey();
    this.emit('keyRotated', {
      previousKey: this.maskKey(apiKey),
      nextKey: nextKey ? this.maskKey(nextKey.key) : null,
      reason
    });
    this.emit('keysUpdated', this.getKeys());
    return nextKey;
  }

  /**
   * Explicitly rotate pointer to next usable key
   */
  rotateToNextKey() {
    const keys = this.getKeys();
    if (keys.length === 0) return null;

    for (let step = 1; step <= keys.length; step++) {
      const nextIdx = (this.currentKeyIndex + step) % keys.length;
      const candidate = keys[nextIdx];
      if (this.isKeyUsable(candidate)) {
        this.currentKeyIndex = nextIdx;
        console.log(`[KeyManager] Rotated to key: ${this.maskKey(candidate.key)} (Index ${nextIdx + 1}/${keys.length})`);
        return candidate;
      }
    }

    console.warn('[KeyManager] ALL KEYS EXHAUSTED! No usable keys remaining in the pool.');
    this.emit('allKeysExhausted');
    return null;
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
