'use strict';

/**
 * SVG Grabber – Background Service Worker
 *
 * Responsibilities:
 *  - Open the side panel when the action button is clicked, then inject the
 *    marquee overlay into the active tab.
 *  - Accept a CAPTURE_AREA message from the content script, capture the
 *    visible tab with chrome.tabs.captureVisibleTab, persist the payload to
 *    session storage, and broadcast a SCREENSHOT_TAKEN message to the side
 *    panel.
 *  - Accept a START_MARQUEE message from the side panel ("New Capture"
 *    button) and inject the overlay into the current active tab.
 */

// ── Action click: open panel + inject overlay ────────────────────────────────
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return;

  await chrome.sidePanel.open({ tabId: tab.id });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content_scripts/overlay.js'],
    });
  } catch (err) {
    // Tab may be a chrome:// page or PDF viewer – silently ignore.
    console.warn('[SVG Grabber] Could not inject overlay:', err.message);
  }
});

// ── Message routing ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, _sendResponse) => {

  // ── Side panel "New Capture" button ─────────────────────────────────────
  if (message.type === 'START_MARQUEE') {
    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      if (!tab) return;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content_scripts/overlay.js'],
        });
      } catch (err) {
        console.warn('[SVG Grabber] Could not inject overlay:', err.message);
      }
    });
    return false;
  }

  // ── Content script finished drawing ─────────────────────────────────────
  if (message.type === 'CAPTURE_AREA') {
    const { rect, devicePixelRatio } = message;
    const windowId = sender.tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;

    chrome.tabs.captureVisibleTab(windowId, { format: 'png', quality: 100 }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error('[SVG Grabber] captureVisibleTab:', chrome.runtime.lastError.message);
        return;
      }

      const payload = { dataUrl, rect, devicePixelRatio, ts: Date.now() };

      // Persist so the side panel can poll on load (handles race conditions).
      chrome.storage.session.set({ pendingCapture: payload });

      // Also broadcast directly for panels already listening.
      chrome.runtime.sendMessage({ type: 'SCREENSHOT_TAKEN', ...payload })
        .catch(() => { /* panel may not be listening yet – storage covers it */ });
    });

    return true; // async response
  }

  return false;
});
