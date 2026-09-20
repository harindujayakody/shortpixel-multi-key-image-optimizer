import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.pdf'
]);

/**
 * Calculate MD5 hash of a file for identity & deduplication
 */
export async function getFileHash(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', err => reject(err));
  });
}

/**
 * Check if a file is a supported image/file
 */
export function isSupportedFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SUPPORTED_EXTENSIONS.has(ext);
}

/**
 * Recursively find all supported image files in a directory
 */
export async function scanDirectory(dirPath, options = {}) {
  const { recursive = true, maxDepth = 20, currentDepth = 0 } = options;
  const results = [];

  if (!fs.existsSync(dirPath)) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }

  const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    
    // Skip hidden files/dirs, node_modules, .git, etc.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') {
      continue;
    }

    if (entry.isDirectory()) {
      if (recursive && currentDepth < maxDepth) {
        const subFiles = await scanDirectory(fullPath, {
          recursive,
          maxDepth,
          currentDepth: currentDepth + 1
        });
        results.push(...subFiles);
      }
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      const stats = await fs.promises.stat(fullPath);
      results.push({
        name: entry.name,
        fullPath: path.resolve(fullPath),
        relativePath: path.relative(dirPath, fullPath),
        size: stats.size,
        mtime: stats.mtimeMs
      });
    }
  }

  return results;
}

/**
 * Format bytes into human readable format (KB, MB, GB)
 */
export function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Ensure directory exists
 */
export async function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    await fs.promises.mkdir(dirPath, { recursive: true });
  }
}
