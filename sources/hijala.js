// 🔌 مصدر: hijala.com (الحجالة)
// موقع WordPress: المانجا  /<slug>/  والفصول  /<slug>-<رقم>/
import { getText } from '../lib/http.js';
import { decode, stripTags, escapeRe, rank, queryWords } from '../lib/match.js';

const BASE = 'https://hijala.com';
const HEADERS = { Referer: `${BASE}/` };
const RESERVED = new Set([
  'genres', 'page', 'manga', 'bookmark', 'blog', 'call-us', 'terms-of-use-and-copyright',
  'privacy-policy', 'wp-content', 'wp-json', 'feed', 'tag', 'category', 'author', 'comments', 'add',
]);

const enc = encodeURIComponent;

// روابط المانجا: <a href="https://hijala.com/<slug>/" title="اسم المانجا">
function parseSeriesLinks(html) {
  const found = new Map();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const tag = m[0];
    const href = tag.match(/href="([^"]*)"/i)?.[1];
    const title = tag.match(/title="([^"]*)"/i)?.[1];
    if (!href || !title) continue;
    const s = href.match(/^(?:https?:\/\/hijala\.com)?\/([^/?#"]+)\/?$/i);
    if (!s || RESERVED.has(s[1])) continue;
    if (!found.has(s[1])) found.set(s[1], decode(title).trim());
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

export default {
  key: 'hijala',
  aliases: ['hijala', 'حجالة', 'الحجالة', 'hij'],
  name: 'Hijala',
  headers: HEADERS,

  async search(query) {
    const q = query.trim();

    // رابط مباشر للمانجا
    const direct = q.match(/hijala\.com\/([^/?#\s]+)/i);
    if (direct && !RESERVED.has(direct[1])) {
      const id = direct[1];
      const html = await getText(`${BASE}/${id}/`, { headers: HEADERS });
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
      return [{ id, title: (h1 && stripTags(h1)) || id }];
    }

    // البحث في الموقع؛ وإن لم تظهر نتائج نعيد المحاولة بكلمات الاستعلام منفردة (لتغطية الأخطاء الإملائية)
    const words = [...new Set(queryWords(q))].filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
    const tries = [q, ...words.slice(0, 2)];
    let lastErr;
    let anyOk = false;
    for (const t of tries) {
      const cands = new Map();
      for (const url of [`${BASE}/?s=${enc(t)}`, `${BASE}/manga/?title=${enc(t)}`]) {
        try {
          const html = await getText(url, { headers: HEADERS });
          anyOk = true;
          for (const s of parseSeriesLinks(html)) cands.set(s.id, s.title);
        } catch (e) {
          lastErr = e;
        }
      }
      const ranked = rank([...cands].map(([id, title]) => ({ id, title })), q);
      if (ranked.length) return ranked;
    }
    if (!anyOk && lastErr) throw lastErr;
    return [];
  },

  // الفصول من الأقدم إلى الأحدث
  async getChapters(manga) {
    const html = await getText(`${BASE}/${manga.id}/`, { headers: HEADERS });
    const slug = escapeRe(manga.id);
    const re = new RegExp(`<a\\b[^>]*href="(https?:\\/\\/hijala\\.com\\/${slug}-[\\d-]+\\/?)"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
    const byNumber = new Map();
    for (const m of html.matchAll(re)) {
      const text = stripTags(m[2]);
      const num = text.match(/^(?:ال)?فصل\s*(\d+(?:\.\d+)?)/)?.[1];
      if (!num || byNumber.has(num)) continue;
      byNumber.set(num, m[1]);
    }
    return [...byNumber]
      .sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))
      .map(([number, url]) => ({ id: url, number, title: '', url }));
  },

  // روابط الصور بالترتيب
  async getPages(chapter) {
    const html = (await getText(chapter.url, { headers: HEADERS })).replace(/\\\//g, '/');
    const re = /(?:src|data-src|data-lazy-src)\s*=\s*["']([^"']*\/wp-content\/uploads\/manga\/[^"']+?\.(?:webp|jpe?g|png|gif|avif))["']/gi;
    const urls = [];
    for (const m of html.matchAll(re)) {
      let u = m[1].trim();
      if (u.startsWith('/')) u = BASE + u;
      try {
        u = encodeURI(decodeURI(u));
      } catch {
        u = u.replace(/ /g, '%20');
      }
      urls.push(u);
    }
    const unique = [...new Set(urls)];
    if (!unique.length) throw new Error('لا توجد صور لهذا الفصل.');
    return unique;
  },
};
