// 🔌 مصدر: starzmanga.com (مانجا ستارز)
// قالب Madara: المانجا  /manga/<slug>/  والفصول  /manga/<slug>/<رقم>/
import { getText, postText } from '../lib/http.js';
import { decode, stripTags, escapeRe, rank, queryWords } from '../lib/match.js';

const BASE = 'https://starzmanga.com';
const HEADERS = { Referer: `${BASE}/` };
const enc = encodeURIComponent;

function parseSeries(html) {
  const found = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = m[1];
    const href = attrs.match(/href="([^"]*)"/i)?.[1];
    const s = href?.match(/^(?:https?:\/\/starzmanga\.com)?\/manga\/([^/?#"]+)\/?$/i);
    if (!s) continue;
    const title = decode(attrs.match(/title="([^"]*)"/i)?.[1] || stripTags(m[2])).trim();
    if (title && !found.has(s[1])) found.set(s[1], title);
  }
  return [...found].map(([id, title]) => ({ id, title }));
}

// "284-5" ← "284.5"
const toNumber = (path) => path.replace('-', '.');

export default {
  key: 'starzmanga',
  aliases: ['starz', 'starzmanga', 'ستارز', 'سوات', 'st'],
  name: 'Starz Manga',
  headers: HEADERS,

  async search(query) {
    const q = query.trim();

    // رابط مباشر للمانجا
    const direct = q.match(/starzmanga\.com\/manga\/([^/?#\s]+)/i);
    if (direct) {
      const id = direct[1];
      const html = await getText(`${BASE}/manga/${id}/`, { headers: HEADERS });
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
      return [{ id, title: (h1 && stripTags(h1)) || id }];
    }

    // صفحة نتائج البحث فيها قوائم جانبية (شائع...) لذلك نُبقي فقط ما يطابق الاستعلام
    const words = [...new Set(queryWords(q))].filter((w) => w.length >= 3).sort((a, b) => b.length - a.length);
    const tries = [q, ...words.slice(0, 2)];
    let lastErr;
    let anyOk = false;
    for (const t of tries) {
      try {
        const html = await getText(`${BASE}/?s=${enc(t)}&post_type=wp-manga`, { headers: HEADERS });
        anyOk = true;
        const ranked = rank(parseSeries(html), q);
        if (ranked.length) return ranked;
      } catch (e) {
        lastErr = e;
      }
    }
    if (!anyOk && lastErr) throw lastErr;
    return [];
  },

  // الفصول من الأقدم إلى الأحدث
  async getChapters(manga) {
    const url = `${BASE}/manga/${manga.id}/`;
    const re = new RegExp(`href="(?:https?:\\/\\/starzmanga\\.com)?\\/manga\\/${escapeRe(manga.id)}\\/(\\d+(?:-\\d+)?)\\/?"`, 'gi');
    const paths = new Set();
    const collect = (html) => {
      for (const m of html.matchAll(re)) paths.add(m[1]);
    };

    collect(await getText(url, { headers: HEADERS }));

    // القائمة الكاملة تُجلب عبر AJAX في قالب Madara
    let ajaxOk = false;
    try {
      const html = await postText(`${url}ajax/chapters/`, '', {
        headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: url },
      });
      const before = paths.size;
      collect(html);
      ajaxOk = paths.size > before;
    } catch {}

    // احتياطاً: إن تعذّر AJAX نفترض أن الفصول أرقام متتالية حتى آخر فصل ظاهر
    if (!ajaxOk) {
      const max = Math.max(0, ...[...paths].map((p) => parseInt(p, 10)));
      for (let i = 1; i <= max; i++) paths.add(String(i));
    }

    return [...paths]
      .sort((a, b) => parseFloat(toNumber(a)) - parseFloat(toNumber(b)))
      .map((p) => ({ id: p, number: toNumber(p), title: '', path: p }));
  },

  // روابط الصور بالترتيب
  async getPages(chapter, manga) {
    const html = (await getText(`${BASE}/manga/${manga.id}/${chapter.path}/`, { headers: HEADERS })).replace(/\\\//g, '/');
    const re = /https?:\/\/[^"'\s<>]+\/data\/manga_[^"'\s<>]+?\.(?:jpe?g|png|webp|gif|avif)/gi;
    const unique = [...new Set([...html.matchAll(re)].map((m) => m[0]))];
    if (!unique.length) throw new Error('لا توجد صور لهذا الفصل (قد لا يكون موجوداً، أو يحتاج الموقع تحققاً).');
    return unique;
  },
};
