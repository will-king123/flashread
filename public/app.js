// State
let words = [];
let currentIndex = 0;
let isPlaying = false;
let timer = null;
let finishTimer = null;
let wpm = 300;
let focalEnabled = true;
let sentencePauseEnabled = true;
let fontSize = 3.5;
const FONT_SIZE_MIN = 2;
const FONT_SIZE_MAX = 6;
let loadedContent = null;
let manualSelection = '';
let currentUrl = '';
let pdfLoadTimer = null;
let pdfWordsPerPage = null;
let pendingDeepLink = null;
const PDF_WORDS_PER_PAGE_ESTIMATE = 250;
let readingStartTime = null;
let touchStartX = 0;
let savedProgress = null;
let deferredInstallPrompt = null;

const SAMPLE_TEXT = 'Speed reading works by presenting one word at a time at a fixed point on screen. Your eyes stay still while the words come to you. This cuts out the time spent moving your eyes across lines and reduces regressions — those moments when you jump back to re-read something.';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

(function migrateLegacyStorage() {
  const legacy = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key?.startsWith('flashread-')) legacy.push(key);
  }
  for (const key of legacy) {
    const next = key.replace(/^flashread-/, 'quickread-');
    if (localStorage.getItem(next) == null) {
      localStorage.setItem(next, localStorage.getItem(key));
    }
  }
})();

async function apiFetch(url, options, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      if ([502, 503, 504].includes(res.status) && attempt < retries) {
        setStatus('Server waking up… retrying', false);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < retries) {
        setStatus('Server waking up… retrying', false);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw err;
    }
  }
}

function markUsed() {
  localStorage.setItem('quickread-used', '1');
  document.getElementById('examples')?.classList.add('hidden');
}

function maybeShowInstallNudge() {
  if (!deferredInstallPrompt) return;
  if (localStorage.getItem('quickread-install-dismissed')) return;
  if (window.matchMedia('(display-mode: standalone)').matches) return;
  document.getElementById('installBanner')?.classList.remove('hidden');
}

// WPM finder state
let calWpm = 250;
let calTimer = null;
let calLevelTimer = null;
let calRunning = false;
const CAL_WPM_START = 250;
const CAL_WPM_MAX = 1000;
const CAL_WPM_STEP = 50;
const CAL_LEVEL_MS = 10000;

let calWordQueue = [];
let calRecentPhrases = [];

function wpmToPercentile(speed) {
  const anchors = [
    [200, 45], [250, 58], [300, 68], [350, 76], [400, 83],
    [450, 88], [500, 92], [550, 95], [600, 97], [650, 98],
    [750, 99], [1000, 99],
  ];
  if (speed <= anchors[0][0]) return anchors[0][1];
  for (let i = 1; i < anchors.length; i++) {
    if (speed <= anchors[i][0]) {
      const [w0, p0] = anchors[i - 1];
      const [w1, p1] = anchors[i];
      const t = (speed - w0) / (w1 - w0);
      return Math.round(p0 + t * (p1 - p0));
    }
  }
  return 99;
}

function pickCalPhrase(pool) {
  const recent = new Set(calRecentPhrases);
  const fresh = pool.filter(p => !recent.has(p));
  const choices = fresh.length ? fresh : pool;
  const phrase = choices[Math.floor(Math.random() * choices.length)];
  calRecentPhrases.push(phrase);
  if (calRecentPhrases.length > 6) calRecentPhrases.shift();
  return phrase;
}

function calPercentilePhrases(speed) {
  const pct = wpmToPercentile(speed);
  return [
    `At this pace you're already faster than about ${pct} percent of people`,
    `Most adults land somewhere between two hundred and three hundred words a minute`,
    `Only a small fraction of people sustain five hundred with full comprehension`,
    `Researchers reckon the average silent reading speed is two hundred and thirty eight`,
    `People almost always think they read faster than they actually do`,
  ];
}

function calFactPhrases(speed) {
  const pageSec = Math.max(1, Math.round((250 / speed) * 60));
  return [
    `When you read silently there's a voice in your head saying every word`,
    `That inner voice is called subvocalization and almost everyone does it`,
    `Your eyes jumping across a page is another thing that eats up time`,
    `One word at a time like this is called rapid serial visual presentation`,
    `It sounds technical but the idea is dead simple`,
    `No eye movement no scanning back and forth just one word appearing in the same spot`,
    `Researchers say it's like switching from a crowded hallway to an empty one`,
    `Your brain isn't juggling as many tasks so it can move faster`,
    `Fiction reads faster than non-fiction because the words tend to be shorter`,
    `Nobody reads terms and conditions at full speed and that's fine`,
    `A novel page at this pace takes roughly ${pageSec} seconds`,
    `Comprehension usually holds up until things get really quick`,
    `Speed readers can push past five hundred but that's a different skill entirely`,
    `The world speed reading record is somewhere above a thousand words a minute`,
    `Bill Gates finishes about fifty books a year most people manage a handful`,
    `Warren Buffett apparently reads five hundred pages a day`,
    `Your reading speed isn't fixed you can train it like anything else`,
    `Harry Potter gets progressively longer and people still binge the whole series`,
    `That's the pull of a good story your brain wants the next word`,
    `Academic papers are brutal because of the jargon and the footnotes`,
    `Most people feel pretty comfortable around three hundred words a minute`,
    `Then it bumps up and suddenly the words start turning into a blur`,
    `Somewhere past six hundred is where most people lose the thread entirely`,
  ];
}

function calSpeedupPhrases() {
  return [
    `Things pick up from here`,
    `It gets quicker now`,
    `A little faster`,
    `The pace moves up`,
    `Speed increases`,
    `Here we go faster`,
  ];
}

function calIntroPhrases() {
  return [
    `Most people have no idea how fast they actually read`,
    `There's a whole science behind reading speed that most of us never think about`,
    `Your brain can take in words much faster than your eyes usually allow`,
    `Silent reading as we know it is only a few hundred years old`,
  ];
}

function enqueueCalPhrase(phrase) {
  calWordQueue.push(...tokenize(phrase));
}

function refillCalQueue(speed) {
  const pools = [calPercentilePhrases(speed), calFactPhrases(speed)];
  const pool = pools[Math.floor(Math.random() * pools.length)];
  enqueueCalPhrase(pickCalPhrase(pool));
}

function primeCalQueue(intro = false) {
  calWordQueue = [];
  calRecentPhrases = [];
  if (intro) enqueueCalPhrase(pickCalPhrase(calIntroPhrases()));
  refillCalQueue(calWpm);
  refillCalQueue(calWpm);
}

function injectCalSpeedup() {
  calWordQueue = [];
  enqueueCalPhrase(pickCalPhrase(calSpeedupPhrases()));
  refillCalQueue(calWpm);
  refillCalQueue(calWpm);
}

// DOM
const inputPanel = document.getElementById('inputPanel');
const selectPanel = document.getElementById('selectPanel');
const readerPanel = document.getElementById('readerPanel');
const linkForm = document.getElementById('linkForm');
const linkInput = document.getElementById('linkInput');
const goBtn = document.getElementById('goBtn');
const inputStatus = document.getElementById('inputStatus');
const textToggle = document.getElementById('textToggle');
const textFallback = document.getElementById('textFallback');
const textInput = document.getElementById('textInput');
const textStartBtn = document.getElementById('textStartBtn');
const resumeBanner = document.getElementById('resumeBanner');
const resumeTitle = document.getElementById('resumeTitle');
const resumeBtn = document.getElementById('resumeBtn');
const dismissResume = document.getElementById('dismissResume');
const historyWrap = document.getElementById('historyWrap');
const recentList = document.getElementById('recentList');
const backToInput = document.getElementById('backToInput');
const docTitle = document.getElementById('docTitle');
const pdfPicker = document.getElementById('pdfPicker');
const pageFrom = document.getElementById('pageFrom');
const pageTo = document.getElementById('pageTo');
const pageTotal = document.getElementById('pageTotal');
const pdfStatus = document.getElementById('pdfStatus');
const sectionPicker = document.getElementById('sectionPicker');
const sectionList = document.getElementById('sectionList');
const selectAllBtn = document.getElementById('selectAllBtn');
const selectNoneBtn = document.getElementById('selectNoneBtn');
const previewWrap = document.getElementById('previewWrap');
const preview = document.getElementById('preview');
const wordCount = document.getElementById('wordCount');
const timeEstimate = document.getElementById('timeEstimate');
const wpmSlider = document.getElementById('wpmSlider');
const wpmValue = document.getElementById('wpmValue');
const focalToggle = document.getElementById('focalToggle');
const sentencePauseToggle = document.getElementById('sentencePauseToggle');
const fontSlider = document.getElementById('fontSlider');
const fontSizeValue = document.getElementById('fontSizeValue');
const fileDrop = document.getElementById('fileDrop');
const fileInput = document.getElementById('fileInput');
const fileBrowseBtn = document.getElementById('fileBrowseBtn');
const startBtn = document.getElementById('startBtn');
const shareLinkBtn = document.getElementById('shareLinkBtn');
const readerDisplay = document.getElementById('readerDisplay');
const wordContainer = document.getElementById('wordContainer');
const finishOverlay = document.getElementById('finishOverlay');
const finishStats = document.getElementById('finishStats');
const readAgainBtn = document.getElementById('readAgainBtn');
const continuePdfBtn = document.getElementById('continuePdfBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const progressBar = document.getElementById('progressBar');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const playPauseBtn = document.getElementById('playPauseBtn');
const backStartBtn = document.getElementById('backStartBtn');
const backBtn = document.getElementById('backBtn');
const forwardBtn = document.getElementById('forwardBtn');
const backToSelect = document.getElementById('backToSelect');
const readerWpm = document.getElementById('readerWpm');
const wpmDown = document.getElementById('wpmDown');
const wpmUp = document.getElementById('wpmUp');
const timeLeft = document.getElementById('timeLeft');
const themeToggle = document.getElementById('themeToggle');
const settingsBtn = document.getElementById('settingsBtn');
const settingsPopover = document.getElementById('settingsPopover');
const appEl = document.querySelector('.app');
const examplesEl = document.getElementById('examples');
const installBanner = document.getElementById('installBanner');
const installBtn = document.getElementById('installBtn');
const installDismiss = document.getElementById('installDismiss');
const wpmNudge = document.getElementById('wpmNudge');
const wpmNudgeStart = document.getElementById('wpmNudgeStart');
const wpmNudgeDismiss = document.getElementById('wpmNudgeDismiss');
const wpmFinderTry = document.getElementById('wpmFinderTry');
const WPM_DEMO_URL = 'https://en.wikipedia.org/wiki/Speed_reading';

function syncReaderHeader() {
  backToSelect.classList.toggle('hidden', readerPanel.classList.contains('hidden'));
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function parseDeepLink() {
  const p = new URLSearchParams(location.search);
  const url = p.get('url');
  if (!url || !isUrl(url)) return null;
  return {
    url,
    section: p.get('section'),
    pages: p.get('pages'),
    wpm: p.get('wpm'),
  };
}

function applyDeepLinkPages(pagesParam) {
  const m = pagesParam?.match(/^(\d+)-(\d+)$/);
  if (!m) return;
  const from = parseInt(m[1], 10);
  const to = parseInt(m[2], 10);
  const max = parseInt(pageTo.max, 10) || to;
  pageFrom.value = Math.max(1, Math.min(from, max));
  pageTo.value = Math.max(parseInt(pageFrom.value, 10), Math.min(to, max));
}

function applyDeepLinkSections(sectionParam) {
  if (!sectionParam || !loadedContent?.sections?.length) return;
  const wanted = sectionParam.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  sectionList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    const sec = loadedContent.sections.find(s => s.id === cb.dataset.id);
    if (!sec) return;
    cb.checked = wanted.includes(sec.id.toLowerCase()) || wanted.includes(slugify(sec.title));
  });
}

function buildShareUrl() {
  if (!currentUrl) return null;
  const p = new URLSearchParams();
  p.set('url', currentUrl);

  if (loadedContent?.type === 'pdf') {
    p.set('pages', `${pageFrom.value}-${pageTo.value}`);
  } else if (loadedContent?.sections?.length) {
    const checked = [...sectionList.querySelectorAll('input:checked')];
    if (checked.length > 0 && checked.length < loadedContent.sections.length) {
      p.set('section', checked.map(cb => {
        const sec = loadedContent.sections.find(s => s.id === cb.dataset.id);
        return sec ? slugify(sec.title) : cb.dataset.id;
      }).join(','));
    }
  }

  if (wpm !== 300) p.set('wpm', wpm);
  return `${location.origin}${location.pathname}?${p.toString()}`;
}

function syncShareUrl() {
  if (!currentUrl) return;
  const share = buildShareUrl();
  if (share) history.replaceState(null, '', share);
}

function updatePdfEstimate() {
  if (loadedContent?.type !== 'pdf') return;

  const from = parseInt(pageFrom.value, 10) || 1;
  const to = parseInt(pageTo.value, 10) || 1;
  const total = loadedContent.totalPages || 1;

  if (from < 1 || to < from || from > total) {
    pdfStatus.textContent = 'Enter a valid page range';
    pdfStatus.classList.add('error-msg');
    return;
  }

  pdfStatus.classList.remove('error-msg');
  const pageCount = to - from + 1;
  const hasText = Boolean(loadedContent.text?.trim());
  const words = hasText
    ? countWords(loadedContent.text)
    : Math.round(pageCount * (pdfWordsPerPage || PDF_WORDS_PER_PAGE_ESTIMATE));
  const estPrefix = hasText ? '' : '~';
  const timeStr = formatTime(estimateSecondsForWordCount(words, wpm));
  const loading = pdfStatus.dataset.loading === '1';

  if (hasText) {
    pdfStatus.textContent = `${words.toLocaleString()} words · ${estPrefix}${timeStr} at ${wpm} WPM`;
  } else {
    pdfStatus.textContent = `${estPrefix}${timeStr} at ${wpm} WPM for pages ${from}–${to}`;
    if (loading) pdfStatus.textContent += ' · loading text…';
  }
}
const focalGuide = document.querySelector('.focal-guide');
const findWpmBtn = document.getElementById('findWpmBtn');
const wpmFinderPanel = document.getElementById('wpmFinderPanel');
const wpmFinderBack = document.getElementById('wpmFinderBack');
const wpmFinderIntro = document.getElementById('wpmFinderIntro');
const wpmFinderStart = document.getElementById('wpmFinderStart');
const wpmFinderActive = document.getElementById('wpmFinderActive');
const wpmFinderStop = document.getElementById('wpmFinderStop');
const wpmFinderResult = document.getElementById('wpmFinderResult');
const finderWpmLabel = document.getElementById('finderWpmLabel');
const finderWordContainer = document.getElementById('finderWordContainer');
const finderScore = document.getElementById('finderScore');
const wpmFinderUse = document.getElementById('wpmFinderUse');
const wpmFinderRetry = document.getElementById('wpmFinderRetry');

// Theme & accent
const ACCENTS = {
  terracotta: {
    light: { accent: '#c45d3e', hover: '#a84d32' },
    dark:  { accent: '#d4846a', hover: '#e09980' },
  },
  sage: {
    light: { accent: '#5c8a6e', hover: '#4a7358' },
    dark:  { accent: '#7db892', hover: '#8fc9a0' },
  },
  teal: {
    light: { accent: '#2a8a8a', hover: '#226f6f' },
    dark:  { accent: '#4db8b8', hover: '#5ecaca' },
  },
  indigo: {
    light: { accent: '#5b6eae', hover: '#4a5a8f' },
    dark:  { accent: '#8a9ed4', hover: '#9eb0de' },
  },
  amber: {
    light: { accent: '#c17f24', hover: '#a3691d' },
    dark:  { accent: '#daa044', hover: '#e8b050' },
  },
  rose: {
    light: { accent: '#b85c7a', hover: '#9a4d65' },
    dark:  { accent: '#d8839e', hover: '#e89ab0' },
  },
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgba(hex, alpha) {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
  document.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.accent === name ? 'true' : 'false');
  });
  localStorage.setItem('quickread-accent', name);
}

const savedTheme = localStorage.getItem('quickread-theme') || 'light';
document.documentElement.setAttribute('data-theme', savedTheme);
applyAccent(currentAccent);

themeToggle.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('quickread-theme', next);
  applyAccent(currentAccent);
});

document.querySelectorAll('.accent-swatch').forEach(btn => {
  btn.addEventListener('click', () => applyAccent(btn.dataset.accent));
});

settingsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsPopover.classList.toggle('hidden');
  settingsBtn.setAttribute('aria-expanded', settingsPopover.classList.contains('hidden') ? 'false' : 'true');
});

document.addEventListener('click', (e) => {
  if (!settingsPopover.classList.contains('hidden') &&
      !settingsPopover.contains(e.target) &&
      !settingsBtn.contains(e.target)) {
    settingsPopover.classList.add('hidden');
    settingsBtn.setAttribute('aria-expanded', 'false');
  }
});

// Helpers
function isUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function looksLikePdf(url) {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function formatTime(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} sec`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins} min ${secs}s` : `${mins} min`;
}

function wordCoreLength(word) {
  return word.replace(/^[^\w]+|[^\w]+$/g, '').length;
}

function punctExtraMs(word, speed) {
  const base = 60000 / speed;
  if (/[.!?]["']?$/.test(word)) return base * (sentencePauseEnabled ? 1.0 : 0.3);
  if (/[;:]["']?$/.test(word)) return base * 0.2;
  if (/[,]["']?$/.test(word)) return base * 0.15;
  return 0;
}

function wordDelayMs(word, speed) {
  const base = 60000 / speed;
  let delay = base + punctExtraMs(word, speed);
  if (wordCoreLength(word) > 8) delay += base * 0.2;
  return delay;
}

function estimateSecondsForWordCount(count, speed) {
  if (count <= 0) return 0;
  return (count * wordDelayMs('reading', speed)) / 1000;
}

function estimateReadingSeconds(wordList, speed, fromIndex = 0) {
  let ms = 0;
  for (let i = fromIndex; i < wordList.length; i++) {
    ms += wordDelayMs(wordList[i], speed);
  }
  return ms / 1000;
}

function setStatus(msg, isError = false) {
  inputStatus.textContent = msg;
  inputStatus.classList.toggle('error-msg', isError);
}

function setLoading(loading) {
  goBtn.disabled = loading;
  goBtn.textContent = loading ? 'Loading…' : 'Go';
  linkInput.disabled = loading;
}

function setWpm(value) {
  wpm = Math.max(100, Math.min(1000, value));
  wpmSlider.value = wpm;
  wpmValue.textContent = wpm;
  readerWpm.textContent = `${wpm} WPM`;
  document.querySelectorAll('.preset').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.wpm, 10) === wpm);
  });
  updateTimeEstimate();
  updatePdfEstimate();
  updateTimeLeft();
  if (!readerPanel.classList.contains('hidden') || !selectPanel.classList.contains('hidden')) {
    syncShareUrl();
  }
  if (isPlaying) restartTimer();
}

// Recent links
function getRecents() {
  try {
    return JSON.parse(localStorage.getItem('quickread-recents') || '[]');
  } catch {
    return [];
  }
}

function saveRecent(url, title) {
  const recents = getRecents().filter(r => r.url !== url);
  recents.unshift({ url, title, date: Date.now() });
  localStorage.setItem('quickread-recents', JSON.stringify(recents.slice(0, 5)));
  renderRecents();
}

function renderRecents() {
  const recents = getRecents();
  if (!recents.length) {
    historyWrap.classList.add('hidden');
    return;
  }
  historyWrap.classList.remove('hidden');
  recentList.innerHTML = recents.map(r =>
    `<li><button class="recent-item" data-url="${escapeHtml(r.url)}">${escapeHtml(r.title || r.url)}</button></li>`
  ).join('');
}

recentList.addEventListener('click', (e) => {
  const btn = e.target.closest('.recent-item');
  if (!btn) return;
  linkInput.value = btn.dataset.url;
  linkForm.requestSubmit();
});

// Session resume
function saveSession() {
  if (!words.length) return;
  const session = {
    title: loadedContent?.title || 'Reading',
    index: currentIndex,
    wpm,
    focalEnabled,
    sentencePauseEnabled,
    url: currentUrl,
    type: loadedContent?.type || 'text',
  };
  if (!currentUrl && loadedContent?.text) {
    session.text = loadedContent.text.slice(0, 50000);
  }
  if (loadedContent?.type === 'pdf') {
    session.pdfStartPage = parseInt(pageFrom.value, 10);
    session.pdfEndPage = parseInt(pageTo.value, 10);
    session.totalPages = loadedContent.totalPages;
  }
  localStorage.setItem('quickread-session', JSON.stringify(session));
}

function clearSession() {
  localStorage.removeItem('quickread-session');
}

function checkResume() {
  try {
    const session = JSON.parse(localStorage.getItem('quickread-session') || 'null');
    if (!session || session.index <= 0) return;
    resumeTitle.textContent = session.title;
    resumeBanner.classList.remove('hidden');
    resumeBanner._session = session;
  } catch { /* ignore */ }
}

resumeBtn.addEventListener('click', async () => {
  const session = resumeBanner._session;
  if (!session) return;
  resumeBanner.classList.add('hidden');

  wpm = session.wpm || 300;
  focalEnabled = session.focalEnabled !== false;
  sentencePauseEnabled = session.sentencePauseEnabled !== false;
  focalToggle.checked = focalEnabled;
  sentencePauseToggle.checked = sentencePauseEnabled;
  setWpm(wpm);
  currentUrl = session.url || '';

  if (session.url) {
    setLoading(true);
    setStatus('Restoring session…');
    try {
      if (session.type === 'pdf') {
        loadedContent = {
          type: 'pdf',
          title: session.title,
          totalPages: session.totalPages,
          text: '',
          sections: [],
        };
        pageFrom.value = session.pdfStartPage || 1;
        pageTo.value = session.pdfEndPage || session.pdfStartPage || 1;
        pageTotal.textContent = `of ${session.totalPages}`;
        await loadPdfPages();
      } else {
        const res = await fetch('/api/fetch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: session.url }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        loadedContent = data;
      }
      words = tokenize(loadedContent.text);
      currentIndex = Math.min(session.index, words.length - 1);
    } catch (err) {
      setStatus(err.message, true);
      setLoading(false);
      return;
    }
    setLoading(false);
    setStatus('');
  } else {
    loadedContent = { type: 'text', title: session.title, text: session.text, sections: [] };
    words = tokenize(session.text);
    currentIndex = session.index;
  }

  inputPanel.classList.add('hidden');
  readerPanel.classList.remove('hidden');
  syncReaderHeader();
  finishOverlay.classList.add('hidden');
  focalGuide.style.display = focalEnabled ? 'block' : 'none';
  readingStartTime = Date.now();
  renderWord();
  updateProgress();
  pause();
});

dismissResume.addEventListener('click', () => {
  resumeBanner.classList.add('hidden');
  clearSession();
});

// WPM controls
wpmSlider.addEventListener('input', () => setWpm(parseInt(wpmSlider.value, 10)));

document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => setWpm(parseInt(btn.dataset.wpm, 10)));
});

wpmDown.addEventListener('click', () => setWpm(wpm - 25));
wpmUp.addEventListener('click', () => setWpm(wpm + 25));

focalToggle.addEventListener('change', () => {
  focalEnabled = focalToggle.checked;
  focalGuide.style.display = focalEnabled ? 'block' : 'none';
  renderWord();
});

sentencePauseToggle.addEventListener('change', () => {
  sentencePauseEnabled = sentencePauseToggle.checked;
  localStorage.setItem('quickread-sentence-pause', sentencePauseEnabled ? '1' : '0');
  if (isPlaying) restartTimer();
});

function formatFontSize(value) {
  return Number(value.toFixed(2)).toString();
}

function setFontSize(value) {
  fontSize = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value));
  document.documentElement.style.setProperty('--reader-font-size', String(fontSize));
  localStorage.setItem('quickread-font-size', String(fontSize));
  if (fontSlider) {
    fontSlider.value = fontSize;
    fontSlider.setAttribute('aria-valuenow', fontSize);
  }
  if (fontSizeValue) fontSizeValue.textContent = formatFontSize(fontSize);
  if (words.length) renderWord();
}

if (fontSlider) {
  fontSlider.addEventListener('input', () => setFontSize(parseFloat(fontSlider.value)));
  fontSlider.addEventListener('change', () => setFontSize(parseFloat(fontSlider.value)));
}

textToggle.addEventListener('click', () => {
  textFallback.classList.toggle('hidden');
  textToggle.textContent = textFallback.classList.contains('hidden')
    ? 'Or paste text directly'
    : 'Hide text input';
});

// Link fetch
linkForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = linkInput.value.trim();
  if (!input) return;

  if (!isUrl(input)) {
    markUsed();
    showSelectPanel({ type: 'text', title: 'Pasted text', text: input, sections: [] });
    return;
  }

  currentUrl = input;
  setLoading(true);
  setStatus('');

  try {
    if (looksLikePdf(input)) {
      const infoRes = await apiFetch('/api/fetch-pdf-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: input }),
      });
      const info = await infoRes.json();
      if (!infoRes.ok) throw new Error(info.error);

      loadedContent = { type: 'pdf', title: info.title, totalPages: info.totalPages, text: '', sections: [] };
      pdfWordsPerPage = null;
      pageFrom.min = 1;
      pageFrom.value = 1;
      pageTo.min = 1;
      pageTo.max = info.totalPages;
      pageTo.value = Math.min(info.totalPages, 10);
      pageTotal.textContent = `of ${info.totalPages}`;

      showSelectPanel(loadedContent);
      saveRecent(input, info.title);
      markUsed();
      updatePdfEstimate();
      loadPdfPages();
      setLoading(false);
      return;
    }

    const res = await apiFetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    loadedContent = data;
    saveRecent(input, data.title);
    markUsed();
    showSelectPanel(data);
    quickreadTrack('fetch_success', { type: data.type });
  } catch (err) {
    const msg = err.message === 'Failed to fetch'
      ? (location.hostname === 'localhost'
        ? "Can't reach the app — run npm run dev and open http://localhost:3000"
        : "Can't reach the server — check your connection and try again")
      : err.message;
    quickreadTrack('fetch_error', { reason: msg });
    setStatus(msg, true);
  } finally {
    setLoading(false);
  }
});

async function loadPdfPages() {
  const from = parseInt(pageFrom.value, 10);
  const to = parseInt(pageTo.value, 10);
  if (!currentUrl || from < 1 || to < from) return;

  pdfStatus.dataset.loading = '1';
  updatePdfEstimate();
  startBtn.disabled = true;

  try {
    const res = await apiFetch('/api/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: currentUrl, startPage: from, endPage: to }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    loadedContent = { ...loadedContent, text: data.text };
    manualSelection = '';
    invalidateSavedProgress();
    pdfWordsPerPage = countWords(data.text) / (to - from + 1);
    pdfStatus.dataset.loading = '0';
    updatePdfEstimate();
    updatePreview(data.text);
    updateWordCount();
    syncShareUrl();
  } catch (err) {
    pdfStatus.dataset.loading = '0';
    pdfStatus.textContent = err.message;
    pdfStatus.classList.add('error-msg');
  }
}

function schedulePdfLoad() {
  clearTimeout(pdfLoadTimer);
  updatePdfEstimate();
  syncShareUrl();
  pdfLoadTimer = setTimeout(loadPdfPages, 400);
}

pageFrom.addEventListener('input', schedulePdfLoad);
pageTo.addEventListener('input', schedulePdfLoad);

// Sections
sectionList.addEventListener('change', () => {
  manualSelection = '';
  invalidateSavedProgress();
  updateWordCount();
  syncShareUrl();
});

function renderSections(sections) {
  sectionList.innerHTML = '';

  sections.forEach(section => {
    const li = document.createElement('li');
    li.className = 'section-item';
    li.innerHTML = `
      <label class="section-label">
        <input type="checkbox" checked data-id="${section.id}">
        <span class="section-title" style="padding-left: ${section.level * 0.75}rem">${escapeHtml(section.title)}</span>
        <span class="section-words">${countWords(section.text).toLocaleString()} w</span>
      </label>
      <button class="btn btn-text btn-sm section-read" data-id="${section.id}">Read →</button>`;
    sectionList.appendChild(li);
  });
}

sectionList.addEventListener('click', (e) => {
  const readBtn = e.target.closest('.section-read');
  if (!readBtn) return;
  sectionList.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.checked = cb.dataset.id === readBtn.dataset.id;
  });
  manualSelection = '';
  invalidateSavedProgress();
  updateWordCount();
  startReading();
});

selectAllBtn.addEventListener('click', () => {
  sectionList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = true; });
  manualSelection = '';
  invalidateSavedProgress();
  updateWordCount();
});

selectNoneBtn.addEventListener('click', () => {
  sectionList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  manualSelection = '';
  invalidateSavedProgress();
  updateWordCount();
});

function invalidateSavedProgress() {
  savedProgress = null;
}

function canResumeReading(text) {
  return savedProgress && savedProgress.text === text && savedProgress.index > 0;
}

function getSelectedText() {
  if (manualSelection) return manualSelection;
  if (loadedContent?.type === 'pdf') return loadedContent.text || '';
  if (loadedContent?.sections?.length) {
    const checked = new Set(
      [...sectionList.querySelectorAll('input:checked')].map(cb => cb.dataset.id)
    );
    if (checked.size === 0) return '';
    return loadedContent.sections.filter(s => checked.has(s.id)).map(s => s.text).join(' ');
  }
  return loadedContent?.text || '';
}

function updatePreview(text) {
  preview.textContent = text.slice(0, 8000) + (text.length > 8000 ? '…' : '');
}

function updateTimeEstimate() {
  const w = tokenize(getSelectedText());
  if (w.length === 0) {
    timeEstimate.textContent = '';
    return;
  }
  timeEstimate.textContent = `~${formatTime(estimateReadingSeconds(w, wpm))} at ${wpm} WPM`;
}

function updateShareLinkHint() {
  if (!currentUrl || !loadedContent?.sections?.length) {
    shareLinkBtn.textContent = 'Copy link';
    shareLinkBtn.classList.remove('share-link-highlight');
    return;
  }
  const total = loadedContent.sections.length;
  const checked = sectionList.querySelectorAll('input:checked').length;
  const partial = checked > 0 && checked < total;
  shareLinkBtn.textContent = partial ? 'Copy link to share' : 'Copy link';
  shareLinkBtn.classList.toggle('share-link-highlight', partial);
}

function updateWordCount() {
  const text = getSelectedText();
  const n = countWords(text);
  wordCount.textContent = `${n.toLocaleString()} word${n === 1 ? '' : 's'} selected`;
  startBtn.disabled = n === 0;
  startBtn.textContent = canResumeReading(text) ? 'Continue reading' : 'Start reading';
  updateTimeEstimate();
  updateShareLinkHint();
}

function updateTimeLeft() {
  if (!words.length) {
    timeLeft.textContent = '';
    return;
  }
  const remaining = words.length - currentIndex - 1;
  timeLeft.textContent = remaining > 0
    ? `${formatTime(estimateReadingSeconds(words, wpm, currentIndex + 1))} left`
    : '';
}

preview.addEventListener('mouseup', () => {
  const sel = window.getSelection();
  const text = sel?.toString().trim();
  if (text && text.length > 10) {
    manualSelection = text;
    invalidateSavedProgress();
    sectionList.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
    updateWordCount();
    previewWrap.open = true;
  }
});

function shouldAutoStart(data) {
  if (data.type === 'pdf') return false;
  if (!data.sections?.length) return true;
  return data.sections.length === 1;
}

function showSelectPanel(data) {
  loadedContent = data;
  manualSelection = '';
  invalidateSavedProgress();
  docTitle.textContent = data.title;

  pdfPicker.classList.toggle('hidden', data.type !== 'pdf');
  sectionPicker.classList.toggle('hidden', !data.sections?.length);
  shareLinkBtn.classList.toggle('hidden', !currentUrl);

  if (data.type === 'pdf' && pendingDeepLink?.pages) {
    applyDeepLinkPages(pendingDeepLink.pages);
  }

  if (data.sections?.length) {
    renderSections(data.sections);
    if (pendingDeepLink?.section) applyDeepLinkSections(pendingDeepLink.section);
    updatePreview(data.text);
    sectionPicker.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    quickreadTrack('sections_shown', { count: data.sections.length });
  } else if (data.type !== 'pdf') {
    updatePreview(data.text);
  }

  if (data.type === 'pdf') {
    updatePdfEstimate();
  }

  updateWordCount();
  inputPanel.classList.add('hidden');
  selectPanel.classList.remove('hidden');
  readerPanel.classList.add('hidden');
  syncReaderHeader();

  if (pendingDeepLink) {
    pendingDeepLink = null;
    syncShareUrl();
  }

  if (shouldAutoStart(data) && countWords(getSelectedText()) > 0) {
    startReading();
  }
}

backToInput.addEventListener('click', () => {
  invalidateSavedProgress();
  clearSession();
  selectPanel.classList.add('hidden');
  inputPanel.classList.remove('hidden');
  loadedContent = null;
  currentUrl = '';
  pdfWordsPerPage = null;
  linkInput.focus();
});

textStartBtn.addEventListener('click', () => {
  const text = textInput.value.trim();
  if (!text) return;
  markUsed();
  showSelectPanel({ type: 'text', title: 'Pasted text', text, sections: [] });
});

// Reader
function getFocalIndex(word) {
  const len = word.length;
  if (len <= 1) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  if (len <= 13) return 3;
  return 4;
}

function tokenize(text) {
  return text.trim().split(/\s+/).filter(w => w.length > 0);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fitWordSize(container) {
  const display = container.closest('.reader-display');
  if (!display) return;

  const maxPx = fontSize * 16;
  const minPx = Math.max(12, fontSize * 8);
  const available = display.clientWidth - 32;
  container.style.fontSize = `${maxPx}px`;

  if (available <= 0 || container.scrollWidth <= available) return;

  let lo = minPx;
  let hi = maxPx;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    container.style.fontSize = `${mid}px`;
    if (container.scrollWidth > available) hi = mid - 1;
    else lo = mid;
  }
  container.style.fontSize = `${lo}px`;
}

function renderWordIn(container, word, useFocal) {
  if (!word) {
    container.textContent = '';
    container.style.fontSize = '';
    return;
  }

  container.classList.toggle('no-focal', !useFocal);
  container.classList.remove('word-enter');
  container.style.fontSize = '';
  void container.offsetWidth;
  container.classList.add('word-enter');

  if (!useFocal) {
    container.textContent = word;
    fitWordSize(container);
    return;
  }

  const idx = getFocalIndex(word);
  const before = word.slice(0, idx);
  const focal = word[idx] || '';
  const after = word.slice(idx + 1);

  container.innerHTML =
    `<span class="before">${escapeHtml(before)}</span>` +
    `<span class="focal">${escapeHtml(focal)}</span>` +
    `<span class="after">${escapeHtml(after)}</span>`;
  fitWordSize(container);
}

function renderWord() {
  if (words.length === 0) {
    wordContainer.textContent = '';
    return;
  }
  renderWordIn(wordContainer, words[currentIndex], focalEnabled);
}

function updateProgress() {
  const pct = words.length > 1 ? (currentIndex / (words.length - 1)) * 100 : 0;
  progressFill.style.width = `${Math.min(pct, 100)}%`;
  progressText.textContent = `${currentIndex + 1} / ${words.length}`;
  updateTimeLeft();
  saveSession();
}

function scheduleNext() {
  clearTimeout(timer);
  if (!isPlaying) return;

  if (currentIndex >= words.length - 1) {
    timer = setTimeout(finishWithTransition, wordDelayMs(words[currentIndex], wpm));
    return;
  }

  const delay = wordDelayMs(words[currentIndex], wpm);
  timer = setTimeout(() => {
    currentIndex++;
    renderWord();
    updateProgress();
    scheduleNext();
  }, delay);
}

function restartTimer() {
  if (isPlaying) {
    clearTimeout(timer);
    scheduleNext();
  }
}

function setFocusMode(on) {
  readerPanel.classList.toggle('focus-mode', on);
  appEl.classList.toggle('reading-focus', on);
  readerDisplay.title = on ? 'Tap to pause' : 'Tap to play';

  if (on) {
    readerDisplay.classList.remove('focus-expand');
    void readerDisplay.offsetWidth;
    readerDisplay.classList.add('focus-expand');
  } else {
    readerDisplay.classList.remove('focus-expand');
  }
}

function play() {
  if (words.length === 0) return;
  finishOverlay.classList.add('hidden');
  finishOverlay.classList.remove('finish-in');
  wordContainer.classList.remove('word-exit');
  clearTimeout(finishTimer);
  isPlaying = true;
  playPauseBtn.querySelector('.icon-play').classList.add('hidden');
  playPauseBtn.querySelector('.icon-pause').classList.remove('hidden');
  setFocusMode(true);
  scheduleNext();
}

function pause() {
  isPlaying = false;
  clearTimeout(timer);
  clearTimeout(finishTimer);
  playPauseBtn.querySelector('.icon-play').classList.remove('hidden');
  playPauseBtn.querySelector('.icon-pause').classList.add('hidden');
  setFocusMode(false);
}

function finishWithTransition() {
  if (!isPlaying) return;
  isPlaying = false;
  clearTimeout(timer);
  playPauseBtn.querySelector('.icon-play').classList.remove('hidden');
  playPauseBtn.querySelector('.icon-pause').classList.add('hidden');

  wordContainer.classList.remove('word-exit');
  void wordContainer.offsetWidth;
  wordContainer.classList.add('word-exit');

  finishTimer = setTimeout(finish, 450);
}

function finish() {
  wordContainer.classList.remove('word-exit');
  const elapsed = readingStartTime ? (Date.now() - readingStartTime) / 1000 : 0;
  const mins = Math.floor(elapsed / 60);
  const secs = Math.round(elapsed % 60);
  const timeStr = mins > 0 ? `${mins} min ${secs}s` : `${secs}s`;
  finishStats.textContent = `${words.length.toLocaleString()} words · ${timeStr} · ${wpm} WPM`;

  const pdfEnd = parseInt(pageTo?.value, 10);
  const pdfTotal = loadedContent?.totalPages;
  if (currentUrl && loadedContent?.type === 'pdf' && pdfTotal && pdfEnd < pdfTotal) {
    continuePdfBtn.classList.remove('hidden');
    continuePdfBtn.textContent = `Continue pages ${pdfEnd + 1}–${Math.min(pdfEnd + 10, pdfTotal)}`;
  } else {
    continuePdfBtn.classList.add('hidden');
  }

  finishOverlay.classList.remove('hidden');
  finishOverlay.classList.remove('finish-in');
  void finishOverlay.offsetWidth;
  finishOverlay.classList.add('finish-in');
  setFocusMode(false);
  invalidateSavedProgress();
  clearSession();
  quickreadTrack('read_finish', { words: words.length, wpm, type: loadedContent?.type || 'text' });
  maybeShowInstallNudge();
}

function togglePlayPause() {
  if (!finishOverlay.classList.contains('hidden')) return;
  isPlaying ? pause() : play();
}

function skip(delta) {
  finishOverlay.classList.add('hidden');
  currentIndex = Math.max(0, Math.min(words.length - 1, currentIndex + delta));
  renderWord();
  updateProgress();
  if (isPlaying) restartTimer();
}

function startReading() {
  const text = getSelectedText();
  if (!text) return;

  words = tokenize(text);
  if (words.length === 0) return;

  wpm = parseInt(wpmSlider.value, 10);
  focalEnabled = focalToggle.checked;
  sentencePauseEnabled = sentencePauseToggle.checked;

  const resume = canResumeReading(text);
  currentIndex = resume ? Math.min(savedProgress.index, words.length - 1) : 0;
  isPlaying = false;
  if (!resume) readingStartTime = Date.now();

  selectPanel.classList.add('hidden');
  readerPanel.classList.remove('hidden');
  syncReaderHeader();
  finishOverlay.classList.add('hidden');
  focalGuide.style.display = focalEnabled ? 'block' : 'none';
  readerWpm.textContent = `${wpm} WPM`;
  playPauseBtn.querySelector('.icon-play').classList.remove('hidden');
  playPauseBtn.querySelector('.icon-pause').classList.add('hidden');
  setFocusMode(false);

  renderWord();
  updateProgress();

  quickreadTrack('read_start', { words: words.length, type: loadedContent?.type || 'text' });

  if (resume) {
    saveSession();
  } else {
    play();
  }
}

startBtn.addEventListener('click', startReading);

shareLinkBtn.addEventListener('click', async () => {
  const url = buildShareUrl();
  if (!url) return;
  syncShareUrl();
  try {
    await navigator.clipboard.writeText(url);
    shareLinkBtn.textContent = 'Copied!';
    setTimeout(() => { shareLinkBtn.textContent = 'Copy link'; }, 2000);
  } catch {
    window.prompt('Copy this link:', url);
  }
});

readAgainBtn.addEventListener('click', () => {
  invalidateSavedProgress();
  currentIndex = 0;
  readingStartTime = Date.now();
  finishOverlay.classList.add('hidden');
  renderWord();
  updateProgress();
  play();
});

continuePdfBtn.addEventListener('click', async () => {
  const prevEnd = parseInt(pageTo.value, 10);
  const total = loadedContent.totalPages;
  pageFrom.value = prevEnd + 1;
  pageTo.value = Math.min(prevEnd + 10, total);
  finishOverlay.classList.add('hidden');
  await loadPdfPages();
  startReading();
});

fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    readerPanel.requestFullscreen?.();
  }
});

// File upload
async function handleFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();

  if (name.endsWith('.txt') || file.type === 'text/plain') {
    const text = await file.text();
    if (!text.trim()) {
      setStatus('That file is empty', true);
      return;
    }
    markUsed();
    showSelectPanel({ type: 'text', title: file.name.replace(/\.txt$/i, ''), text, sections: [] });
    return;
  }

  if (name.endsWith('.pdf') || file.type === 'application/pdf') {
    setStatus('Reading PDF…');
    try {
      const res = await apiFetch('/api/parse-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/pdf' },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      loadedContent = {
        type: 'pdf',
        title: file.name.replace(/\.pdf$/i, ''),
        text: data.text,
        totalPages: data.totalPages,
        sections: [],
      };
      currentUrl = '';
      pageFrom.min = 1;
      pageFrom.value = 1;
      pageTo.min = 1;
      pageTo.max = data.totalPages;
      pageTo.value = data.endPage || data.totalPages;
      pageTotal.textContent = `of ${data.totalPages}`;
      markUsed();
      showSelectPanel(loadedContent);
      pdfWordsPerPage = countWords(data.text) / (data.endPage - data.startPage + 1);
      updatePdfEstimate();
      setStatus('');
      quickreadTrack('fetch_success', { type: 'pdf', source: 'upload' });
    } catch (err) {
      quickreadTrack('fetch_error', { reason: err.message });
      setStatus(err.message, true);
    }
    return;
  }

  setStatus('Only .txt and .pdf files work', true);
}

fileBrowseBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  handleFile(fileInput.files[0]);
  fileInput.value = '';
});

fileDrop.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileDrop.classList.add('dragover');
});
fileDrop.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
fileDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('dragover');
  handleFile(e.dataTransfer.files[0]);
});

// Touch gestures
readerDisplay.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
}, { passive: true });

readerDisplay.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  if (Math.abs(dx) < 40) return;
  skip(dx > 0 ? -10 : 10);
}, { passive: true });

backToSelect.addEventListener('click', () => {
  pause();
  if (words.length) {
    savedProgress = { text: getSelectedText(), index: currentIndex };
    saveSession();
  }
  readerPanel.classList.add('hidden');
  selectPanel.classList.remove('hidden');
  syncReaderHeader();
  updateWordCount();
});

readerDisplay.addEventListener('click', (e) => {
  if (e.target.closest('.finish-actions')) return;
  if (!finishOverlay.classList.contains('hidden')) return;
  togglePlayPause();
});

progressBar.addEventListener('click', (e) => {
  const rect = progressBar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  currentIndex = Math.round(pct * (words.length - 1));
  finishOverlay.classList.add('hidden');
  renderWord();
  updateProgress();
  if (isPlaying) restartTimer();
});

playPauseBtn.addEventListener('click', togglePlayPause);
backStartBtn.addEventListener('click', () => skip(-currentIndex));
backBtn.addEventListener('click', () => skip(-10));
forwardBtn.addEventListener('click', () => skip(10));

document.addEventListener('keydown', (e) => {
  if (readerPanel.classList.contains('hidden')) return;
  switch (e.code) {
    case 'Space':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      skip(-1);
      break;
    case 'ArrowRight':
      skip(1);
      break;
    case 'ArrowUp':
      e.preventDefault();
      setWpm(wpm + 25);
      break;
    case 'ArrowDown':
      e.preventDefault();
      setWpm(wpm - 25);
      break;
    case 'Escape':
      if (isPlaying) pause();
      else backToSelect.click();
      break;
  }
});

linkInput.addEventListener('paste', () => {
  setTimeout(() => linkForm.requestSubmit(), 0);
});

// WPM Finder
function hideAllPanels() {
  inputPanel.classList.add('hidden');
  selectPanel.classList.add('hidden');
  readerPanel.classList.add('hidden');
  wpmFinderPanel.classList.add('hidden');
  syncReaderHeader();
}

function showWpmFinder() {
  stopCalTest();
  hideAllPanels();
  wpmFinderPanel.classList.remove('hidden');
  wpmFinderIntro.classList.remove('hidden');
  wpmFinderActive.classList.add('hidden');
  wpmFinderResult.classList.add('hidden');
}

function scheduleCalWord() {
  clearTimeout(calTimer);
  if (!calRunning) return;

  if (calWordQueue.length === 0) refillCalQueue(calWpm);
  const word = calWordQueue.shift();
  renderWordIn(finderWordContainer, word, true);

  const delay = wordDelayMs(word, calWpm);

  calTimer = setTimeout(scheduleCalWord, delay);
}

function bumpCalWpm() {
  if (!calRunning) return;

  if (calWpm >= CAL_WPM_MAX) {
    finishCalTest(CAL_WPM_MAX);
    return;
  }

  clearTimeout(calTimer);
  calWpm += CAL_WPM_STEP;
  finderWpmLabel.textContent = `${calWpm} WPM`;
  injectCalSpeedup();
  scheduleCalWord();
  calLevelTimer = setTimeout(bumpCalWpm, CAL_LEVEL_MS);
}

function startCalTest() {
  stopCalTest();
  calWpm = CAL_WPM_START;
  calRunning = true;
  primeCalQueue(true);

  wpmFinderIntro.classList.add('hidden');
  wpmFinderActive.classList.remove('hidden');
  wpmFinderResult.classList.add('hidden');
  finderWpmLabel.textContent = `${calWpm} WPM`;

  scheduleCalWord();
  calLevelTimer = setTimeout(bumpCalWpm, CAL_LEVEL_MS);
}

function stopCalTest() {
  calRunning = false;
  clearTimeout(calTimer);
  clearTimeout(calLevelTimer);
}

function finishCalTest(finalWpm) {
  stopCalTest();
  finderScore.textContent = finalWpm;
  wpmFinderActive.classList.add('hidden');
  wpmFinderResult.classList.remove('hidden');
}

findWpmBtn.addEventListener('click', showWpmFinder);
wpmNudgeStart?.addEventListener('click', showWpmFinder);
wpmNudgeDismiss?.addEventListener('click', () => {
  localStorage.setItem('quickread-wpm-nudge-dismissed', '1');
  wpmNudge?.classList.add('hidden');
});

wpmFinderBack.addEventListener('click', () => {
  stopCalTest();
  hideAllPanels();
  inputPanel.classList.remove('hidden');
});

wpmFinderStart.addEventListener('click', startCalTest);

wpmFinderStop.addEventListener('click', () => finishCalTest(calWpm));

function applyFinderSpeed() {
  const speed = parseInt(finderScore.textContent, 10);
  setWpm(speed);
  localStorage.setItem('quickread-wpm', String(speed));
  localStorage.setItem('quickread-wpm-calibrated', '1');
  wpmNudge?.classList.add('hidden');
  return speed;
}

function tryDemoArticle() {
  markUsed();
  linkInput.value = WPM_DEMO_URL;
  linkForm.requestSubmit();
}

wpmFinderUse.addEventListener('click', () => {
  applyFinderSpeed();
  stopCalTest();
  hideAllPanels();
  inputPanel.classList.remove('hidden');
});

wpmFinderTry.addEventListener('click', () => {
  applyFinderSpeed();
  stopCalTest();
  hideAllPanels();
  tryDemoArticle();
});

wpmFinderRetry.addEventListener('click', () => {
  wpmFinderResult.classList.add('hidden');
  wpmFinderIntro.classList.remove('hidden');
});

// Init
const savedWpm = localStorage.getItem('quickread-wpm');
if (savedWpm) setWpm(parseInt(savedWpm, 10));

const savedSentencePause = localStorage.getItem('quickread-sentence-pause');
if (savedSentencePause !== null) {
  sentencePauseEnabled = savedSentencePause === '1';
  sentencePauseToggle.checked = sentencePauseEnabled;
}

const savedFontSize = localStorage.getItem('quickread-font-size');
if (savedFontSize) {
  fontSlider.value = savedFontSize;
  setFontSize(parseFloat(savedFontSize));
} else {
  setFontSize(3.5);
}

let resizeFitTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeFitTimer);
  resizeFitTimer = setTimeout(() => {
    if (!readerPanel.classList.contains('hidden') && words.length) renderWord();
  }, 100);
});

document.querySelectorAll('.example-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.example === 'text') {
      textFallback.classList.remove('hidden');
      textToggle.classList.add('hidden');
      textInput.value = SAMPLE_TEXT;
      textInput.focus();
      return;
    }
    linkInput.value = btn.dataset.url;
    linkForm.requestSubmit();
  });
});

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
});

installBtn?.addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installBanner?.classList.add('hidden');
});

installDismiss?.addEventListener('click', () => {
  localStorage.setItem('quickread-install-dismissed', '1');
  installBanner?.classList.add('hidden');
});

if (localStorage.getItem('quickread-used')) {
  examplesEl?.classList.add('hidden');
}

if (
  wpmNudge
  && !localStorage.getItem('quickread-wpm-calibrated')
  && !localStorage.getItem('quickread-wpm-nudge-dismissed')
  && !localStorage.getItem('quickread-wpm')
) {
  wpmNudge.classList.remove('hidden');
}

renderRecents();
checkResume();

pendingDeepLink = parseDeepLink();
if (pendingDeepLink?.wpm) {
  const savedSpeed = parseInt(pendingDeepLink.wpm, 10);
  if (savedSpeed >= 100 && savedSpeed <= 1000) setWpm(savedSpeed);
}
if (pendingDeepLink?.url) {
  linkInput.value = pendingDeepLink.url;
  linkForm.requestSubmit();
}

quickreadTrack('page_view');

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
