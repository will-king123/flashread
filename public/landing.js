function buildDemoWords() {
  const title = document.querySelector('.landing-title')?.textContent?.trim() ?? '';
  const tagline = document.querySelector('.landing-tagline')?.textContent?.trim() ?? '';
  return `${title} ${tagline}`.split(/\s+/).filter(Boolean);
}

const DEMO_WORDS = buildDemoWords();
const DEMO_WPM = 320;
const FOCAL_INDEX = 2;

const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('quickread-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);

themeToggle?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('quickread-theme', next);
});

const accent = localStorage.getItem('quickread-accent');
if (accent) document.documentElement.setAttribute('data-accent', accent);

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
