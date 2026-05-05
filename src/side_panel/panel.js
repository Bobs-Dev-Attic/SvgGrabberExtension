/**
 * SVG Grabber – Side Panel Script
 */

import { ActiveSelection, Canvas, loadSVGFromString } from 'fabric';

const STORAGE_KEY_UNDO_STEPS = 'undoSteps';
const DEFAULT_UNDO_STEPS = 10;
const HIGHLIGHT_STROKE = '#f8fafc';
const HIGHLIGHT_OUTLINE = '#6366f1';

// ── DOM refs ─────────────────────────────────────────────────────────────────
const btnNewCapture = document.getElementById('btn-new-capture');
const btnPickBg = document.getElementById('btn-pick-bg');
const btnClearBgPick = document.getElementById('btn-clear-bg-pick');
const btnTrace = document.getElementById('btn-trace');
const btnDeleteSel = document.getElementById('btn-delete-sel');
const btnUndo = document.getElementById('btn-undo');
const btnDownload = document.getElementById('btn-download');
const btnCopy = document.getElementById('btn-copy');

const previewCanvas = document.getElementById('preview-canvas');
const previewImg = document.getElementById('preview-img');
const previewEmpty = document.getElementById('preview-empty');
const previewMarker = document.getElementById('preview-marker');
const bgPickHint = document.getElementById('bg-pick-hint');

const slColors = document.getElementById('sl-colors');
const slSmooth = document.getElementById('sl-smooth');
const slSimplify = document.getElementById('sl-simplify');
const slBgTolerance = document.getElementById('sl-bg-tolerance');
const slBgSample = document.getElementById('sl-bg-sample');
const slBgExpand = document.getElementById('sl-bg-expand');
const slPathLimit = document.getElementById('sl-path-limit');
const slColorsVal = document.getElementById('sl-colors-val');
const slSmoothVal = document.getElementById('sl-smooth-val');
const slSimplifyVal = document.getElementById('sl-simplify-val');
const slBgToleranceVal = document.getElementById('sl-bg-tolerance-val');
const slBgSampleVal = document.getElementById('sl-bg-sample-val');
const slBgExpandVal = document.getElementById('sl-bg-expand-val');
const slPathLimitVal = document.getElementById('sl-path-limit-val');
const toggleBg = document.getElementById('toggle-bg');
const toggleTrimTransparent = document.getElementById('toggle-trim-transparent');
const inputFillColor = document.getElementById('input-fill-color');
const selectedFillValue = document.getElementById('selected-fill-value');
const inputExportWidth = document.getElementById('input-export-width');
const inputExportHeight = document.getElementById('input-export-height');
const toggleMaintainRatio = document.getElementById('toggle-maintain-ratio');
const toggleOmitDimensions = document.getElementById('toggle-omit-dimensions');

const canvasEl = document.getElementById('main-canvas');
const canvasEmpty = document.getElementById('canvas-empty');
const loadingOverlay = document.getElementById('loading-overlay');
const statusEl = document.getElementById('status');
const svgSizeEl = document.getElementById('svg-size');

// ── State ─────────────────────────────────────────────────────────────────────
let capturedImageData = null;
let fabricCanvas = null;
let tracerWorker = null;
let currentSVGString = '';
let bgSeedPoint = null;
let bgPreviewMask = null;
let wandArmed = false;
let undoStack = [];
let keyHandlerBound = false;
let undoStepsLimit = DEFAULT_UNDO_STEPS;
let highlightedObjects = [];

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadUndoStepsSetting() {
  const stored = await chrome.storage.sync.get({ [STORAGE_KEY_UNDO_STEPS]: DEFAULT_UNDO_STEPS });
  undoStepsLimit = parseInt(stored[STORAGE_KEY_UNDO_STEPS], 10) || DEFAULT_UNDO_STEPS;
  trimUndoStack();
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'sync' || !changes[STORAGE_KEY_UNDO_STEPS]) return;
  undoStepsLimit = parseInt(changes[STORAGE_KEY_UNDO_STEPS].newValue, 10) || DEFAULT_UNDO_STEPS;
  trimUndoStack();
});

// ── Fabric.js canvas init ─────────────────────────────────────────────────────
function initFabric() {
  if (fabricCanvas) {
    fabricCanvas.dispose();
    fabricCanvas = null;
  }

  fabricCanvas = new Canvas('main-canvas', {
    selection: true,
    preserveObjectStacking: true,
    backgroundColor: 'transparent',
  });

  fabricCanvas.on('selection:created', handleSelectionChange);
  fabricCanvas.on('selection:updated', handleSelectionChange);
  fabricCanvas.on('selection:cleared', handleSelectionClear);

  if (!keyHandlerBound) {
    document.addEventListener('keydown', onKeyDown);
    keyHandlerBound = true;
  }
}

function updateDeleteBtn() {
  btnDeleteSel.disabled = !(fabricCanvas?.getActiveObject());
}

function updateUndoBtn() {
  btnUndo.disabled = undoStack.length === 0;
}

function setFillControlsDisabled(disabled) {
  inputFillColor.disabled = disabled;
  if (disabled) {
    selectedFillValue.textContent = 'None';
  }
}

function normalizeColorToHex(color) {
  if (!color || typeof color !== 'string') return null;
  if (color.startsWith('#')) return color.length === 4
    ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
    : color.toLowerCase();

  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const channels = match[1].split(',').slice(0, 3).map((part) => parseInt(part.trim(), 10));
  if (channels.some((value) => Number.isNaN(value))) return null;
  return `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function applyHighlightToObject(obj) {
  if (!obj || obj.__svgGrabberHighlight) return;

  obj.__svgGrabberHighlight = {
    stroke: obj.stroke ?? null,
    strokeWidth: obj.strokeWidth ?? 0,
    strokeUniform: obj.strokeUniform ?? false,
    shadow: obj.shadow ?? null,
  };

  obj.set({
    stroke: HIGHLIGHT_STROKE,
    strokeWidth: Math.max(2, obj.__svgGrabberHighlight.strokeWidth || 0, 2),
    strokeUniform: true,
    shadow: {
      color: HIGHLIGHT_OUTLINE,
      blur: 10,
      offsetX: 0,
      offsetY: 0,
    },
  });
}

function removeHighlightFromObject(obj) {
  if (!obj?.__svgGrabberHighlight) return;
  const original = obj.__svgGrabberHighlight;
  obj.set({
    stroke: original.stroke,
    strokeWidth: original.strokeWidth,
    strokeUniform: original.strokeUniform,
    shadow: original.shadow,
  });
  delete obj.__svgGrabberHighlight;
}

function clearSelectionHighlight() {
  highlightedObjects.forEach(removeHighlightFromObject);
  highlightedObjects = [];
  fabricCanvas?.requestRenderAll();
}

function updateFillColorUI() {
  const activeObjects = fabricCanvas?.getActiveObjects() ?? [];
  if (!activeObjects.length) {
    setFillControlsDisabled(true);
    return;
  }

  const firstFill = normalizeColorToHex(activeObjects[0].fill);
  if (!firstFill) {
    setFillControlsDisabled(true);
    return;
  }

  setFillControlsDisabled(false);
  inputFillColor.value = firstFill;
  selectedFillValue.textContent = firstFill;
}

function handleSelectionChange() {
  updateDeleteBtn();
  clearSelectionHighlight();
  highlightedObjects = fabricCanvas?.getActiveObjects() ?? [];
  highlightedObjects.forEach(applyHighlightToObject);
  fabricCanvas?.requestRenderAll();
  updateFillColorUI();
}

function handleSelectionClear() {
  updateDeleteBtn();
  clearSelectionHighlight();
  setFillControlsDisabled(true);
}

function onKeyDown(e) {
  const wantsUndo = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z';
  if (wantsUndo && !btnUndo.disabled) {
    e.preventDefault();
    undoLastEdit();
    return;
  }

  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  const active = fabricCanvas?.getActiveObject();
  if (!active) return;
  if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
  e.preventDefault();
  deleteSelected();
}

function getMaxUndoSteps() {
  return undoStepsLimit;
}

function trimUndoStack() {
  const overflow = undoStack.length - getMaxUndoSteps();
  if (overflow > 0) {
    undoStack = undoStack.slice(overflow);
  }
  updateUndoBtn();
}

function pushUndoState(svgString) {
  if (!svgString) return;
  if (undoStack[undoStack.length - 1] === svgString) return;
  undoStack.push(svgString);
  trimUndoStack();
}

function clearUndoStack() {
  undoStack = [];
  updateUndoBtn();
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function updateEstimatedSize(svgString = currentSVGString) {
  if (!svgString) {
    svgSizeEl.textContent = 'Estimated SVG size: --';
    return;
  }
  const bytes = new TextEncoder().encode(svgString).length;
  svgSizeEl.textContent = `Estimated SVG size: ${formatBytes(bytes)}`;
}

function parsePositiveInt(value) {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getCurrentSvgDimensions() {
  const source = currentSVGString || canvasToSVGString();
  if (!source) {
    return {
      width: capturedImageData?.width ?? 1,
      height: capturedImageData?.height ?? 1,
    };
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(source, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  return {
    width: parsePositiveInt(svgEl?.getAttribute('width')) ?? capturedImageData?.width ?? 1,
    height: parsePositiveInt(svgEl?.getAttribute('height')) ?? capturedImageData?.height ?? 1,
  };
}

function syncExportDimension(changed) {
  if (!toggleMaintainRatio.checked) return;

  const { width: baseWidth, height: baseHeight } = getCurrentSvgDimensions();
  if (!baseWidth || !baseHeight) return;

  if (changed === 'width') {
    const width = parsePositiveInt(inputExportWidth.value);
    if (!width) return;
    inputExportHeight.value = String(Math.max(1, Math.round((width / baseWidth) * baseHeight)));
  } else if (changed === 'height') {
    const height = parsePositiveInt(inputExportHeight.value);
    if (!height) return;
    inputExportWidth.value = String(Math.max(1, Math.round((height / baseHeight) * baseWidth)));
  }
}

function getPixelIndex(width, x, y) {
  return (y * width + x) * 4;
}

function sampleAverageColor(imageData, x, y, radius) {
  const { data, width, height } = imageData;
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  const startX = Math.max(0, x - radius);
  const endX = Math.min(width - 1, x + radius);
  const startY = Math.max(0, y - radius);
  const endY = Math.min(height - 1, y + radius);

  for (let py = startY; py <= endY; py++) {
    for (let px = startX; px <= endX; px++) {
      const i = getPixelIndex(width, px, py);
      if (data[i + 3] < 8) continue;
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
      count++;
    }
  }

  if (count === 0) {
    const i = getPixelIndex(width, x, y);
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  }

  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
  };
}

function colorDistanceSq(data, i, color) {
  const dr = data[i] - color.r;
  const dg = data[i + 1] - color.g;
  const db = data[i + 2] - color.b;
  return dr * dr + dg * dg + db * db;
}

function floodFillMask(imageData, seeds, tolerance, sampleRadius) {
  const { data, width, height } = imageData;
  const total = width * height;
  const mask = new Uint8Array(total);
  const visited = new Uint8Array(total);
  const toleranceSq = tolerance * tolerance;

  for (const seed of seeds) {
    if (!seed) continue;
    const sx = Math.max(0, Math.min(width - 1, Math.round(seed.x)));
    const sy = Math.max(0, Math.min(height - 1, Math.round(seed.y)));
    const targetColor = sampleAverageColor(imageData, sx, sy, sampleRadius);
    const queue = new Int32Array(total);
    let head = 0;
    let tail = 0;
    const startIndex = sy * width + sx;

    if (visited[startIndex]) continue;

    queue[tail++] = startIndex;
    visited[startIndex] = 1;

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      const y = (idx - x) / width;
      const pixelIndex = idx * 4;

      if (data[pixelIndex + 3] < 8 || colorDistanceSq(data, pixelIndex, targetColor) > toleranceSq) {
        continue;
      }

      mask[idx] = 1;

      if (x > 0) {
        const next = idx - 1;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (x + 1 < width) {
        const next = idx + 1;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (y > 0) {
        const next = idx - width;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
      if (y + 1 < height) {
        const next = idx + width;
        if (!visited[next]) {
          visited[next] = 1;
          queue[tail++] = next;
        }
      }
    }
  }

  return mask;
}

function dilateMask(mask, width, height, radius) {
  if (radius <= 0) return mask;

  let current = mask;
  for (let step = 0; step < radius; step++) {
    const next = current.slice();
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (!current[idx]) continue;
        if (x > 0) next[idx - 1] = 1;
        if (x + 1 < width) next[idx + 1] = 1;
        if (y > 0) next[idx - width] = 1;
        if (y + 1 < height) next[idx + width] = 1;
      }
    }
    current = next;
  }
  return current;
}

function buildBackgroundMask(imageData, options) {
  const {
    bgTolerance = parseInt(slBgTolerance.value, 10),
    bgSampleRadius = parseInt(slBgSample.value, 10),
    bgExpand = parseInt(slBgExpand.value, 10),
    bgSeedPoint: seedPoint = bgSeedPoint,
  } = options ?? {};

  const { width, height } = imageData;
  const cornerSeeds = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: 0, y: height - 1 },
    { x: width - 1, y: height - 1 },
  ];

  const seeds = seedPoint ? [seedPoint] : cornerSeeds;
  const mask = floodFillMask(imageData, seeds, bgTolerance, bgSampleRadius);
  return dilateMask(mask, width, height, bgExpand);
}

function resetTraceResult() {
  currentSVGString = '';
  btnDownload.disabled = true;
  btnCopy.disabled = true;
  btnDeleteSel.disabled = true;
  clearUndoStack();
  updateEstimatedSize('');
  clearSelectionHighlight();
  setFillControlsDisabled(true);
  canvasEl.style.display = 'none';
  canvasEmpty.style.display = 'flex';
  if (fabricCanvas) {
    fabricCanvas.dispose();
    fabricCanvas = null;
  }
}

function clearCapturedPreview() {
  capturedImageData = null;
  bgPreviewMask = null;
  btnTrace.disabled = true;
  previewCanvas.style.display = 'none';
  previewImg.style.display = 'none';
  previewEmpty.style.display = 'flex';
  previewMarker.style.display = 'none';
  updateWandUI();
}

function clearBackgroundPick() {
  bgSeedPoint = null;
  bgPreviewMask = null;
  previewMarker.style.display = 'none';
  btnClearBgPick.disabled = true;
  renderPreview();
  updateWandUI();
}

function updateWandUI() {
  btnPickBg.disabled = !capturedImageData;
  btnClearBgPick.disabled = !bgSeedPoint;
  previewCanvas.classList.toggle('wand-armed', wandArmed && !!capturedImageData);

  if (!capturedImageData) {
    bgPickHint.textContent = 'Use the wand to click the preview and sample the background you want removed.';
  } else if (wandArmed) {
    bgPickHint.textContent = 'Click the preview to sample the background. A live mask outline will show what will be removed.';
  } else if (bgSeedPoint) {
    bgPickHint.textContent = `Background sample locked at ${bgSeedPoint.x}, ${bgSeedPoint.y}. The highlighted region is what will be removed.`;
  } else {
    bgPickHint.textContent = 'No background point picked yet. If you skip the wand, auto-corner background detection is used.';
  }
}

function getPreviewRectRelative() {
  const canvasRect = previewCanvas.getBoundingClientRect();
  const wrapRect = previewCanvas.parentElement.getBoundingClientRect();
  return {
    left: canvasRect.left - wrapRect.left,
    top: canvasRect.top - wrapRect.top,
    width: canvasRect.width,
    height: canvasRect.height,
  };
}

function renderBackgroundMarker() {
  if (!capturedImageData || !bgSeedPoint || previewCanvas.style.display === 'none') {
    previewMarker.style.display = 'none';
    return;
  }

  const rect = getPreviewRectRelative();
  const markerX = rect.left + ((bgSeedPoint.x + 0.5) / capturedImageData.width) * rect.width;
  const markerY = rect.top + ((bgSeedPoint.y + 0.5) / capturedImageData.height) * rect.height;

  previewMarker.style.left = `${markerX}px`;
  previewMarker.style.top = `${markerY}px`;
  previewMarker.style.display = 'block';
}

function drawMaskOverlay(ctx, drawWidth, drawHeight) {
  if (!capturedImageData || !bgPreviewMask) return;

  const { width: srcW, height: srcH } = capturedImageData;
  const overlay = ctx.createImageData(drawWidth, drawHeight);

  for (let dy = 0; dy < drawHeight; dy++) {
    const sy = Math.min(srcH - 1, Math.floor((dy / drawHeight) * srcH));
    for (let dx = 0; dx < drawWidth; dx++) {
      const sx = Math.min(srcW - 1, Math.floor((dx / drawWidth) * srcW));
      const srcIdx = sy * srcW + sx;
      if (!bgPreviewMask[srcIdx]) continue;

      const left = sx > 0 ? bgPreviewMask[srcIdx - 1] : 0;
      const right = sx + 1 < srcW ? bgPreviewMask[srcIdx + 1] : 0;
      const up = sy > 0 ? bgPreviewMask[srcIdx - srcW] : 0;
      const down = sy + 1 < srcH ? bgPreviewMask[srcIdx + srcW] : 0;
      const boundary = !(left && right && up && down);

      const outIdx = (dy * drawWidth + dx) * 4;
      if (boundary) {
        overlay.data[outIdx] = 255;
        overlay.data[outIdx + 1] = 255;
        overlay.data[outIdx + 2] = 255;
        overlay.data[outIdx + 3] = 220;
      } else {
        overlay.data[outIdx] = 99;
        overlay.data[outIdx + 1] = 102;
        overlay.data[outIdx + 2] = 241;
        overlay.data[outIdx + 3] = 68;
      }
    }
  }

  ctx.putImageData(overlay, 0, 0);
}

function renderPreview() {
  if (!capturedImageData) return;

  const MAX = 300;
  const scale = Math.min(1, MAX / Math.max(capturedImageData.width, capturedImageData.height));
  const drawWidth = Math.max(1, Math.round(capturedImageData.width * scale));
  const drawHeight = Math.max(1, Math.round(capturedImageData.height * scale));

  previewCanvas.width = drawWidth;
  previewCanvas.height = drawHeight;
  previewCanvas.style.display = 'block';
  previewImg.style.display = 'none';
  previewEmpty.style.display = 'none';

  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = capturedImageData.width;
  tmpCanvas.height = capturedImageData.height;
  tmpCanvas.getContext('2d').putImageData(capturedImageData, 0, 0);

  const ctx = previewCanvas.getContext('2d');
  ctx.clearRect(0, 0, drawWidth, drawHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(tmpCanvas, 0, 0, drawWidth, drawHeight);
  drawMaskOverlay(ctx, drawWidth, drawHeight);

  tmpCanvas.width = 0;
  tmpCanvas.height = 0;

  renderBackgroundMarker();
}

function updatePreviewSelection() {
  bgPreviewMask = capturedImageData && toggleBg.checked ? buildBackgroundMask(capturedImageData) : null;
  renderPreview();
}

// ── Slider live labels ────────────────────────────────────────────────────────
slColors.addEventListener('input', () => { slColorsVal.textContent = slColors.value; });
slSmooth.addEventListener('input', () => { slSmoothVal.textContent = slSmooth.value; });
slSimplify.addEventListener('input', () => { slSimplifyVal.textContent = slSimplify.value; });
slPathLimit.addEventListener('input', () => { slPathLimitVal.textContent = `${slPathLimit.value}%`; });
slBgTolerance.addEventListener('input', () => {
  slBgToleranceVal.textContent = slBgTolerance.value;
  if (bgSeedPoint || toggleBg.checked) updatePreviewSelection();
});
slBgSample.addEventListener('input', () => {
  slBgSampleVal.textContent = slBgSample.value;
  if (bgSeedPoint || toggleBg.checked) updatePreviewSelection();
});
slBgExpand.addEventListener('input', () => {
  slBgExpandVal.textContent = slBgExpand.value;
  if (bgSeedPoint || toggleBg.checked) updatePreviewSelection();
});
inputExportWidth.addEventListener('input', () => {
  syncExportDimension('width');
});
inputExportHeight.addEventListener('input', () => {
  syncExportDimension('height');
});
toggleMaintainRatio.addEventListener('change', () => {
  if (toggleMaintainRatio.checked) {
    if (parsePositiveInt(inputExportWidth.value)) {
      syncExportDimension('width');
    } else if (parsePositiveInt(inputExportHeight.value)) {
      syncExportDimension('height');
    }
  }
});
toggleBg.addEventListener('change', () => {
  if (!toggleBg.checked) {
    bgPreviewMask = null;
    renderPreview();
  } else if (capturedImageData) {
    updatePreviewSelection();
  }
  updateWandUI();
});

inputFillColor.addEventListener('input', () => {
  selectedFillValue.textContent = inputFillColor.value;
});

inputFillColor.addEventListener('change', () => {
  applySelectedFillColor(inputFillColor.value);
});

// ── Capture / picker ──────────────────────────────────────────────────────────
btnNewCapture.addEventListener('click', () => {
  wandArmed = false;
  clearBackgroundPick();
  clearCapturedPreview();
  resetTraceResult();
  chrome.runtime.sendMessage({ type: 'START_MARQUEE' });
  setStatus('Draw a rectangle on the page…', '');
});

btnPickBg.addEventListener('click', () => {
  if (!capturedImageData) return;
  toggleBg.checked = true;
  wandArmed = !wandArmed;
  updateWandUI();
  setStatus(wandArmed ? 'Click the preview to sample the background.' : 'Background picker cancelled.', '');
});

btnClearBgPick.addEventListener('click', () => {
  wandArmed = false;
  clearBackgroundPick();
  setStatus('Background picker cleared. Auto-corner background removal will be used instead.', '');
});

previewCanvas.addEventListener('click', (e) => {
  if (!capturedImageData || !wandArmed) return;

  const rect = previewCanvas.getBoundingClientRect();
  const relX = (e.clientX - rect.left) / rect.width;
  const relY = (e.clientY - rect.top) / rect.height;

  bgSeedPoint = {
    x: Math.max(0, Math.min(capturedImageData.width - 1, Math.round(relX * (capturedImageData.width - 1)))),
    y: Math.max(0, Math.min(capturedImageData.height - 1, Math.round(relY * (capturedImageData.height - 1)))),
  };

  wandArmed = false;
  updatePreviewSelection();
  updateWandUI();
  setStatus(`Background sampled at ${bgSeedPoint.x}, ${bgSeedPoint.y}. The highlighted region shows what will be removed.`, 'ok');
});

window.addEventListener('resize', () => {
  if (capturedImageData) {
    renderPreview();
  }
});

// ── Screenshot receipt ────────────────────────────────────────────────────────
async function cropScreenshot({ dataUrl, rect, devicePixelRatio }) {
  const dpr = devicePixelRatio || 1;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(
        img,
        Math.round(rect.x * dpr),
        Math.round(rect.y * dpr),
        canvas.width,
        canvas.height,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      canvas.height = 0;
      resolve(imageData);
    };
    img.src = dataUrl;
  });
}

function showPreview() {
  btnTrace.disabled = false;
  renderPreview();
  updateWandUI();
}

async function handleScreenshot(payload) {
  setStatus('Screenshot captured. Adjust settings and click Trace.', 'ok');
  wandArmed = false;
  clearBackgroundPick();
  resetTraceResult();

  capturedImageData = await cropScreenshot(payload);
  showPreview();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SCREENSHOT_TAKEN') {
    handleScreenshot(message);
  }
});

chrome.storage.session.get('pendingCapture').then(({ pendingCapture }) => {
  if (pendingCapture) {
    handleScreenshot(pendingCapture);
    chrome.storage.session.remove('pendingCapture');
  }
});

// ── Tracing ───────────────────────────────────────────────────────────────────
function getTraceOptions() {
  const numColors = parseInt(slColors.value, 10);
  const colorQuantization = Math.round(((numColors - 2) / 14) * 100);

  return {
    colorQuantization,
    smoothing: parseInt(slSmooth.value, 10),
    simplification: parseInt(slSimplify.value, 10),
    removeBackground: toggleBg.checked,
    bgTolerance: parseInt(slBgTolerance.value, 10),
    bgSampleRadius: parseInt(slBgSample.value, 10),
    bgExpand: parseInt(slBgExpand.value, 10),
    trimTransparent: toggleTrimTransparent.checked,
    pathCoverage: parseInt(slPathLimit.value, 10),
    bgSeedPoint,
  };
}

btnTrace.addEventListener('click', () => {
  if (!capturedImageData) return;
  startTrace();
});

function startTrace() {
  loadingOverlay.classList.add('visible');
  btnTrace.disabled = true;
  setStatus('Tracing…', '');

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

  tracerWorker.postMessage({
    type: 'TRACE',
    imageData: capturedImageData,
    options: getTraceOptions(),
  });
}

// ── SVG canvas / editing ─────────────────────────────────────────────────────
async function loadSvgIntoCanvas(svgString, { resetHistory = false } = {}) {
  currentSVGString = svgString;

  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  const svgW = parseFloat(svgEl?.getAttribute('width') ?? capturedImageData?.width ?? 1);
  const svgH = parseFloat(svgEl?.getAttribute('height') ?? capturedImageData?.height ?? 1);

  const panelW = (document.getElementById('canvas-wrap').clientWidth || 320) - 4;
  const scale = Math.min(1, panelW / svgW);
  const dispW = Math.round(svgW * scale);
  const dispH = Math.round(svgH * scale);

  canvasEl.style.display = 'block';
  canvasEmpty.style.display = 'none';

  clearSelectionHighlight();
  initFabric();
  fabricCanvas.setDimensions({ width: dispW, height: dispH });
  fabricCanvas.setZoom(scale);

  const { objects } = await loadSVGFromString(svgString);
  objects.filter(Boolean).forEach((obj) => {
    obj.set({
      selectable: true,
      hasControls: false,
      hasBorders: true,
      lockMovementX: true,
      lockMovementY: true,
      hoverCursor: 'pointer',
      borderColor: HIGHLIGHT_OUTLINE,
      borderScaleFactor: 2,
      transparentCorners: false,
      cornerStyle: 'circle',
      cornerColor: HIGHLIGHT_OUTLINE,
    });
    fabricCanvas.add(obj);
  });

  fabricCanvas.requestRenderAll();
  updateDeleteBtn();
  updateEstimatedSize(svgString);
  updateFillColorUI();

  if (resetHistory) {
    clearUndoStack();
  }
}

async function onTraceSuccess(svgString) {
  await loadSvgIntoCanvas(svgString, { resetHistory: true });
  const count = fabricCanvas.getObjects().length;
  btnDownload.disabled = false;
  btnCopy.disabled = false;
  setStatus(`Traced ${count} paths. Click a path to inspect its outline, recolor it, delete it, or undo changes.`, 'ok');
}

function canvasToSVGString() {
  if (!fabricCanvas) return currentSVGString;
  clearSelectionHighlight();
  const activeObjects = fabricCanvas.getActiveObjects();
  fabricCanvas.discardActiveObject();
  const svg = fabricCanvas.toSVG();
  if (activeObjects.length) {
    if (activeObjects.length === 1) {
      fabricCanvas.setActiveObject(activeObjects[0]);
    } else {
      const selection = new ActiveSelection(activeObjects, { canvas: fabricCanvas });
      fabricCanvas.setActiveObject(selection);
    }
  }
  handleSelectionChange();
  return svg;
}

function applyExportOptions(svgString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgString, 'image/svg+xml');
  const svgEl = doc.querySelector('svg');
  if (!svgEl) return svgString;

  const originalWidth = parsePositiveInt(svgEl.getAttribute('width')) ?? capturedImageData?.width ?? 1;
  const originalHeight = parsePositiveInt(svgEl.getAttribute('height')) ?? capturedImageData?.height ?? 1;
  const exportWidth = parsePositiveInt(inputExportWidth.value);
  const exportHeight = parsePositiveInt(inputExportHeight.value);

  if (toggleOmitDimensions.checked) {
    svgEl.removeAttribute('width');
    svgEl.removeAttribute('height');
  } else {
    svgEl.setAttribute('width', String(exportWidth ?? originalWidth));
    svgEl.setAttribute('height', String(exportHeight ?? originalHeight));
  }

  if (!svgEl.getAttribute('viewBox')) {
    svgEl.setAttribute('viewBox', `0 0 ${originalWidth} ${originalHeight}`);
  }

  return new XMLSerializer().serializeToString(doc);
}

function getExportSVGString() {
  return applyExportOptions(canvasToSVGString());
}

async function undoLastEdit() {
  if (!undoStack.length) return;
  const previousSvg = undoStack.pop();
  updateUndoBtn();
  await loadSvgIntoCanvas(previousSvg);
  setStatus('Undid the last edit.', 'ok');
}

function deleteSelected() {
  if (!fabricCanvas) return;
  const toRemove = fabricCanvas.getActiveObjects();
  if (!toRemove.length) return;

  pushUndoState(canvasToSVGString());
  clearSelectionHighlight();
  fabricCanvas.discardActiveObject();
  toRemove.forEach((obj) => fabricCanvas.remove(obj));
  fabricCanvas.requestRenderAll();

  currentSVGString = canvasToSVGString();
  updateEstimatedSize(currentSVGString);
  updateDeleteBtn();
  updateFillColorUI();
  setStatus('Selection removed. Use Undo if you want it back.', 'ok');
}

function applySelectedFillColor(color) {
  if (!fabricCanvas) return;
  const activeObjects = fabricCanvas.getActiveObjects();
  if (!activeObjects.length) return;

  pushUndoState(canvasToSVGString());
  activeObjects.forEach((obj) => {
    obj.set('fill', color);
    if (obj._objects?.length) {
      obj._objects.forEach((child) => child.set('fill', color));
    }
  });

  fabricCanvas.requestRenderAll();
  currentSVGString = canvasToSVGString();
  updateEstimatedSize(currentSVGString);
  updateFillColorUI();
  setStatus(`Selected object color changed to ${color}.`, 'ok');
}

btnDeleteSel.addEventListener('click', deleteSelected);
btnUndo.addEventListener('click', () => {
  undoLastEdit();
});

// ── Export ───────────────────────────────────────────────────────────────────
btnDownload.addEventListener('click', () => {
  const svg = getExportSVGString();
  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capture-${Date.now()}.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  setStatus('SVG downloaded.', 'ok');
});

btnCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(getExportSVGString());
    setStatus('SVG copied to clipboard!', 'ok');
  } catch {
    setStatus('Clipboard write failed.', 'err');
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls = '') {
  statusEl.textContent = msg;
  statusEl.className = cls;
}

setFillControlsDisabled(true);
updateWandUI();
updateUndoBtn();
updateEstimatedSize('');
loadUndoStepsSetting().catch((err) => {
  setStatus(`Failed to load undo setting: ${err.message}`, 'err');
});
