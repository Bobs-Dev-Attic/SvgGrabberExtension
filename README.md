# SVG Grabber Extension

A Chromium-based browser extension (Manifest V3) that lets you drag a marquee
over any area of a webpage, vectorise the raster contents into an editable SVG
using **ImageTracerJS**, and manipulate the result in a live **Fabric.js**
canvas — all 100 % locally on your machine.

---

## Features

| Feature | Details |
|---|---|
| **Marquee capture** | Drag to select any rectangular area; high-DPI (Retina) screens handled via `devicePixelRatio` |
| **Vectorisation** | ImageTracerJS runs in a **Web Worker** so the UI never blocks |
| **Color Quantization** | Slider maps to `numberofcolors` (2 – 16) |
| **Smoothing** | Slider maps to `blurradius` (0 – 5) + `linefilter` toggle |
| **Simplification (RDP)** | Ramer-Douglas-Peucker reduces node count on L-segment runs; also drives `pathomit` |
| **Background Removal** | Detects dominant corner colour, erases matching pixels before tracing (pre-processing) |
| **Fabric.js editor** | Click paths to select (indigo highlight), `Delete`/`Backspace` to remove them |
| **Download SVG** | Serialises the current Fabric canvas to a `.svg` file |
| **Copy SVG** | Copies raw SVG XML to the clipboard |
| **Privacy** | No data ever leaves your device — zero external network calls |

---

## Prerequisites

- **Node.js** ≥ 18 and **npm** ≥ 9
- A Chromium-based browser (Chrome ≥ 114, Edge, Brave, …)

---

## Build

```bash
# Install dependencies
npm install

# One-shot production build → dist/
npm run build

# Development build (minification off, inline sourcemaps)
npm run dev
```

The built extension lives in `dist/`.

---

## Load as unpacked extension

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode** (toggle in the top-right).
3. Click **Load unpacked** and select the `dist/` folder.
4. The **SVG Grabber** icon appears in the toolbar.

---

## Usage

1. Navigate to any webpage.
2. Click the **SVG Grabber** toolbar icon.
   - The side panel opens on the right.
   - A full-screen crosshair overlay appears on the page.
3. **Drag** a rectangle over the area you want to capture.
   - Press **Esc** to cancel without capturing.
4. Back in the side panel, adjust the **Trace Settings** sliders.
5. Click **Trace to SVG** — a loading spinner appears while the Web Worker runs.
6. The SVG renders in the **Fabric.js** canvas:
   - Click any path to select it (indigo border).
   - Press `Delete` / `Backspace` (or the **Delete Selected Path** button) to remove it.
7. Use **Download SVG** or **Copy SVG** to export.

You can click **New Capture** at any time to start a fresh selection.

---

## Project structure

```
├── src/
│   ├── manifest.json               MV3 manifest
│   ├── background/
│   │   └── service_worker.js       Open panel, inject overlay, relay captureVisibleTab
│   ├── content_scripts/
│   │   └── overlay.js              Marquee selection overlay (injected into active tab)
│   ├── side_panel/
│   │   ├── index.html              Panel UI
│   │   └── panel.js                Fabric.js canvas, trace orchestration, export
│   └── workers/
│       └── tracer.worker.js        ImageTracerJS + RDP simplification + bg removal
├── build.js                        esbuild-based build script + PNG icon generator
├── package.json
└── dist/                           Built extension (gitignored – run `npm run build`)
```

---

## Ethical notice

> **Respect copyright.** Only vectorise content you have the right to use.
> All image processing happens entirely in your browser — no image data is ever
> sent to any external server.
