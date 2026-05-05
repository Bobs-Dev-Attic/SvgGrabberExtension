/**
 * SVG Grabber – Side Panel Script
 *
 * Orchestrates:
 *  - "New Capture" → asks the background to inject the marquee overlay.
 *  - Receiving the screenshot (SCREENSHOT_TAKEN message or session-storage
 *    poll) → cropping the captured area from the full-tab PNG.
 *  - Slider controls wired to live re-trace.
 *  - Fabric.js canvas: load SVG, path selection, Delete key, Clear.
 *  - Download SVG / Copy to Clipboard.
 *
 * The heavy vectorisation work runs in a Web Worker so the UI stays
 * responsive during tracing.
 */

import { Canvas, loadSVGFromString } from 'fabric';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const btnNewCapture  = document.getElementById('btn-new-capture');
const btnTrace       = document.getElementById('btn-trace');
const btnDeleteSel   = document.getElementById('btn-delete-sel');
const btnDownload    = document.getElementById('btn-download');
const btnCopy        = document.getElementById('btn-copy');

const previewImg     = document.getElementById('preview-img');
const previewEmpty   = document.getElementById('preview-empty');

const slColors       = document.getElementById('sl-colors');
const slSmooth       = document.getElementById('sl-smooth');
const slSimplify     = document.getElementById('sl-simplify');
const slColorsVal    = document.getElementById('sl-colors-val');
const slSmoothVal    = document.getElementById('sl-smooth-val');
const slSimplifyVal  = document.getElementById('sl-simplify-val');
const toggleBg       = document.getElementById('toggle-bg');

const canvasEl       = document.getElementById('main-canvas');
const canvasEmpty    = document.getElementById('canvas-empty');
const loadingOverlay = document.getElementById('loading-overlay');
const statusEl       = document.getElementById('status');

// ── State ─────────────────────────────────────────────────────────────────────
let capturedImageData = null;   // ImageData of the cropped area
let fabricCanvas      = null;   // fabric.Canvas instance
let tracerWorker      = null;   // Web Worker
let currentSVGString  = '';

// ── Fabric.js canvas init ─────────────────────────────────────────────────────
function initFabric() {
  if (fabricCanvas) {
    fabricCanvas.dispose();
    fabricCanvas = null;
  }
  fabricCanvas = new Canvas('main-canvas', {
    selection:         true,
    preserveObjectStacking: true,
    backgroundColor:   'transparent',
  });

  // Selection → enable/disable the Delete button.
  fabricCanvas.on('selection:created',  updateDeleteBtn);
  fabricCanvas.on('selection:updated',  updateDeleteBtn);
  fabricCanvas.on('selection:cleared',  updateDeleteBtn);

  // Keyboard handler for Delete/Backspace.
  document.addEventListener('keydown', onKeyDown);
}

function updateDeleteBtn() {
  btnDeleteSel.disabled = !(fabricCanvas?.getActiveObject());
}

function onKeyDown(e) {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = fabricCanvas?.getActiveObject();
  if (!active) return;
  // Only delete when focus is NOT in a text input.
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  deleteSelected();
}

function deleteSelected() {
  if (!fabricCanvas) return;
  // getActiveObjects() works for both single and multi-selection in Fabric v7.
  const toRemove = fabricCanvas.getActiveObjects();
  if (!toRemove.length) return;
  fabricCanvas.discardActiveObject();
  toRemove.forEach((o) => fabricCanvas.remove(o));
  fabricCanvas.requestRenderAll();
  updateDeleteBtn();
}

// ── Slider live labels ────────────────────────────────────────────────────────
slColors.addEventListener('input',   () => { slColorsVal.textContent   = slColors.value;   });
slSmooth.addEventListener('input',   () => { slSmoothVal.textContent   = slSmooth.value;   });
slSimplify.addEventListener('input', () => { slSimplifyVal.textContent = slSimplify.value; });

// ── New Capture ───────────────────────────────────────────────────────────────
btnNewCapture.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'START_MARQUEE' });
  setStatus('Draw a rectangle on the page…', '');
});

// ── Screenshot receipt ────────────────────────────────────────────────────────

/** Crop the full-tab PNG to the selected rect, respecting devicePixelRatio. */
async function cropScreenshot({ dataUrl, rect, devicePixelRatio }) {
  const dpr = devicePixelRatio || 1;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = Math.round(rect.width  * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        img,
        Math.round(rect.x * dpr),
        Math.round(rect.y * dpr),
        canvas.width,
        canvas.height,
        0, 0, canvas.width, canvas.height,
      );
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Release the off-screen canvas memory immediately after extracting pixel data.
      canvas.width  = 0;
      canvas.height = 0;
      resolve(imageData);
    };
    img.src = dataUrl;
  });
}

/** Show the preview image and enable the Trace button. */
function showPreview(dataUrl) {
  previewImg.src        = dataUrl;
  previewImg.style.display = 'block';
  previewEmpty.style.display = 'none';
  btnTrace.disabled = false;
}

/** Called when a valid screenshot payload is available. */
async function handleScreenshot(payload) {
  setStatus('Screenshot captured. Adjust settings and click Trace.', 'ok');

  const imageData = await cropScreenshot(payload);

  // Keep a re-usable reference to the cropped ImageData.
  capturedImageData = imageData;

  // Show thumbnail preview.
  // Re-draw to a small canvas for the thumbnail to avoid showing a huge img.
  const thumbCanvas = document.createElement('canvas');
  const MAX = 300;
  const scale = Math.min(1, MAX / Math.max(imageData.width, imageData.height));
  thumbCanvas.width  = Math.round(imageData.width  * scale);
  thumbCanvas.height = Math.round(imageData.height * scale);
  const tCtx = thumbCanvas.getContext('2d');
  // Temporarily paint imageData at native size then scale-draw.
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width  = imageData.width;
  tmpCanvas.height = imageData.height;
  tmpCanvas.getContext('2d').putImageData(imageData, 0, 0);
  tCtx.drawImage(tmpCanvas, 0, 0, thumbCanvas.width, thumbCanvas.height);
  // Free tmp canvases.
  tmpCanvas.width = tmpCanvas.height = 0;

  showPreview(thumbCanvas.toDataURL());
  thumbCanvas.width = thumbCanvas.height = 0;
}

// Listen for direct messages from the background.
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCREENSHOT_TAKEN') {
    handleScreenshot(message);
  }
});

// Poll session storage on first load (handles the case where the message
// arrived before the panel listener was registered).
chrome.storage.session.get('pendingCapture').then(({ pendingCapture }) => {
  if (pendingCapture) {
    handleScreenshot(pendingCapture);
    // Clear so subsequent opens don't re-trigger.
    chrome.storage.session.remove('pendingCapture');
  }
});

// ── Tracing ───────────────────────────────────────────────────────────────────

function getTraceOptions() {
  // colorQuantization: slider value is 2–16 directly.
  const numColors = parseInt(slColors.value, 10);
  // Map numColors 2-16 → percentage 0-100 for the worker.
  const colorQuantization = Math.round(((numColors - 2) / 14) * 100);

  return {
    colorQuantization,
    smoothing:         parseInt(slSmooth.value,   10),
    simplification:    parseInt(slSimplify.value, 10),
    removeBackground:  toggleBg.checked,
    bgTolerance:       32,
  };
}

btnTrace.addEventListener('click', () => {
  if (!capturedImageData) return;
  startTrace();
});

function startTrace() {
  // Show loading state.
  loadingOverlay.classList.add('visible');
  btnTrace.disabled = true;
  setStatus('Tracing…', '');

  // Terminate any previous worker.
  if (tracerWorker) {
    tracerWorker.terminate();
    tracerWorker = null;
  }

  const workerUrl = chrome.runtime.getURL('workers/tracer.worker.js');
  tracerWorker = new Worker(workerUrl);

  tracerWorker.onmessage = (e) => {
    loadingOverlay.classList.remove('visible');
    btnTrace.disabled = false;

    if (e.data.type === 'TRACE_RESULT') {
      onTraceSuccess(e.data.svgString);
    } else if (e.data.type === 'TRACE_ERROR') {
      setStatus(`Trace error: ${e.data.error}`, 'err');
    }

    // Clean up worker memory.
    tracerWorker.terminate();
    tracerWorker = null;
  };

  tracerWorker.onerror = (err) => {
    loadingOverlay.classList.remove('visible');
    btnTrace.disabled = false;
    setStatus(`Worker error: ${err.message}`, 'err');
    tracerWorker.terminate();
    tracerWorker = null;
  };

  // Transfer a copy of the ImageData (structured clone).
  tracerWorker.postMessage(
    { type: 'TRACE', imageData: capturedImageData, options: getTraceOptions() },
  );
}

// ── SVG → Fabric canvas ───────────────────────────────────────────────────────

async function onTraceSuccess(svgString) {
  currentSVGString = svgString;

  // Parse the SVG to get its declared width/height.
  const parser = new DOMParser();
  const doc    = parser.parseFromString(svgString, 'image/svg+xml');
  const svgEl  = doc.querySelector('svg');
  const svgW   = parseFloat(svgEl?.getAttribute('width')  ?? capturedImageData.width);
  const svgH   = parseFloat(svgEl?.getAttribute('height') ?? capturedImageData.height);

  // Size the Fabric canvas to fit inside the panel (max 320 px wide).
  const panelW = (document.getElementById('canvas-wrap').clientWidth || 320) - 4;
  const scale  = Math.min(1, panelW / svgW);
  const dispW  = Math.round(svgW * scale);
  const dispH  = Math.round(svgH * scale);

  canvasEl.style.display     = 'block';
  canvasEmpty.style.display  = 'none';

  initFabric();
  fabricCanvas.setDimensions({ width: dispW, height: dispH });

  // setZoom scales the viewport so that objects at native SVG coordinates are
  // displayed at the panel width.  Fabric's svgViewportTransformation=true
  // (the default) automatically uses this zoom when building the viewBox in
  // toSVG(), so the exported SVG always has full-resolution path data.
  fabricCanvas.setZoom(scale);

  // Fabric.js v7: loadSVGFromString is Promise-based and returns objects
  // individually – no groupSVGElements / toActiveSelection needed.
  const { objects } = await loadSVGFromString(svgString);

  objects.filter(Boolean).forEach((obj) => {
    obj.set({
      selectable:        true,
      hasControls:       false,
      hasBorders:        true,
      lockMovementX:     true,
      lockMovementY:     true,
      hoverCursor:       'pointer',
      borderColor:       '#6366f1',
      borderScaleFactor: 2,
    });
    fabricCanvas.add(obj);
  });

  fabricCanvas.requestRenderAll();

  const count = fabricCanvas.getObjects().length;
  btnDownload.disabled = false;
  btnCopy.disabled     = false;
  setStatus(`Traced ${count} paths.  Click a path to select, Delete to remove.`, 'ok');
}

// ── Delete selected ───────────────────────────────────────────────────────────
btnDeleteSel.addEventListener('click', deleteSelected);

// ── Serialise canvas → SVG string ────────────────────────────────────────────
function canvasToSVGString() {
  if (!fabricCanvas) return currentSVGString;

  // Fabric v7 default svgViewportTransformation=true automatically sets
  // viewBox="0 0 nativeW nativeH" matching the canvas zoom, so the exported
  // SVG carries full-resolution path data regardless of the display scale.
  // The preamble (<?xml …>) is already included by Fabric's _setSVGPreamble.
  return fabricCanvas.toSVG();
}

// ── Download ──────────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  const svg  = canvasToSVGString();
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `capture-${Date.now()}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus('SVG downloaded.', 'ok');
});

// ── Copy to clipboard ─────────────────────────────────────────────────────────
btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(canvasToSVGString());
    setStatus('SVG copied to clipboard!', 'ok');
  } catch {
    setStatus('Clipboard write failed.', 'err');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent  = msg;
  statusEl.className    = cls;
}
