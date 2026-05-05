/**
 * SVG Grabber – Marquee Capture Overlay (content script)
 *
 * Injected into the active tab.  Renders a full-screen transparent overlay;
 * the user drags a rectangle to define the capture area.  On mouse-up the
 * viewport-relative coordinates (and the current devicePixelRatio for HiDPI
 * correction) are sent to the background service worker, then every trace of
 * the overlay is removed from the host page's DOM.
 */
(function () {
  'use strict';

  // ── Guard: prevent double-injection ──────────────────────────────────────
  if (document.getElementById('__svg-grabber-overlay__')) return;

  // ── Create DOM elements ───────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = '__svg-grabber-overlay__';
  Object.assign(overlay.style, {
    all: 'initial',
    position: 'fixed',
    inset: '0',
    zIndex: '2147483647',
    cursor: 'crosshair',
    userSelect: 'none',
    WebkitUserSelect: 'none',
    background: 'rgba(0,0,0,0.38)',
  });

  // Selection rectangle – white dashed border with dark shadow so it remains
  // visible on both very dark and very light websites.
  const selBox = document.createElement('div');
  Object.assign(selBox.style, {
    all: 'initial',
    position: 'fixed',
    display: 'none',
    boxSizing: 'border-box',
    border: '2px dashed #ffffff',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.85), inset 0 0 0 1px rgba(0,0,0,0.85)',
    background: 'rgba(255,255,255,0.07)',
    pointerEvents: 'none',
  });

  // Hint tooltip shown before the user starts drawing.
  const hint = document.createElement('div');
  Object.assign(hint.style, {
    all: 'initial',
    position: 'fixed',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%,-50%)',
    padding: '10px 22px',
    borderRadius: '8px',
    background: 'rgba(0,0,0,0.78)',
    color: '#fff',
    fontFamily: 'system-ui,-apple-system,sans-serif',
    fontSize: '14px',
    lineHeight: '1.5',
    textAlign: 'center',
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
  });
  hint.textContent = 'Drag to select an area  •  Esc to cancel';

  overlay.appendChild(selBox);
  overlay.appendChild(hint);

  // ── State ─────────────────────────────────────────────────────────────────
  let startX = 0, startY = 0;
  let dragging = false;

  // ── Helpers ───────────────────────────────────────────────────────────────
  function updateSelBox(x1, y1, x2, y2) {
    const left   = Math.min(x1, x2);
    const top    = Math.min(y1, y2);
    const width  = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    Object.assign(selBox.style, {
      left:    `${left}px`,
      top:     `${top}px`,
      width:   `${width}px`,
      height:  `${height}px`,
      display: 'block',
    });
  }

  function teardown() {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
  }

  // ── Event handlers ────────────────────────────────────────────────────────
  overlay.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hint.style.display = 'none';
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    updateSelBox(startX, startY, startX, startY);
  }, true);

  overlay.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    updateSelBox(startX, startY, e.clientX, e.clientY);
  }, true);

  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;

    const rect = {
      x:      Math.round(Math.min(startX, e.clientX)),
      y:      Math.round(Math.min(startY, e.clientY)),
      width:  Math.round(Math.abs(e.clientX - startX)),
      height: Math.round(Math.abs(e.clientY - startY)),
    };

    // Require a minimum selection to avoid accidental single-clicks.
    if (rect.width < 8 || rect.height < 8) {
      teardown();
      return;
    }

    // Send coordinates + HiDPI ratio to the service worker for capture.
    chrome.runtime.sendMessage({
      type: 'CAPTURE_AREA',
      rect,
      devicePixelRatio: window.devicePixelRatio || 1,
    });

    teardown();
  }, true);

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      teardown();
    }
  }
  document.addEventListener('keydown', onKey, true);

  // ── Inject ────────────────────────────────────────────────────────────────
  document.body.appendChild(overlay);
})();
