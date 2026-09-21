// أدوات مشتركة للبحث: توحيد النص + ترتيب النتائج مع تسامح مع الأخطاء الإملائية
export const decode = (s = '') =>
  s
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');

export const stripTags = (s = '') => decode(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 10,000 = 10.000 = 10000
export const norm = (s) =>
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

// كلمات البحث المهمة (بدون كلمات الوصل)
export function queryWords(query) {
  let words = norm(query).split(' ').filter(Boolean);
  const meaningful = words.filter((w) => !STOP.has(w));
  return meaningful.length ? meaningful : words;
}

// items: [{ id, title }] ← مرتبة حسب قرب العنوان من الاستعلام (ويُستبعد غير المطابق)
export function rank(items, query) {
  const words = queryWords(query);
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
