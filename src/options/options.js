const STORAGE_KEY = 'undoSteps';
const DEFAULT_UNDO_STEPS = 10;

const slider = document.getElementById('sl-undo-steps');
const valueEl = document.getElementById('sl-undo-steps-val');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('btn-save');

function setStatus(message) {
  statusEl.textContent = message;
}

function syncLabel() {
  valueEl.textContent = slider.value;
}

async function loadOptions() {
  const stored = await chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_UNDO_STEPS });
  slider.value = String(stored[STORAGE_KEY]);
  syncLabel();
}

slider.addEventListener('input', () => {
  syncLabel();
  setStatus('Unsaved changes');
});

saveBtn.addEventListener('click', async () => {
  await chrome.storage.sync.set({ [STORAGE_KEY]: parseInt(slider.value, 10) });
  setStatus('Saved');
});

loadOptions().catch((err) => {
  setStatus(`Failed to load options: ${err.message}`);
});
