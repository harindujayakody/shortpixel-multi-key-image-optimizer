import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const SUPPORTED_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.pdf'
]);

export const MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf'
};

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
 * Extract image dimensions (width/height) from binary header
 */
export async function getImageDimensions(filePath) {
  try {
    const buffer = Buffer.alloc(2048);
    const fd = await fs.promises.open(filePath, 'r');
    await fd.read(buffer, 0, 2048, 0);
    await fd.close();

    const ext = path.extname(filePath).toLowerCase();

    // PNG
    if (ext === '.png' && buffer.length > 24) {
      if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20)
        };
      }
    }

    // GIF
    if (ext === '.gif' && buffer.length > 10) {
      if (buffer.toString('ascii', 0, 3) === 'GIF') {
        return {
          width: buffer.readUInt16LE(6),
          height: buffer.readUInt16LE(8)
        };
      }
    }

    // WEBP
    if (ext === '.webp' && buffer.length > 30) {
      if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
        const vp8Type = buffer.toString('ascii', 12, 16);
        if (vp8Type === 'VP8X' && buffer.length > 30) {
          const width = 1 + buffer.readUIntLE(24, 3);
          const height = 1 + buffer.readUIntLE(27, 3);
          return { width, height };
        } else if (vp8Type === 'VP8 ' && buffer.length > 30) {
          const width = (buffer.readUInt16LE(26) & 0x3fff);
          const height = (buffer.readUInt16LE(28) & 0x3fff);
          return { width, height };
        }
      }
    }

    // JPEG
    if (ext === '.jpg' || ext === '.jpeg') {
      let offset = 2;
      while (offset < buffer.length - 8) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker === 0xc0 || marker === 0xc2) { // SOF0 or SOF2
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7)
          };
        }
        const len = buffer.readUInt16BE(offset + 2);
        offset += 2 + len;
      }
    }
  } catch {}

  return { width: null, height: null };
}

/**
 * Recursively find all supported image files in a directory with metadata
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
      const ext = path.extname(entry.name).toLowerCase();
      const dims = await getImageDimensions(fullPath);

      results.push({
        name: entry.name,
        fullPath: path.resolve(fullPath),
        relativePath: path.relative(dirPath, fullPath),
        sourceDir: path.dirname(path.resolve(fullPath)),
        size: stats.size,
        mimeType: MIME_MAP[ext] || 'image/*',
        width: dims.width,
        height: dims.height,
        mtime: stats.mtimeMs
      });
    }
  }

  return results;
}

/**
 * Format bytes into human readable format (KB, MB, GB)
 */
export function formatBytes(bytes, decimals = 1) {
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
