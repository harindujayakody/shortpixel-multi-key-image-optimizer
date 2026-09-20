import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { StateStore } from '../src/core/state-store.js';
import { KeyManager } from '../src/core/key-manager.js';
import { ProxyManager } from '../src/core/proxy-manager.js';
import { ShortPixelError } from '../src/core/shortpixel-client.js';

async function runTests() {
  console.log('--- Running Studio v2.0 Test Suite ---');
  const testStateFile = './test/test_state.json';
  const testKeysFile = './test/test_keys.txt';
  const testProxiesFile = './test/test_proxies.txt';

  if (!fs.existsSync('./test')) fs.mkdirSync('./test');
  if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);
  if (fs.existsSync(testKeysFile)) fs.unlinkSync(testKeysFile);
  if (fs.existsSync(testProxiesFile)) fs.unlinkSync(testProxiesFile);

  // 1. Test StateStore persistence
  console.log('1. Testing StateStore & Output location settings...');
  const store = new StateStore(testStateFile);
  store.updateSettings({
    lossy: 1,
    outputLocationMode: 'source_folder',
    keyRotationStrategy: 'random'
  });
  store.setKeys(['key_alpha_123', 'key_beta_456', 'key_gamma_789']);

  const reloadedStore = new StateStore(testStateFile);
  assert.strictEqual(reloadedStore.getSettings().outputLocationMode, 'source_folder');
  assert.strictEqual(reloadedStore.getSettings().keyRotationStrategy, 'random');
  assert.strictEqual(reloadedStore.getKeys().length, 3);
  console.log('✓ StateStore settings & keys persistence verified.');

  // 2. Test KeyManager load balancing & keys.txt sync
  console.log('\n2. Testing KeyManager load balancing & keys.txt sync...');
  const mockClient = {
    async checkKeyStatus(key) {
      if (key === 'key_alpha_123') return { key, valid: true, status: 'ACTIVE', creditsRemaining: 0 };
      if (key === 'key_beta_456') return { key, valid: true, status: 'ACTIVE', creditsRemaining: 50 };
      return { key, valid: true, status: 'ACTIVE', creditsRemaining: 100 };
    }
  };

  const keyMgr = new KeyManager(reloadedStore, mockClient, testKeysFile);
  await keyMgr.refreshKeyStatus('key_alpha_123');
  await keyMgr.refreshKeyStatus('key_beta_456');
  await keyMgr.refreshKeyStatus('key_gamma_789');

  keyMgr.syncKeysToFile();
  assert.strictEqual(fs.existsSync(testKeysFile), true, 'keys.txt should be written on sync');
  const writtenKeys = fs.readFileSync(testKeysFile, 'utf8');
  assert.strictEqual(writtenKeys.includes('key_beta_456'), true, 'keys.txt should contain active keys');
  console.log('✓ keys.txt synchronization verified.');

  // Test load balancing selection (should pick between beta and gamma, skipping exhausted alpha)
  const activeKey = keyMgr.getActiveKey();
  assert.ok(
    activeKey.key === 'key_beta_456' || activeKey.key === 'key_gamma_789',
    'Active key should be selected from usable pool'
  );
  console.log(`✓ Load balancer picked: ${keyMgr.maskKey(activeKey.key)}`);

  // 3. Test ProxyManager
  console.log('\n3. Testing ProxyManager & Agent Creation...');
  const proxyMgr = new ProxyManager(reloadedStore, testProxiesFile);
  const p1 = proxyMgr.addProxy('http://proxy.example.com:8080', false);
  const p2 = proxyMgr.addProxy('socks5://user:pass@127.0.0.1:1080', false);

  assert.strictEqual(proxyMgr.getProxies().length, 2);
  const httpAgent = proxyMgr.createAgent(p1.url);
  assert.ok(httpAgent, 'Should create HttpsProxyAgent');

  const socksAgent = proxyMgr.createAgent(p2.url);
  assert.ok(socksAgent, 'Should create SocksProxyAgent');
  console.log('✓ Proxy manager agents verified.');

  // 4. Test Error Classification
  console.log('\n4. Testing Error Classification...');
  const quotaErr = new ShortPixelError('Monthly quota limit exceeded', -102);
  assert.strictEqual(quotaErr.isQuotaExceeded, true);

  const invalidErr = new ShortPixelError('Invalid API Key provided', -101);
  assert.strictEqual(invalidErr.isInvalidKey, true);
  console.log('✓ ShortPixel error classification verified.');

  // Clean up test files
  if (fs.existsSync(testStateFile)) fs.unlinkSync(testStateFile);
  if (fs.existsSync(testKeysFile)) fs.unlinkSync(testKeysFile);
  if (fs.existsSync(testProxiesFile)) fs.unlinkSync(testProxiesFile);

  console.log('\n=============================================');
  console.log('  ALL STUDIO v2.0 TESTS PASSED WITH 100%!   ');
  console.log('=============================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
