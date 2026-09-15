import express from 'express';
import { JSDOM } from 'jsdom';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const MAX_BYTES = 25 * 1024 * 1024;
const SITE_URL = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const ALLOWED_EVENTS = new Set(['page_view', 'fetch_success', 'fetch_error', 'read_start', 'read_finish']);
const metrics = {};

const rateBuckets = new Map();
function rateLimit(req, res, next) {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart > 60000) {
    bucket = { windowStart: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > 30) {
    return res.status(429).json({ error: 'Too many requests — wait a minute and try again' });
  }
  next();
}

function cleanText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

const JUNK_SELECTORS = [
  '.hatnote', '.dablink', '.rellink', '.seealso',
  '.ambox', '.tmbox', '.ombox', '.imbox', '.fmbox', '.usermbox',
  '[class*="ambox-"]', '[class*="mbox-"]',
  '.shortdescription', '.sistersitebox', '.portalbox',
  '.navbox', '.vertical-navbox', '.sidebar',
  '.reference', '.reflist', '.mw-references-wrap',
  '.mw-editsection', '.toc', '#toc',
  '.metadata', '.noprint', '.printfooter',
  '.mw-empty-elt', '#coordinates',
  'sup.reference',
].join(', ');

function isWikiJunk(el) {
  if (!el.classList) return false;
  for (const cls of el.classList) {
    if (cls === 'hatnote' || cls === 'dablink' || cls === 'rellink') return true;
    if (cls.startsWith('ambox') || cls.startsWith('mbox-') || cls.startsWith('tmbox-')) return true;
  }
  if (el.tagName === 'TABLE' && el.classList.contains('ambox')) return true;
  return false;
}

function stripJunk(doc) {
  for (const el of doc.querySelectorAll(JUNK_SELECTORS)) el.remove();
  for (const el of doc.querySelectorAll('table')) {
    if (isWikiJunk(el)) el.remove();
  }
}

function extractSections(doc) {
  const root = doc.querySelector('#mw-content-text') ||
    doc.querySelector('article') ||
    doc.querySelector('[role="main"]') ||
    doc.querySelector('main') ||
    doc.body;

  if (!root) return [];

  const sections = [];
  let current = { id: 's0', title: 'Full article', level: 0, text: '' };
  let counter = 1;

  const walk = (node) => {
    if (node.nodeType !== 1) return;
    if (isWikiJunk(node)) return;

    const tag = node.tagName;
    if (/^H[1-4]$/.test(tag)) {
      const title = cleanText(node.textContent);
      if (!title || title === 'Contents') return;

      if (current.text.trim()) {
        sections.push({ ...current, text: cleanText(current.text) });
      }
      current = { id: `s${counter++}`, title, level: parseInt(tag[1], 10), text: '' };
      return;
    }

    if (['SCRIPT', 'STYLE', 'NAV', 'FOOTER', 'HEADER', 'ASIDE', 'NOSCRIPT', 'IFRAME', 'FIGURE', 'IMG'].includes(tag)) {
      return;
    }

    if (['P', 'LI', 'TD', 'BLOCKQUOTE', 'DD'].includes(tag)) {
      current.text += node.textContent + ' ';
      return;
    }

    for (const child of node.children) walk(child);
  };

  walk(root);

  if (current.text.trim()) {
    sections.push({ ...current, text: cleanText(current.text) });
  }

  return sections.filter(s => s.text.length > 30);
}

function extractHtmlContent(html) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  for (const el of doc.querySelectorAll('script, style, nav, footer, header, aside, noscript, iframe')) {
    el.remove();
  }
  stripJunk(doc);

  const title = cleanText(
    doc.querySelector('h1')?.textContent ||
    doc.querySelector('title')?.textContent ||
    'Untitled'
  );

  const sections = extractSections(doc);
  const text = sections.length
    ? sections.map(s => s.text).join(' ')
    : cleanText((doc.querySelector('article') || doc.querySelector('main') || doc.body)?.textContent || '');

  return { title, text, sections };
}

async function extractPdfPages(buffer, startPage, endPage) {
  const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;
  const totalPages = doc.numPages;
  const start = Math.max(1, startPage || 1);
  const end = Math.min(totalPages, endPage || totalPages);

  let text = '';
  for (let i = start; i <= end; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(' ') + ' ';
  }

  return { text: cleanText(text), totalPages, startPage: start, endPage: end };
}

function fetchErrorMessage(err) {
  const code = err.cause?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return "Couldn't find that site — check the URL";
  }
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return "Couldn't reach that site — it may be down or blocking requests";
  }
  if (err.name === 'TimeoutError' || code === 'ABORT_ERR') {
    return 'That site took too long to respond — try again or paste the text directly';
  }
  if (err.message === 'fetch failed') {
    return "Couldn't reach that site — check your connection";
  }
  return err.message || 'Failed to fetch link';
}

function httpStatusMessage(status) {
  if (status === 401 || status === 403) {
    return 'That page is behind a login or paywall — paste the text or upload a PDF instead';
  }
  if (status === 404) return "That page doesn't exist — check the URL";
  if (status === 429) return 'That site is rate-limiting us — wait a minute and try again';
  if (status >= 500) return 'That site had a server error — try again later';
  return `Could not fetch that page (${status})`;
}

function htmlExtractError(html, text) {
  const lower = html.toLowerCase();
  const scriptCount = (html.match(/<script/gi) || []).length;

  if (/subscribe|sign in to read|members only|paywall|premium content|registration required/.test(lower) && text.length < 800) {
    return 'That article is behind a paywall — paste the text or upload a PDF instead';
  }
  if (text.length < 100 && scriptCount > 8) {
    return 'That site loads its content with JavaScript — paste the text or upload a file instead';
  }
  return 'Could not extract readable text — try pasting the article or uploading a file';
}

function pdfExtractError() {
  return 'No readable text found — this PDF may be scanned images. Try a text-based PDF or paste the content';
}

function assertSize(bytes) {
  if (bytes > MAX_BYTES) {
    throw new Error('That file is too large (max 25 MB) — try a smaller PDF or paste the text');
  }
}

async function fetchUrl(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        'User-Agent': `Mozilla/5.0 (compatible; Flashread/1.0; +${SITE_URL})`,
        Accept: 'text/html,application/xhtml+xml,application/pdf,*/*;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    console.error('fetch failed:', url, err.cause || err.message);
    throw new Error(fetchErrorMessage(err));
  }

  if (!response.ok) {
    throw new Error(httpStatusMessage(response.status));
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_BYTES) assertSize(contentLength);

  return response;
}

app.post('/api/fetch', rateLimit, async (req, res) => {
  const { url, startPage, endPage } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return res.status(400).json({ error: 'Only http and https links work' });
    }

    const response = await fetchUrl(url);
    const contentType = response.headers.get('content-type') || '';
    const isPdf = contentType.includes('pdf') || parsed.pathname.toLowerCase().endsWith('.pdf');

    if (isPdf) {
      const buffer = Buffer.from(await response.arrayBuffer());
      assertSize(buffer.length);
      const pdf = await extractPdfPages(buffer, startPage, endPage);

      if (!pdf.text || pdf.text.length < 10) {
        return res.status(422).json({ error: pdfExtractError() });
      }

      return res.json({
        type: 'pdf',
        title: parsed.pathname.split('/').pop()?.replace('.pdf', '') || 'PDF',
        text: pdf.text,
        totalPages: pdf.totalPages,
        startPage: pdf.startPage,
        endPage: pdf.endPage,
        sections: [],
      });
    }

    const html = await response.text();
    const { title, text, sections } = extractHtmlContent(html);

    if (!text || text.length < 20) {
      return res.status(422).json({ error: htmlExtractError(html, text) });
    }

    res.json({ type: 'html', title, text, sections });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to fetch link' });
  }
});

app.post('/api/fetch-pdf-info', rateLimit, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const parsed = new URL(url);
    const response = await fetchUrl(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    assertSize(buffer.length);
    const doc = await getDocument({ data: new Uint8Array(buffer), useSystemFonts: true }).promise;

    res.json({
      type: 'pdf',
      title: parsed.pathname.split('/').pop()?.replace('.pdf', '') || 'PDF',
      totalPages: doc.numPages,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read PDF' });
  }
});

app.post('/api/parse-pdf', rateLimit, express.raw({ type: 'application/pdf', limit: '25mb' }), async (req, res) => {
  if (!req.body?.length) {
    return res.status(400).json({ error: 'PDF file required' });
  }

  try {
    const buffer = Buffer.from(req.body);
    const pdf = await extractPdfPages(buffer, 1, undefined);

    if (!pdf.text || pdf.text.length < 10) {
      return res.status(422).json({ error: pdfExtractError() });
    }

    res.json({
      text: pdf.text,
      totalPages: pdf.totalPages,
      startPage: pdf.startPage,
      endPage: pdf.endPage,
    });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Failed to read PDF' });
  }
});

app.post('/api/event', rateLimit, (req, res) => {
  const { event, detail } = req.body || {};
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error: 'Unknown event' });
  }
  metrics[event] = (metrics[event] || 0) + 1;
  if (detail?.type) {
    const key = `${event}:${detail.type}`;
    metrics[key] = (metrics[key] || 0) + 1;
  }
  res.status(204).end();
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'File is too large (max 25 MB) — try a smaller PDF or paste the text' });
  }
  next(err);
});

setInterval(() => {
  if (Object.keys(metrics).length) console.log('[metrics]', JSON.stringify(metrics));
}, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`Flashread running on port ${PORT}`);
});
