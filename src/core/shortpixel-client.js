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
      // First try JSON POST to api-status.php
      const res = await axios.post(
        SHORTPIXEL_ENDPOINTS.API_STATUS,
        { key },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 15000,
          validateStatus: () => true
        }
      );

      let data = res.data;

      // Some endpoints return stringified JSON or plain text
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch {
          // not JSON
        }
      }

      if (data && typeof data === 'object') {
        const statusCode = data.Status?.Code ?? data.Status ?? 0;
        const message = data.Status?.Message ?? data.Message ?? 'OK';

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

        // Calculate total remaining credits
        const monthly = parseInt(data.MonthlyCreditsRemaining ?? data.MonthlyCredits ?? 0, 10) || 0;
        const purchased = parseInt(data.PurchasedCreditsRemaining ?? data.PurchasedCredits ?? 0, 10) || 0;
        const totalRemaining = parseInt(
          data.CreditsRemaining ?? data.TotalCreditsRemaining ?? (monthly + purchased),
          10
        );

        const totalCredits = parseInt(data.CreditsTotal ?? data.TotalCredits ?? 0, 10);
        const callsMade = parseInt(data.APICallsMade ?? data.CallsMade ?? 0, 10);

        return {
          key,
          valid: true,
          status: totalRemaining > 0 ? 'ACTIVE' : 'EXHAUSTED',
          creditsRemaining: Math.max(0, totalRemaining),
          monthlyCreditsRemaining: monthly,
          purchasedCreditsRemaining: purchased,
          totalCredits,
          callsMade,
          apiKeyType: data.APIKeyType ?? 'free',
          message: totalRemaining > 0 ? 'Available' : 'Quota exhausted',
          raw: data
        };
      }

      // Fallback: If api-status is unavailable, probe with a minimal ping or assume valid
      return {
        key,
        valid: true,
        status: 'READY',
        creditsRemaining: 100, // Default estimate until first compression
        message: 'Key registered (unverified credits)',
        raw: data
      };
    } catch (err) {
      // Network or parsing error
      return {
        key,
        valid: true, // Don't mark invalid on network blip
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
      wait = 30
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
      const response = await axios.post(SHORTPIXEL_ENDPOINTS.POST_REDUCER, form, {
        headers: {
          ...form.getHeaders()
        },
        timeout: this.timeout,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true
      });

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

      // Format successful result
      const originalSize = parseInt(resultItem.OriginalSize ?? 0, 10);
      const compressedSize = parseInt(resultItem.CompressedSize ?? originalSize, 10);
      const percentImprovement = parseFloat(
        resultItem.PercentImprovement ??
          (originalSize > 0 ? (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) : 0)
      );

      return {
        success: true,
        statusCode,
        message: message || 'Optimized successfully',
        originalUrl: resultItem.OriginalURL,
        lossyUrl: resultItem.LossyURL,
        webPUrl: resultItem.WebPURL,
        avifUrl: resultItem.AVIFURL,
        originalSize,
        compressedSize,
        percentImprovement: Math.max(0, percentImprovement),
        savedBytes: Math.max(0, originalSize - compressedSize),
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
          const compressedSize = parseInt(item.CompressedSize ?? originalSize, 10);
          const percentImprovement = parseFloat(
            item.PercentImprovement ??
              (originalSize > 0 ? (((originalSize - compressedSize) / originalSize) * 100).toFixed(2) : 0)
          );

          return {
            success: true,
            statusCode,
            message: item.Status?.Message || 'Optimized successfully',
            originalUrl: item.OriginalURL,
            lossyUrl: item.LossyURL,
            webPUrl: item.WebPURL,
            avifUrl: item.AVIFURL,
            originalSize,
            compressedSize,
            percentImprovement: Math.max(0, percentImprovement),
            savedBytes: Math.max(0, originalSize - compressedSize),
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
  async downloadOptimizedImage(downloadUrl, targetPath) {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    const response = await axios({
      method: 'GET',
      url: downloadUrl,
      responseType: 'stream',
      timeout: 30000
    });

    const writer = fs.createWriteStream(targetPath);
    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => resolve(targetPath));
      writer.on('error', reject);
    });
  }
}
