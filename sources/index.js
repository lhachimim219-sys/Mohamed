import config from '../config.js';

// المصادر المفعّلة (يمكن تخصيصها في config.js بالسطر: sources: ['olympus', 'hijala'])
const DEFAULT = ['olympus', 'hijala', 'starzmanga'];
const keys = config.sources ?? DEFAULT;

export const sources = [];

for (const key of keys) {
  try {
    const mod = (await import(`./${key}.js`)).default;
    for (const fn of ['search', 'getChapters', 'getPages']) {
      if (typeof mod?.[fn] !== 'function') throw new Error(`ينقصه الدالة: ${fn}`);
    }
    sources.push({ aliases: [], name: key, ...mod, key });
  } catch (e) {
    console.error(`⚠️ تعذر تحميل المصدر ${key}: ${e.message}`);
  }
}

if (!sources.length) throw new Error('لا يوجد أي مصدر صالح في مجلد sources.');

export function findSource(x) {
  const k = String(x ?? '').toLowerCase();
  return sources.find((s) => s.key.toLowerCase() === k || s.aliases.some((a) => a.toLowerCase() === k));
}
