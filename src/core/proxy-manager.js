import fs from 'fs';
import EventEmitter from 'events';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export class ProxyManager extends EventEmitter {
  constructor(stateStore, proxiesFilePath = './proxies.txt') {
    super();
    this.stateStore = stateStore;
    this.proxiesFilePath = proxiesFilePath;
    this.currentIndex = 0;
  }

  /**
   * Load proxies from proxies.txt if exists
   */
  loadProxiesFromFile(filePath = this.proxiesFilePath) {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith('#'));

      const proxies = lines.map((proxyStr, idx) => ({
        id: `proxy_${Date.now()}_${idx}`,
        url: proxyStr,
        protocol: proxyStr.startsWith('socks') ? 'socks' : (proxyStr.startsWith('https') ? 'https' : 'http'),
        status: 'READY',
        latency: null,
        lastChecked: null,
        error: null
      }));

      this.stateStore.setProxies(proxies);
      return proxies;
    } catch (err) {
      console.error(`[ProxyManager] Error reading proxies file: ${err.message}`);
      return [];
    }
  }

  /**
   * Save current proxies back to proxies.txt
   */
  syncProxiesToFile(filePath = this.proxiesFilePath) {
    try {
      const proxies = this.getProxies();
      const content = proxies.map(p => p.url).join('\n') + '\n';
      fs.writeFileSync(filePath, content, 'utf8');
    } catch (err) {
      console.error(`[ProxyManager] Error syncing proxies to file: ${err.message}`);
    }
  }

  getProxies() {
    return this.stateStore.getProxies();
  }

  /**
   * Normalize any proxy format:
   * - ip:port -> http://ip:port
   * - ip:port:user:pass -> http://user:pass@ip:port
   * - user:pass@ip:port -> http://user:pass@ip:port
   * - socks5://ip:port
   */
  normalizeProxy(rawInput) {
    if (!rawInput || typeof rawInput !== 'string') return null;
    let str = rawInput.trim();
    if (!str) return null;

    let scheme = 'http';
    if (str.includes('://')) {
      const parts = str.split('://');
      scheme = parts[0];
      str = parts[1];
    }

    // Check if format is ip:port:user:pass
    const colonSegments = str.split(':');
    if (colonSegments.length === 4) {
      const [host, port, user, pass] = colonSegments;
      return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
    }

    // Standard host:port or user:pass@host:port
    return `${scheme}://${str}`;
  }

  addProxy(proxyUrl, verify = true) {
    const cleanUrl = this.normalizeProxy(proxyUrl);
    if (!cleanUrl) return null;

    const existing = this.getProxies().find(p => p.url === cleanUrl);
    if (existing) return existing;

    const protocol = cleanUrl.startsWith('socks') ? 'socks' : (cleanUrl.startsWith('https') ? 'https' : 'http');
    const proxyObj = {
      id: `proxy_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      url: cleanUrl,
      protocol,
      status: 'READY',
      latency: null,
      lastChecked: null,
      error: null
    };

    this.stateStore.addProxy(proxyObj);
    this.syncProxiesToFile();

    if (verify) {
      this.testProxy(proxyObj.id);
    }

    this.emit('proxiesUpdated', this.getProxies());
    return proxyObj;
  }

  removeProxy(proxyId) {
    this.stateStore.removeProxy(proxyId);
    this.syncProxiesToFile();
    this.emit('proxiesUpdated', this.getProxies());
  }

  /**
   * Test proxy connection and measure latency
   */
  async testProxy(proxyId) {
    const proxy = this.getProxies().find(p => p.id === proxyId);
    if (!proxy) return null;

    const startTime = Date.now();
    try {
      const agent = this.createAgent(proxy.url);
      const res = await axios.get('https://api.shortpixel.com/v2/api-status.php', {
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 10000,
        validateStatus: () => true
      });

      const latency = Date.now() - startTime;
      const updates = {
        status: res.status < 500 ? 'ACTIVE' : 'ERROR',
        latency,
        lastChecked: new Date().toISOString(),
        error: res.status >= 500 ? `HTTP ${res.status}` : null
      };

      this.stateStore.updateProxy(proxyId, updates);
      this.emit('proxiesUpdated', this.getProxies());
      return { success: true, latency, status: updates.status };
    } catch (err) {
      const updates = {
        status: 'OFFLINE',
        latency: null,
        lastChecked: new Date().toISOString(),
        error: err.message
      };
      this.stateStore.updateProxy(proxyId, updates);
      this.emit('proxiesUpdated', this.getProxies());
      return { success: false, error: err.message };
    }
  }

  /**
   * Test all proxies in the pool
   */
  async testAllProxies() {
    const proxies = this.getProxies();
    const results = [];
    for (const p of proxies) {
      results.push(await this.testProxy(p.id));
    }
    return results;
  }

  /**
   * Get the next proxy based on rotation strategy (random or round-robin)
   */
  getNextProxy() {
    const proxies = this.getProxies().filter(p => p.status !== 'OFFLINE');
    if (proxies.length === 0) return null;

    const settings = this.stateStore.getSettings();
    if (!settings.useProxy) return null;

    if (settings.proxyStrategy === 'random') {
      const randomIdx = Math.floor(Math.random() * proxies.length);
      return proxies[randomIdx];
    }

    // Default: Round-robin
    this.currentIndex = (this.currentIndex + 1) % proxies.length;
    return proxies[this.currentIndex];
  }

  /**
   * Create an Axios HTTP/HTTPS agent for a given proxy URL
   */
  createAgent(proxyUrl) {
    if (!proxyUrl) return null;

    let formattedUrl = proxyUrl;
    if (!formattedUrl.includes('://')) {
      formattedUrl = `http://${formattedUrl}`;
    }

    if (formattedUrl.startsWith('socks')) {
      return new SocksProxyAgent(formattedUrl);
    }

    return new HttpsProxyAgent(formattedUrl);
  }
}
