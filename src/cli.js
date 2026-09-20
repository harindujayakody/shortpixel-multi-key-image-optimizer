#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import path from 'path';
import fs from 'fs';
import { StateStore } from './core/state-store.js';
import { KeyManager } from './core/key-manager.js';
import { OptimizerQueue } from './core/optimizer-queue.js';
import { ShortPixelClient } from './core/shortpixel-client.js';
import { scanDirectory, formatBytes } from './core/file-utils.js';

const program = new Command();
const stateStore = new StateStore('./shortpixel_state.json');
const client = new ShortPixelClient();
const keyManager = new KeyManager(stateStore, client);
const queue = new OptimizerQueue(stateStore, keyManager, client);

program
  .name('shortpixel-opt')
  .description('ShortPixel Multi-Key Image Optimizer CLI with Auto-Rotation and State Persistence')
  .version('1.0.0');

// ---- Command: optimize ----
program
  .command('optimize')
  .description('Optimize images from a folder or list of files')
  .option('-i, --input <path>', 'Input folder or image file path')
  .option('-o, --output <path>', 'Output directory', './optimized')
  .option('-k, --keys <path>', 'Path to keys text file (one key per line)', './keys.txt')
  .option('-l, --lossy <level>', 'Compression: 1 (lossy), 2 (glossy), 0 (lossless)', '1')
  .option('--webp', 'Generate WebP image alongside', false)
  .option('--avif', 'Generate AVIF image alongside', false)
  .option('-c, --concurrency <num>', 'Concurrent requests', '2')
  .action(async options => {
    console.log(chalk.cyan.bold('\n--- ShortPixel Image Optimizer ---'));

    // Load keys
    if (options.keys && fs.existsSync(options.keys)) {
      console.log(chalk.dim(`Loading keys from ${options.keys}...`));
      keyManager.loadKeysFromFile(options.keys);
    }

    const keys = keyManager.getKeys();
    if (keys.length === 0) {
      console.log(chalk.red('\nError: No API keys found. Please provide keys via -k <path> or add keys to keys.txt.'));
      process.exit(1);
    }

    console.log(chalk.white(`API Key Pool: `) + chalk.yellow(`${keys.length} key(s) registered`));

    // Update settings
    stateStore.updateSettings({
      lossy: parseInt(options.lossy, 10),
      outputDir: options.output,
      convertToWebP: !!options.webp,
      convertToAVIF: !!options.avif,
      concurrency: parseInt(options.concurrency, 10)
    });

    if (!options.input) {
      console.log(chalk.red('\nError: Input path is required (-i / --input <path>)'));
      process.exit(1);
    }

    const inputPath = path.resolve(options.input);
    if (!fs.existsSync(inputPath)) {
      console.log(chalk.red(`\nError: Input path does not exist: ${inputPath}`));
      process.exit(1);
    }

    const isDir = fs.statSync(inputPath).isDirectory();
    let filesToQueue = [];

    if (isDir) {
      console.log(chalk.dim(`Scanning directory: ${inputPath}...`));
      filesToQueue = await scanDirectory(inputPath, { recursive: true });
    } else {
      const stats = fs.statSync(inputPath);
      filesToQueue = [{
        name: path.basename(inputPath),
        fullPath: inputPath,
        relativePath: path.basename(inputPath),
        size: stats.size
      }];
    }

    if (filesToQueue.length === 0) {
      console.log(chalk.yellow('\nNo supported image files found in input path.'));
      process.exit(0);
    }

    const added = stateStore.addToQueue(filesToQueue);
    console.log(chalk.green(`Queued ${added.length} image(s) for optimization.`));

    // Setup CLI progress listeners
    queue.on('itemStarted', ({ item }) => {
      process.stdout.write(chalk.dim(`\n[Optimizing] ${item.fileName}... `));
    });

    queue.on('itemCompleted', ({ item }) => {
      if (item.status === 'SKIPPED') {
        console.log(chalk.yellow(`[SKIPPED - Already Optimized]`));
      } else {
        console.log(
          chalk.green.bold(`✓ -${item.percentImprovement}% `) +
          chalk.dim(`(${formatBytes(item.savedBytes)} saved, key: ${item.keyUsed})`)
        );
      }
    });

    queue.on('itemFailed', ({ item, error }) => {
      console.log(chalk.red.bold(`✗ FAILED: ${error}`));
    });

    queue.on('keyRotated', ({ oldKey, newKey, reason }) => {
      console.log(
        chalk.yellow.bold(`\n>> [AUTO-ROTATION] Key ${oldKey} exhausted -> Swapped to ${newKey || 'NONE'}`)
      );
    });

    queue.on('allKeysExhausted', () => {
      console.log(chalk.red.bold('\n>> [ERROR] All API keys in the pool are exhausted!'));
    });

    queue.on('queueCompleted', ({ stats }) => {
      console.log(chalk.green.bold('\n============================================='));
      console.log(chalk.green.bold('  Batch Optimization Completed!'));
      console.log(chalk.green.bold('============================================='));
      console.log(chalk.white(`  Total Processed : `) + chalk.cyan(stats.totalProcessed));
      console.log(chalk.white(`  Total Saved     : `) + chalk.emerald?.bold?.(formatBytes(stats.totalSavedBytes)) || formatBytes(stats.totalSavedBytes));
      console.log(chalk.white(`  Average Ratio   : `) + chalk.yellow(`${stats.overallRatio}%`));
      console.log(chalk.white(`  Output Folder   : `) + chalk.dim(path.resolve(options.output)));
      console.log(chalk.green.bold('=============================================\n'));
      process.exit(0);
    });

    // Start processing
    queue.start();
  });

// ---- Command: keys / check-keys ----
program
  .command('keys')
  .description('List and check status of all API keys in the pool')
  .option('-k, --keys <path>', 'Path to keys text file', './keys.txt')
  .option('-r, --refresh', 'Refresh live balance with ShortPixel API', false)
  .action(async options => {
    if (options.keys && fs.existsSync(options.keys)) {
      keyManager.loadKeysFromFile(options.keys);
    }

    const keys = keyManager.getKeys();
    if (keys.length === 0) {
      console.log(chalk.yellow('\nNo API keys in pool. Create keys.txt with your ShortPixel API keys.'));
      process.exit(0);
    }

    console.log(chalk.cyan.bold(`\nShortPixel API Key Pool (${keys.length} keys total):`));

    if (options.refresh) {
      process.stdout.write(chalk.dim('Refreshing live balances with ShortPixel API... '));
      await keyManager.refreshAllKeys();
      console.log(chalk.green('Done.\n'));
    }

    console.log('----------------------------------------------------------------------');
    console.log(
      'Key           | Status     | Credits Left | Images Done | Data Saved'
    );
    console.log('----------------------------------------------------------------------');

    keyManager.getKeys().forEach(k => {
      const masked = keyManager.maskKey(k.key).padEnd(13, ' ');
      const status = (k.status || 'READY').padEnd(10, ' ');
      const credits = (k.creditsRemaining !== null ? String(k.creditsRemaining) : 'Unchecked').padEnd(12, ' ');
      const images = String(k.lifetimeImages || 0).padEnd(11, ' ');
      const saved = formatBytes(k.lifetimeSavedBytes || 0);

      const statusColored =
        k.status === 'ACTIVE'
          ? chalk.green(status)
          : k.status === 'EXHAUSTED'
          ? chalk.red(status)
          : chalk.cyan(status);

      console.log(`${masked} | ${statusColored} | ${credits} | ${images} | ${saved}`);
    });
    console.log('----------------------------------------------------------------------\n');
  });

// ---- Command: stats ----
program
  .command('stats')
  .description('Show persistent compression statistics and lifetime savings')
  .action(() => {
    const stats = stateStore.getStats();
    console.log(chalk.cyan.bold('\n--- ShortPixel Optimizer Persistent Stats ---'));
    console.log(`Total Images Processed : ${chalk.green(stats.totalProcessed)}`);
    console.log(`Total Storage Saved    : ${chalk.green.bold(formatBytes(stats.totalSavedBytes))}`);
    console.log(`Total Original Data    : ${chalk.dim(formatBytes(stats.totalOriginalBytes))}`);
    console.log(`Overall Reduction      : ${chalk.yellow(stats.overallRatio + '%')}`);
    console.log(`Queue Status           : ${stats.pendingCount} pending, ${stats.processingCount} processing, ${stats.completedCount} completed\n`);
  });

// ---- Command: resume ----
program
  .command('resume')
  .description('Resume previous paused or interrupted optimization job')
  .action(() => {
    const stats = stateStore.getStats();
    if (stats.pendingCount === 0) {
      console.log(chalk.yellow('\nNo pending items in queue to resume.'));
      process.exit(0);
    }
    console.log(chalk.green(`\nResuming queue with ${stats.pendingCount} pending items...`));
    queue.resume();
  });

program.parse(process.argv);
