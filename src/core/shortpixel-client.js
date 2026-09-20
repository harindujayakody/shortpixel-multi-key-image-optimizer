import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';

export const SHORTPIXEL_ENDPOINTS = {
  REDUCER: 'https://api.shortpixel.com/v2/reducer.php',
  POST_REDUCER: 'https://api.shortpixel.com/v2/post-reducer.php',
  API_STATUS: 'https://api.shortpixel.com/v2/api-status.php',
  IMAGE_STATUS: 'https://api.shortpixel.com/v2/image-status.php'
};

export class ShortPixelError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'ShortPixelError';
    this.code = code;
    this.details = details;
    this.isQuotaExceeded = code === -102 || /quota|credit|limit/i.test(message);
    this.isInvalidKey = code === -101 || /invalid\s*(api)?\s*key/i.test(message);
  }
}

export class ShortPixelClient {
  constructor(options = {}) {
    this.timeout = options.timeout || 60000;
  }

  /**
   * Check status and remaining credits for a given API Key
   */
  async checkKeyStatus(apiKey) {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
      return {
        key: apiKey,
        valid: false,
        status: 'INVALID',
        creditsRemaining: 0,
        message: 'Empty or missing API Key'
      };
    }

    const key = apiKey.trim();

    try {
      // ShortPixel api-status.php requires application/x-www-form-urlencoded
      const params = new URLSearchParams();
      params.append('key', key);

      const res = await axios.post(
        SHORTPIXEL_ENDPOINTS.API_STATUS,
        params.toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000,
          validateStatus: () => true
        }
      );

      let data = res.data;

      // Parse string if needed
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // not JSON
        }
      }

      if (data && typeof data === 'object') {
        const rawCode = data.Status?.Code ?? data.Status ?? 0;
        const statusCode = parseInt(rawCode, 10);
        const message = data.Status?.Message ?? data.Message ?? 'OK';

        // Error codes from ShortPixel are negative numbers (e.g. -101 Invalid, -102 Quota)
        if (statusCode < 0) {
          const isQuota = statusCode === -102 || /quota|credit/i.test(message);
          const isInvalid = statusCode === -101 || /invalid/i.test(message);

          return {
            key,
            valid: !isInvalid,
            status: isInvalid ? 'INVALID' : (isQuota ? 'EXHAUSTED' : 'ERROR'),
            creditsRemaining: 0,
            message: message || `Error code ${statusCode}`,
            raw: data
          };
        }

        // Status Code 2 or 1 or 0 means success
        if (data.Unlimited === true) {
          return {
            key,
            valid: true,
            status: 'ACTIVE',
            creditsRemaining: 999999,
            totalCredits: 999999,
            apiKeyType: data.PlanCode || 'unlimited',
            message: 'Unlimited Credits',
            raw: data
          };
        }

        // Compute remaining credits from ShortPixel quota & usage metrics
        const monthlyQuota = parseInt(data.APICallsQuota ?? data.MonthlyCredits ?? 0, 10) || 0;
        const monthlyMade = Math.floor(parseFloat(data.APICallsMade ?? 0)) || 0;
        const monthlyRemaining = Math.max(0, monthlyQuota - monthlyMade);

        const oneTimeQuota = Math.floor(parseFloat(data.APICallsQuotaOneTime ?? data.PurchasedCredits ?? 0)) || 0;
        const oneTimeMade = Math.floor(parseFloat(data.APICallsMadeOneTime ?? 0)) || 0;
        const oneTimeRemaining = Math.max(0, oneTimeQuota - oneTimeMade);

        let totalRemaining = monthlyRemaining + oneTimeRemaining;
        if (data.APICallsRemaining !== undefined) {
          totalRemaining = parseInt(data.APICallsRemaining, 10);
        } else if (data.CreditsRemaining !== undefined) {
          totalRemaining = parseInt(data.CreditsRemaining, 10);
        }

        const totalCredits = monthlyQuota + oneTimeQuota;

        return {
          key,
          valid: true,
          status: totalRemaining > 0 ? 'ACTIVE' : 'EXHAUSTED',
          creditsRemaining: Math.max(0, totalRemaining),
          monthlyCreditsRemaining: monthlyRemaining,
          purchasedCreditsRemaining: oneTimeRemaining,
          totalCredits,
          callsMade: monthlyMade + oneTimeMade,
          apiKeyType: data.PlanCode || data.PlanType || 'free',
          message: totalRemaining > 0 ? `${totalRemaining} credits available` : 'Quota exhausted',
          raw: data
        };
      }

      // Fallback
      return {
        key,
        valid: true,
        status: 'READY',
        creditsRemaining: 100,
        message: 'Key registered',
        raw: data
      };
    } catch (err) {
      return {
        key,
        valid: true,
        status: 'READY',
        creditsRemaining: 0,
        message: `Status check warning: ${err.message}`
      };
    }
  }

  /**
   * Optimize a local image file using ShortPixel post-reducer.php
   */
  async optimizeLocalFile(filePath, apiKey, options = {}) {
    const {
      lossy = 1, // 1: Lossy, 2: Glossy, 0: Lossless
      keepExif = 1,
      convertTo = null, // 'webp', 'avif', '+webp', '+avif'
      resize = null, // { width, height, type: 'inner' | 'outer' }
      wait = 30,
      proxyAgent = null
    } = options;

    if (!fs.existsSync(filePath)) {
      throw new ShortPixelError(`File not found: ${filePath}`, -1);
    }

    const fileName = path.basename(filePath);
    const form = new FormData();

    form.append('key', apiKey.trim());
    form.append('lossy', String(lossy));
    form.append('wait', String(wait));
    form.append('keep_exif', String(keepExif));

    if (convertTo) {
      form.append('convertto', convertTo);
    }

    if (resize && resize.width && resize.height) {
      form.append('resize', resize.type === 'inner' ? '3' : '1');
      form.append('resize_width', String(resize.width));
      form.append('resize_height', String(resize.height));
    }

    // file_paths mapping
    const filePaths = { file1: fileName };
    form.append('file_paths', JSON.stringify(filePaths));
    form.append('file1', fs.createReadStream(filePath));

    try {
      const axiosConfig = {
        headers: {
          ...form.getHeaders()
        },
        timeout: this.timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
      };

      if (proxyAgent) {
        axiosConfig.httpsAgent = proxyAgent;
        axiosConfig.httpAgent = proxyAgent;
      }

      const response = await axios.post(SHORTPIXEL_ENDPOINTS.POST_REDUCER, form, axiosConfig);

      let data = response.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // not json
        }
      }

      // Check if response is error array or object
      let resultItem = null;
      if (Array.isArray(data)) {
        resultItem = data[0];
      } else if (data && typeof data === 'object') {
        resultItem = data;
      } else {
        throw new ShortPixelError(`Unexpected API response: ${response.data}`, -1);
      }

      const statusCode = resultItem.Status?.Code ?? resultItem.Status ?? 0;
      const message = resultItem.Status?.Message ?? resultItem.Message ?? '';

      // Check status code
      if (statusCode < 0) {
        throw new ShortPixelError(message || `API error code ${statusCode}`, statusCode, resultItem);
      }

      // Status 1 = pending processing, Status 2 = success, Status 0 = unchanged
      if (statusCode === 1) {
        // Poll for completion if pending
        return await this.pollPendingImage(resultItem.OriginalURL || fileName, apiKey, wait);
      }

      // Format successful result: ShortPixel returns LossySize, LosslessSize
      const originalSize = parseInt(resultItem.OriginalSize ?? 0, 10);
      const rawCompressed = (lossy === 0)
        ? (resultItem.LosslessSize ?? resultItem.LoselessSize ?? resultItem.LossySize)
        : (resultItem.LossySize ?? resultItem.GlossySize ?? resultItem.LosslessSize ?? resultItem.LoselessSize);

      let compressedSize = parseInt(rawCompressed, 10);
      const percentImprovement = parseFloat(
        resultItem.PercentImprovement ??
          (originalSize > 0 && !isNaN(compressedSize) ? (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) : 0)
      );

      if (isNaN(compressedSize) || compressedSize <= 0) {
        if (percentImprovement > 0 && originalSize > 0) {
          compressedSize = Math.round(originalSize * (1 - (percentImprovement / 100)));
        } else {
          compressedSize = originalSize;
        }
      }

      const savedBytes = Math.max(0, originalSize - compressedSize);

      return {
        success: true,
        statusCode,
        message: message || 'Optimized successfully',
        originalUrl: resultItem.OriginalURL,
        lossyUrl: resultItem.LossyURL,
        webPUrl: resultItem.WebPURL !== 'NA' ? resultItem.WebPURL : null,
        avifUrl: resultItem.AVIFURL !== 'NA' ? resultItem.AVIFURL : null,
        originalSize,
        compressedSize,
        percentImprovement: Math.max(0, percentImprovement),
        savedBytes,
        keyUsed: apiKey,
        raw: resultItem
      };
    } catch (err) {
      if (err instanceof ShortPixelError) throw err;
      throw new ShortPixelError(err.message, -999, { originalError: err });
    }
  }

  /**
   * Poll pending image status until finished or timeout
   */
  async pollPendingImage(imageUrl, apiKey, maxWait = 30) {
    const startTime = Date.now();
    const interval = 2000;

    while (Date.now() - startTime < maxWait * 1000) {
      await new Promise(r => setTimeout(r, interval));

      try {
        const res = await axios.post(
          SHORTPIXEL_ENDPOINTS.REDUCER,
          {
            key: apiKey.trim(),
            urllist: [imageUrl]
          },
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000,
            validateStatus: () => true
          }
        );

        let data = res.data;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch {}
        }

        const item = Array.isArray(data) ? data[0] : data;
        if (!item) continue;

        const statusCode = item.Status?.Code ?? item.Status ?? 0;
        if (statusCode === 2 || statusCode === 0) {
          const originalSize = parseInt(item.OriginalSize ?? 0, 10);
          const rawCompressed = item.LossySize ?? item.GlossySize ?? item.LosslessSize ?? item.LoselessSize;
          let compressedSize = parseInt(rawCompressed, 10);
          const percentImprovement = parseFloat(
            item.PercentImprovement ??
              (originalSize > 0 && !isNaN(compressedSize) ? (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) : 0)
          );

          if (isNaN(compressedSize) || compressedSize <= 0) {
            if (percentImprovement > 0 && originalSize > 0) {
              compressedSize = Math.round(originalSize * (1 - (percentImprovement / 100)));
            } else {
              compressedSize = originalSize;
            }
          }

          const savedBytes = Math.max(0, originalSize - compressedSize);

          return {
            success: true,
            statusCode,
            message: item.Status?.Message || 'Optimized successfully',
            originalUrl: item.OriginalURL,
            lossyUrl: item.LossyURL,
            webPUrl: item.WebPURL !== 'NA' ? item.WebPURL : null,
            avifUrl: item.AVIFURL !== 'NA' ? item.AVIFURL : null,
            originalSize,
            compressedSize,
            percentImprovement: Math.max(0, percentImprovement),
            savedBytes,
            keyUsed: apiKey,
            raw: item
          };
        } else if (statusCode < 0) {
          throw new ShortPixelError(item.Status?.Message || `Pending failed ${statusCode}`, statusCode, item);
        }
      } catch (err) {
        if (err instanceof ShortPixelError) throw err;
      }
    }

    throw new ShortPixelError('Optimization timed out while waiting for server processing', -108);
  }

  /**
   * Download optimized image binary from ShortPixel URL and save to destination path
   */
  async downloadOptimizedImage(downloadUrl, targetPath, proxyAgent = null) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const axiosConfig = {
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 30000
    };

    if (proxyAgent) {
      axiosConfig.httpsAgent = proxyAgent;
      axiosConfig.httpAgent = proxyAgent;
    }

    const response = await axios(axiosConfig);

    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(targetPath));
      writer.on('error', reject);
    });
  }
}
