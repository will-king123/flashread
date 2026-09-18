const DEFAULT_APP_URL = 'https://flashread-live.onrender.com';
const appUrlInput = document.getElementById('appUrl');
const statusEl = document.getElementById('status');

chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL }, ({ appUrl }) => {
  appUrlInput.value = appUrl;
});

document.getElementById('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const appUrl = appUrlInput.value.trim().replace(/\/$/, '');
  chrome.storage.sync.set({ appUrl }, () => {
    statusEl.textContent = 'Saved.';
    setTimeout(() => { statusEl.textContent = ''; }, 2000);
  });
});
