function buildDemoWords() {
  const title = document.querySelector('.landing-title')?.textContent?.trim() ?? '';
  const tagline = document.querySelector('.landing-tagline')?.textContent?.trim() ?? '';
  return `${title} ${tagline}`.split(/\s+/).filter(Boolean);
}

const DEMO_WORDS = buildDemoWords();
const DEMO_WPM = 320;
const FOCAL_INDEX = 2;

const ACCENTS = {
  terracotta: { light: { accent: '#c45d3e', hover: '#a84d32' }, dark: { accent: '#d4846a', hover: '#e09980' } },
  sage: { light: { accent: '#5c8a6e', hover: '#4a7358' }, dark: { accent: '#7db892', hover: '#8fc9a0' } },
  teal: { light: { accent: '#2a8a8a', hover: '#226f6f' }, dark: { accent: '#4db8b8', hover: '#5ecaca' } },
  indigo: { light: { accent: '#5b6eae', hover: '#4a5a8f' }, dark: { accent: '#8a9ed4', hover: '#9eb0de' } },
  amber: { light: { accent: '#c17f24', hover: '#a3691d' }, dark: { accent: '#daa044', hover: '#e8b050' } },
  rose: { light: { accent: '#b85c7a', hover: '#9a4d65' }, dark: { accent: '#d8839e', hover: '#e89ab0' } },
};

function rgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

let currentAccent = localStorage.getItem('quickread-accent') || 'terracotta';

function applyAccent(name) {
  if (!ACCENTS[name]) name = 'terracotta';
  currentAccent = name;
  const theme = document.documentElement.getAttribute('data-theme') || 'light';
  const { accent, hover } = ACCENTS[name][theme];
  const root = document.documentElement;
  root.style.setProperty('--accent', accent);
  root.style.setProperty('--accent-hover', hover);
  root.style.setProperty('--focal', accent);
  root.style.setProperty('--progress-fill', accent);
  root.style.setProperty('--guide', rgba(accent, theme === 'light' ? 0.25 : 0.3));
  root.style.setProperty('--select-bg', rgba(accent, theme === 'light' ? 0.08 : 0.12));
  document.querySelectorAll('.accent-swatch').forEach((btn) => {
    btn.setAttribute('aria-pressed', btn.dataset.accent === name ? 'true' : 'false');
  });
  localStorage.setItem('quickread-accent', name);
}

const themeToggle = document.getElementById('themeToggle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPopover = document.getElementById('settingsPopover');
const savedTheme = localStorage.getItem('quickread-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
if (themeToggle) themeToggle.checked = savedTheme === 'dark';
applyAccent(currentAccent);

themeToggle?.addEventListener('change', () => {
  const next = themeToggle.checked ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('quickread-theme', next);
  applyAccent(currentAccent);
});

settingsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPopover.classList.toggle('hidden');
  settingsBtn.setAttribute('aria-expanded', settingsPopover.classList.contains('hidden') ? 'false' : 'true');
});

document.querySelectorAll('.accent-swatch').forEach((btn) => {
  btn.addEventListener('click', () => applyAccent(btn.dataset.accent));
});

document.addEventListener('click', (e) => {
  if (!settingsPopover || settingsPopover.classList.contains('hidden')) return;
  if (settingsPopover.contains(e.target) || settingsBtn.contains(e.target)) return;
  settingsPopover.classList.add('hidden');
  settingsBtn.setAttribute('aria-expanded', 'false');
});

const wordEl = document.getElementById('landingWord');
let wordIndex = 0;
let timer = null;
let demoPaused = false;

function focalSplit(word) {
  if (word.length <= 1) return { before: '', focal: word, after: '' };
  const i = Math.min(FOCAL_INDEX, word.length - 1);
  return { before: word.slice(0, i), focal: word[i], after: word.slice(i + 1) };
}

function renderWord(word) {
  if (!wordEl) return;
  const { before, focal, after } = focalSplit(word);
  wordEl.classList.remove('no-focal');
  wordEl.innerHTML = `<span class="before">${before}</span><span class="focal">${focal}</span><span class="after">${after}</span>`;
  wordEl.classList.remove('word-enter');
  void wordEl.offsetWidth;
  wordEl.classList.add('word-enter');
}

function tickDemo() {
  renderWord(DEMO_WORDS[wordIndex]);
  wordIndex = (wordIndex + 1) % DEMO_WORDS.length;
}

function pauseDemo() {
  clearInterval(timer);
  timer = null;
  demoPaused = true;
}

function resumeDemo() {
  if (!wordEl || demoPaused === false && timer) return;
  demoPaused = false;
  timer = setInterval(tickDemo, Math.round(60000 / DEMO_WPM));
}

function startDemo() {
  if (!wordEl || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (wordEl) renderWord(DEMO_WORDS[0]);
    return;
  }
  demoPaused = false;
  tickDemo();
  timer = setInterval(tickDemo, Math.round(60000 / DEMO_WPM));
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || !wordEl) return;
  const el = document.activeElement;
  if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || (el.tagName === 'INPUT' && !['button', 'submit', 'checkbox', 'radio', 'range'].includes((el.type || 'text').toLowerCase())))) return;
  e.preventDefault();
  if (timer) pauseDemo();
  else if (demoPaused) resumeDemo();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    clearInterval(timer);
    timer = null;
  } else if (!timer) startDemo();
});

startDemo();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
