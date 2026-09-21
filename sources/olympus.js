// 🔌 مصدر: olympustaff.com (Team-X)
// - يعمل مع الفصول المتاحة للجميع فقط. الفصول المدفوعة/المقفلة (رابطها "#" في الموقع) لا تظهر ولا يُتجاوز قفلها.
// - البحث: الموقع لا يوفر بحثاً بالاسم يمكن الاعتماد عليه، لذلك يبني البوت فهرساً محلياً
//   بأسماء المانجا (مرة واحدة، ثم يُحفظ في cache/ لمدة 3 أيام).
//   أو ألصق رابط المانجا مباشرة:  .بحث https://olympustaff.com/series/the-eternal-supreme
import fs from 'fs/promises';
import { getText } from '../lib/http.js';

const BASE = 'https://olympustaff.com';
const HEADERS = { Referer: `${BASE}/` };
const CACHE_DIR = './cache';
const CACHE_FILE = `${CACHE_DIR}/olympus-index.json`;
const CACHE_TTL = 3 * 24 * 3600 * 1000;
const CONCURRENCY = 3;

// ───────────── أدوات ─────────────
const decode = (s = '') =>
  s
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// توحيد النص: أحرف صغيرة، وإزالة الفواصل داخل الأرقام (10,000 = 10.000 = 10000)، وحذف الرموز
const norm = (s) =>
  s
    .toLowerCase()
    .replace(/(\d)[.,](?=\d)/g, '$1')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP = new Set(['the', 'of', 'a', 'an', 'in', 'into', 'to', 'and']);

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// ترتيب النتائج مع تسامح مع الأخطاء الإملائية البسيطة (solo levling ← Solo Leveling)
function rank(items, query) {
  let words = norm(query).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w));
  if (meaningful.length) words = meaningful;
  if (!words.length) return [];

  const scored = [];
  for (const it of items) {
    const tWords = norm(it.title).split(' ').filter(Boolean);
    const compact = tWords.join('');
    let cost = 0;
    let ok = true;
    for (const w of words) {
      if (compact.includes(w)) continue;
      const tol = w.length >= 8 ? 2 : w.length >= 4 ? 1 : 0;
      const best = tol ? Math.min(...tWords.map((t) => lev(w, t))) : Infinity;
      if (best <= tol) cost += best;
      else { ok = false; break; }
    }
    if (ok) scored.push({ it, cost, pos: compact.indexOf(words[0]) === -1 ? 999 : compact.indexOf(words[0]) });
  }
  scored.sort((a, b) => a.cost - b.cost || a.pos - b.pos || a.it.title.length - b.it.title.length);
  return scored.map((s) => s.it);
}
const lastPage = (html) => Math.max(1, ...[...html.matchAll(/[?&]page=(\d+)/g)].map((m) => Number(m[1])));

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

// روابط المانجا في صفحة القائمة: <a href=".../series/<slug>" title="اسم المانجا">
function parseSeriesLinks(html) {
  const found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    const href = tag.match(/href="([^"]*)"/i)?.[1];
    const title = tag.match(/title="([^"]*)"/i)?.[1];
    if (!href || !title) continue;
    const s = href.match(/^(?:https?:\/\/olympustaff\.com)?\/series\/([^/?#"]+)\/?$/i);
    if (!s || s[1] === 'add') continue;
    if (!found.has(s[1])) found.set(s[1], decode(title).trim());
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

// ───────────── فهرس المانجا (للبحث بالاسم) ─────────────
let indexPromise = null;

async function loadIndex() {
  try {
    const c = JSON.parse(await fs.readFile(CACHE_FILE, 'utf8'));
    if (c.items?.length && Date.now() - c.time < CACHE_TTL) return c.items;
  } catch {}
  if (!indexPromise) indexPromise = buildIndex().finally(() => (indexPromise = null));
  return indexPromise;
}

async function buildIndex() {
  const first = await getText(`${BASE}/series`, { headers: HEADERS });
  const total = lastPage(first);
  const map = new Map();
  for (const s of parseSeriesLinks(first)) map.set(s.id, s.title);
  if (!map.size) {
    throw new Error('تعذر قراءة قائمة المانجا من الموقع (ربما حجب الطلبات أو تغيّرت بنيته). جرّب البحث برابط المانجا مباشرة.');
  }
  console.log(`📥 بناء فهرس olympus: ${total} صفحة ...`);

  let failed = 0;
  const pages = Array.from({ length: total - 1 }, (_, i) => i + 2);
  await mapLimit(pages, CONCURRENCY + 1, async (p) => {
    try {
      const html = await getText(`${BASE}/series?page=${p}`, { headers: HEADERS });
      for (const s of parseSeriesLinks(html)) map.set(s.id, s.title);
    } catch (e) {
      failed++;
      console.error(`صفحة الفهرس ${p} فشلت:`, e.message);
    }
  });

  const items = [...map].map(([id, title]) => ({ id, title }));
  if (items.length) {
    await fs.mkdir(CACHE_DIR, { recursive: true });
    // إن فشلت بعض الصفحات نُبقي الفهرس 6 ساعات فقط ثم يُعاد بناؤه
    const time = failed ? Date.now() - CACHE_TTL + 6 * 3600 * 1000 : Date.now();
    await fs.writeFile(CACHE_FILE, JSON.stringify({ time, items }));
  }
  return items;
}

// ───────────── المصدر ─────────────
export default {
  key: 'olympus',
  aliases: ['olympus', 'اولمبوس', 'oly', 'teamx'],
  name: 'Olympus Staff',
  headers: HEADERS,

  async search(query) {
    const q = query.trim();

    // رابط مباشر للمانجا
    const direct = q.match(/olympustaff\.com\/series\/([^/?#\s]+)/i);
    if (direct) {
      const id = direct[1];
      const html = await getText(`${BASE}/series/${id}`, { headers: HEADERS });
      const raw =
        html.match(/og:title["'][^>]*content="([^"]*)"/i)?.[1] ||
        html.match(/<title>([^<]*)<\/title>/i)?.[1] ||
        id;
      const title = decode(raw).replace(/\s*-\s*(مانجا مترجمة|Team-X).*$/s, '').replace(/\s+/g, ' ').trim() || id;
      return [{ id, title }];
    }

    if (!norm(q)) return [];
    const items = await loadIndex();
    console.log(`🔎 فهرس olympus: ${items.length} مانجا`);
    return rank(items, q);
  },

  // الفصول المتاحة فقط، من الأقدم إلى الأحدث
  async getChapters(manga) {
    const url = `${BASE}/series/${manga.id}`;
    const first = await getText(url, { headers: HEADERS });
    const total = lastPage(first);
    const rest = await mapLimit(
      Array.from({ length: total - 1 }, (_, i) => i + 2),
      CONCURRENCY,
      (p) => getText(`${url}?page=${p}`, { headers: HEADERS })
    );

    const re = new RegExp(
      `href="(?:https?:\\/\\/olympustaff\\.com)?\\/series\\/${escapeRe(manga.id)}\\/(\\d+(?:\\.\\d+)?)"`,
      'gi'
    );
    const numbers = new Set();
    for (const html of [first, ...rest]) for (const m of html.matchAll(re)) numbers.add(m[1]);

    return [...numbers]
      .sort((a, b) => parseFloat(a) - parseFloat(b))
      .map((n) => ({ id: n, number: n, title: '' }));
  },

  // روابط صور الفصل بالترتيب
  async getPages(chapter, manga) {
    const html = await getText(`${BASE}/series/${manga.id}/${chapter.number}`, { headers: HEADERS });
    const re = /(?:https?:\/\/olympustaff\.com)?\/uploads\/manga_[^"'\s)<>\\]+?\.(?:jpe?g|png|webp|gif|avif)/gi;
    const urls = [...html.matchAll(re)].map((m) => (m[0].startsWith('/') ? BASE + m[0] : m[0]));
    const unique = [...new Set(urls)];
    if (!unique.length) throw new Error('لا توجد صور لهذا الفصل (قد يكون مدفوعاً أو مقفلاً في الموقع).');
    return unique;
  },
};
