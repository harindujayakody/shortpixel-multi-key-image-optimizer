# ShortPixel Multi-Key Image Optimizer & Dashboard

A production-ready batch image optimization tool powered by the **ShortPixel Smart Image Compression API**. It features an **API Key Pool with zero-downtime auto-rotation**, persistent disk/memory state, instant **Pause/Resume**, and detailed per-key and batch statistics.

---

## ⚡ Key Highlights

- 🔄 **Multi-Key Pool & Auto-Rotation**: Provide a list of Free / Paid ShortPixel API keys. When one key runs out of free credits or hits quota limits (API Code `-102`), the engine seamlessly switches to the next available key and retries the item immediately without failing.
- 💾 **State Persistence & Memory**: All progress, remaining credits, per-key usage, and file checksums are saved atomically to `shortpixel_state.json`. If you stop the tool or restart your computer, it resumes from the exact state without wasting credits on already-optimized images.
- ⏸️ **Instant Pause / Resume / Stop**: Full control over your optimization queue.
- 📊 **Real-time Statistics**: Shows total images compressed, original vs compressed data size, MB saved, overall compression ratio %, and credits left on every key.
- 🖥️ **Dual Interface**:
  - **Modern Web Dashboard**: Drag-and-drop batch upload, local folder scanner, visual queue table, live Server-Sent Events (SSE) log stream, and ZIP download.
  - **CLI Tool**: Powerful command-line tool for headless servers, scripts, and automation pipelines.

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Configure API Keys (3 Easy Ways)
You can add your Free ShortPixel API keys in any of these ways:
1. **Via `keys.txt`**: Create a `keys.txt` file in the project folder with one API key per line:
   ```text
   apiKey1
   apiKey2
   apiKey3
   ```
2. **Via Web Dashboard**: Open `http://localhost:3000`, click **Add** in the API Key Pool panel, and paste your keys.
3. **Via CLI**: Pass `--keys path/to/keys.txt` when running optimization.

---

## 🌐 Running the Web Dashboard

Start the web server:
```bash
npm start
```
Then visit **`http://localhost:3000`** in your browser.

From the Dashboard you can:
- Drag-and-drop images or PDF files to optimize.
- Enter a local folder path to scan and queue images recursively.
- Monitor remaining credits per API key in real-time.
- Start, Pause, Resume, and Stop batch jobs.
- Download all optimized images as a single `.zip` file.

---

## 💻 CLI Commands

### 1. Optimize a Folder
```bash
node src/cli.js optimize -i "D:\Photos" -o "./optimized" -k ./keys.txt --lossy 1
```

Options:
- `-i, --input <path>`: Input folder or single image file (Required)
- `-o, --output <path>`: Output directory (Default: `./optimized`)
- `-k, --keys <path>`: Path to keys file (Default: `./keys.txt`)
- `-l, --lossy <0|1|2>`: `1` = Lossy (default), `2` = Glossy, `0` = Lossless
- `--webp`: Also generate next-gen WebP images alongside
- `--avif`: Also generate next-gen AVIF images alongside
- `-c, --concurrency <n>`: Number of parallel uploads (Default: `2`)

### 2. Check Key Pool & Remaining Credits
```bash
node src/cli.js keys -r
```
Displays a table with all keys, credits remaining, lifetime images optimized, and data saved.

### 3. View Statistics & Memory
```bash
node src/cli.js stats
```

### 4. Resume Interrupted Job
```bash
node src/cli.js resume
```

---

## 📁 Architecture Overview

```
shortpixel/
├── src/
│   ├── index.js              # Express Web Server & SSE hub
│   ├── cli.js                # Command-Line Executable
│   ├── core/
│   │   ├── shortpixel-client.js # ShortPixel API client & downloader
│   │   ├── key-manager.js       # Key pool, balance checker, auto-rotator
│   │   ├── state-store.js       # Atomic state persistence & history tracking
│   │   ├── optimizer-queue.js   # Queue processor with Pause/Resume
│   │   └── file-utils.js        # File scanning, MD5 hashing, format checks
│   ├── api/
│   │   └── routes.js            # REST API endpoints & SSE broadcast
│   └── public/
│       ├── index.html           # Dashboard UI
│       ├── app.js               # Reactive frontend logic
│       └── style.css            # Styling
├── test/
│   └── test-core.js          # Core test suite
├── keys.example.txt          # Example keys list
├── config.default.json       # Default settings
└── package.json
```

---

## 🧪 Running Tests
```bash
npm test
```
