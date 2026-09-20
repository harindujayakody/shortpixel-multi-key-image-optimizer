# ShortPixel Studio • Multi-Key Image Optimizer & Dashboard

<div align="center">

![Version](https://img.shields.io/badge/version-2.0.0-emerald?style=for-the-badge)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-black?style=for-the-badge&logo=node.js)
![Theme](https://img.shields.io/badge/theme-Pure%20Black%20%7C%20Light-zinc?style=for-the-badge)
![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)

A native-feel, high-performance image optimization studio powered by the **ShortPixel Smart Compression API**. Features an **API Key Pool with zero-downtime multi-key load balancing**, **Proxy Pool rotation**, persistent state memory, instant **Pause/Resume**, and a modern **Shadcn Pure Black** dashboard.

</div>

---

## ⚡ Highlights

- 🎨 **Shadcn Pure Black Dashboard**: Sleek desktop application aesthetic with pure black (`#000000`) dark mode, crisp light mode, and **Lucide icons**.
- 🔄 **Multi-Key Load Balancing (Random / Round-Robin)**: Distributes image compression across multiple API keys evenly rather than relying on a single key. Auto-rotates immediately when any key runs out of quota (`-102`).
- 📁 **Smart Output Storage (`<Source_Folder>/optimized`)**: By default, saves optimized files next to the original files in an `optimized` subfolder, preserving nested folder hierarchies.
- 🌐 **Proxy Pool & Proxy Rotation**: Support for HTTP, HTTPS, and SOCKS5 proxy pools with latency benchmarking to avoid rate limits and geo restrictions.
- 💾 **Bi-Directional `keys.txt` & State Sync**: Adding or deleting keys in the dashboard automatically updates `keys.txt` and `shortpixel_state.json`.
- 📊 **Real-Time Live Quota & Metrics**: Shows live aggregate quota balance (Total / Remaining / Used), storage saved (B/KB/MB/GB), compression ratio %, and active worker concurrency.
- 🔍 **Rich Image Inspection**: Live thumbnails, pixel dimensions ($W \times H$), MIME type, duration (ms), and side-by-side inspection modal.
- ⏸️ **Instant Queue Controls**: Start, Pause, Resume, Stop, and Retry Failed items at any time.
- 📦 **Auto-Download ZIP**: Automatically downloads a complete `.zip` archive upon batch completion.

---

## 🚀 Quick Start

### 1. Installation
```bash
npm install
```

### 2. Configure API Keys
Add your ShortPixel API keys to `keys.txt` (one key per line):
```text
apiKey1_here
apiKey2_here
apiKey3_here
```
*(You can also add, test, and remove keys directly from the Web Dashboard).*

### 3. (Optional) Configure Proxies
Add proxies to `proxies.txt` or configure them via the Dashboard:
```text
http://user:pass@proxy1.com:8080
socks5://proxy2.com:1080
```

### 4. Start the Studio
```bash
npm start
```
Visit **`http://localhost:3000`** in your browser.

---

## 💻 CLI Usage

ShortPixel Studio also includes a full-featured CLI for headless servers, build pipelines, and automated scripts:

### Batch Optimization
```bash
# Optimize a directory (saves by default to <Source>/optimized)
node src/cli.js optimize -i "D:\Photos" -k ./keys.txt --lossy 1 --webp

# Specify custom destination
node src/cli.js optimize -i "./images" -o "./dist" -k ./keys.txt
```

### Key Pool Status & Credit Refresh
```bash
node src/cli.js keys -r
```

### Persistent Analytics
```bash
node src/cli.js stats
```

### Resume Interrupted Job
```bash
node src/cli.js resume
```

---

## 📐 Architecture & Documentation

- [DESIGN.md](file:///d:/Demo/shortpixel/DESIGN.md) — Comprehensive design system tokens, UX architecture, component breakdown, and failover flowcharts.
- [CHANGELOG.md](file:///d:/Demo/shortpixel/CHANGELOG.md) — Complete release notes and version history.

---

## 🧪 Testing
```bash
npm test
```
All core tests verify:
- Atomic state persistence across process restarts
- Multi-key load balancing (Random / Round-Robin)
- Zero-downtime quota exhaustion failover (`-102`)
- Proxy manager agent generation and testing
- File metadata extraction ($W \times H$)

---

## 📄 License
MIT © ShortPixel Multi-Key Image Optimizer
