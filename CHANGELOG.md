# Changelog

All notable changes to the **ShortPixel Multi-Key Image Optimizer & Dashboard** are documented here.

---

## [2.0.0] - 2026-09-20

### 🎨 UI/UX & Native Desktop App Redesign
- **Shadcn Design System**: Fully recreated dashboard with clean zinc surfaces, subtle borders, card components, and animated toast notifications.
- **Lucide Icons**: Integrated crisp vector Lucide iconography across the entire application.
- **Pure Black Dark Mode (`#000000`)**: High-contrast, OLED-friendly pure black theme with light mode toggle and localStorage persistence.
- **Rich Image Details Inspector**: Displays live image thumbnails, resolution dimensions (width × height), MIME type, exact byte sizes, savings %, duration, and keys/proxies used.
- **Side-by-Side Image Preview Modal**: Click any queue row to inspect the full-resolution preview.

### ⚡ Load Balancing & Key Pool Enhancements
- **Multi-Key Load Balancing**: Added `random`, `round-robin`, and `sequential` load balancing strategies to avoid relying on a single key.
- **Bi-directional `keys.txt` Sync**: Adding, modifying, or deleting keys via the dashboard automatically writes changes back to `keys.txt` on disk.
- **Real-Time Live Quota Gauges**: Live aggregate meter displaying Total Quota, Remaining Quota, and Used Quota across all keys.

### 🌐 Proxy Pool Infrastructure
- **Proxy Pool Support**: Added management for HTTP, HTTPS, SOCKS4, and SOCKS5 proxy pools via UI and `proxies.txt`.
- **Rola-IP Auto-Fetch & Filtering**: Integrated automated fetching of live public proxies directly from the Rola-IP API feed (`https://rola-ip.co/proxy-api/api/v1/proxies`), with protocol filtering (SOCKS5/HTTP/SOCKS4), latency threshold filtering (< 500ms, < 1200ms), and top-N sorting.
- **Proxy Latency Benchmarking**: Test response time and health of all proxies with ShortPixel servers.
- **Proxy Rotation**: Automatic proxy cycling across compression requests to prevent rate limits and IP geo restrictions.

### 📁 Smart Output Storage
- **Uploaded Location /optimized (Default)**: Automatically saves optimized files directly in `<Source_Folder>/optimized` next to original images rather than application root.
- **Folder Picker (`webkitdirectory`)**: One-click folder picker to select entire folders with recursive subdirectory preservation.
- **Auto-Download ZIP**: Automatically packages and downloads a complete `.zip` archive upon batch completion.

---

## [1.0.0] - 2026-09-20

### 🚀 Initial Release
- Multi-key API pool with auto-rotation on quota depletion (`-102`).
- Disk-backed atomic state persistence (`shortpixel_state.json`).
- Batch optimization queue with Pause, Resume, Stop, and Retry controls.
- Web Dashboard and CLI interface.
- ShortPixel `post-reducer.php` and `api-status.php` urlencoded communication.
