const DEFAULT_APP_URL = 'https://flashread-live.onrender.com';
const MAX_SELECTION_CHARS = 12000;

async function getAppUrl() {
  const { appUrl } = await chrome.storage.sync.get({ appUrl: DEFAULT_APP_URL });
  return appUrl.replace(/\/$/, '');
}

function openQuickread(params) {
  getAppUrl().then((base) => {
    params.set('source', 'extension');
    chrome.tabs.create({ url: `${base}/?${params.toString()}` });
  });
}

function readPage(tab) {
  if (!tab?.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;
  const params = new URLSearchParams();
  params.set('url', tab.url);
  openQuickread(params);
}

function readSelection(info, tab) {
  const text = info.selectionText?.trim();
  if (!text) return;
  const params = new URLSearchParams();
  params.set('text', text.length > MAX_SELECTION_CHARS ? text.slice(0, MAX_SELECTION_CHARS) : text);
  params.set('title', tab?.title || 'Selected text');
  openQuickread(params);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'quickread-selection',
      title: 'Speed read selection in Quickread',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'quickread-page',
      title: 'Speed read this page in Quickread',
      contexts: ['page'],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'quickread-selection') readSelection(info, tab);
  if (info.menuItemId === 'quickread-page') readPage(tab);
});

chrome.action.onClicked.addListener((tab) => readPage(tab));
