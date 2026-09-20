import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { StateStore } from '../src/core/state-store.js';
import { KeyManager } from '../src/core/key-manager.js';
import { ShortPixelError } from '../src/core/shortpixel-client.js';

async function runTests() {
  console.log('--- Running Core Test Suite ---');
  const testStateFile = './test/test_state.json';
  if (!fs.existsSync('./test')) fs.mkdirSync('./test');
  if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);

  // 1. Test StateStore persistence
  console.log('1. Testing StateStore persistence...');
  const store = new StateStore(testStateFile);
  store.updateSettings({ lossy: 2, outputDir: './test_opt' });
  store.setKeys(['key_alpha_123', 'key_beta_456', 'key_gamma_789']);
  
  const reloadedStore = new StateStore(testStateFile);
  assert.strictEqual(reloadedStore.getSettings().lossy, 2, 'Settings should persist to disk');
  assert.strictEqual(reloadedStore.getKeys().length, 3, 'Keys should persist to disk');
  console.log('✓ StateStore persistence passed.');

  // 2. Test KeyManager & Key Auto-Rotation Logic
  console.log('\n2. Testing KeyManager Auto-Rotation...');
  
  // Mock ShortPixel client
  const mockClient = {
    async checkKeyStatus(key) {
      if (key === 'key_alpha_123') return { key, valid: true, status: 'ACTIVE', creditsRemaining: 0 };
      if (key === 'key_beta_456') return { key, valid: true, status: 'ACTIVE', creditsRemaining: 50 };
      return { key, valid: true, status: 'ACTIVE', creditsRemaining: 100 };
    }
  };

  const keyMgr = new KeyManager(reloadedStore, mockClient);
  
  // Alpha has 0 credits, so getActiveKey should automatically skip alpha and pick beta
  await keyMgr.refreshKeyStatus('key_alpha_123');
  await keyMgr.refreshKeyStatus('key_beta_456');

  let active = keyMgr.getActiveKey();
  assert.strictEqual(active.key, 'key_beta_456', 'Should automatically select beta when alpha has 0 credits');
  console.log(`✓ Active key selected: ${keyMgr.maskKey(active.key)}`);

  // Simulate Quota Exhaustion on Beta during compression
  console.log('\n3. Simulating Quota Exhaustion Event...');
  let rotatedEventFired = false;
  keyMgr.on('keyRotated', data => {
    rotatedEventFired = true;
    console.log(`✓ Event emitted: Rotated from ${data.previousKey} to ${data.nextKey} (${data.reason})`);
  });

  const nextKey = keyMgr.markKeyExhausted('key_beta_456', 'Quota exceeded error -102');
  assert.strictEqual(nextKey.key, 'key_gamma_789', 'Should rotate to gamma when beta is exhausted');
  assert.strictEqual(rotatedEventFired, true, 'Rotation event should fire');

  // 4. Test Usage Tracking & Cumulative Stats
  console.log('\n4. Testing Usage Stats Accumulation...');
  keyMgr.recordUsage('key_gamma_789', 50000); // 50KB saved
  const gammaObj = keyMgr.getKey('key_gamma_789');
  assert.strictEqual(gammaObj.lifetimeImages, 1, 'Lifetime images incremented');
  assert.strictEqual(gammaObj.lifetimeSavedBytes, 50000, 'Lifetime saved bytes updated');

  // Record history and verify global stats
  reloadedStore.recordHistory('hash_mock_123', {
    fileName: 'test.jpg',
    originalSize: 100000,
    compressedSize: 50000,
    savedBytes: 50000,
    percentImprovement: 50.0,
    keyUsed: 'key_gamma_789'
  });

  const stats = reloadedStore.getStats();
  assert.strictEqual(stats.totalProcessed, 1);
  assert.strictEqual(stats.totalSavedBytes, 50000);
  assert.strictEqual(stats.overallRatio, 50.0);
  console.log(`✓ Stats verified: Processed: ${stats.totalProcessed}, Saved: ${stats.totalSavedBytes} bytes, Ratio: ${stats.overallRatio}%`);

  // 5. Test ShortPixelError classification
  console.log('\n5. Testing ShortPixelError classification...');
  const quotaErr = new ShortPixelError('Monthly quota limit exceeded', -102);
  assert.strictEqual(quotaErr.isQuotaExceeded, true, 'Should detect quota exceeded error');

  const invalidErr = new ShortPixelError('Invalid API Key provided', -101);
  assert.strictEqual(invalidErr.isInvalidKey, true, 'Should detect invalid API key');
  console.log('✓ Error classification passed.');

  // Clean up test file
  if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);
  console.log('\n========================================');
  console.log('  ALL CORE TESTS PASSED SUCCESSFULLY!  ');
  console.log('========================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
