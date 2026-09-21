import fs from 'fs/promises';
import config from '../config.js';
import { sources, findSource } from '../sources/index.js';
import { buildPdfs } from './pdf.js';
import { createQueue } from './queue.js';

const queue = createQueue(config.maxParallelJobs);
const sessions = new Map(); // key -> { results, manga, source, chapters }
const busy = new Set();     // مستخدمون لديهم طلب قيد التنفيذ

const SEARCH_TIMEOUT_MULTI = 45_000;   // بحث في كل المصادر
const SEARCH_TIMEOUT_SINGLE = 300_000; // بحث في مصدر واحد (الفهرس الأول قد يستغرق دقائق)

// ───────────── الأوامر وأسماؤها البديلة ─────────────
const ALIASES = {
  help: ['مساعدة', 'اوامر', 'الأوامر', 'help', 'menu', 'start'],
  search: ['بحث', 'ابحث', 'search', 's'],
  manga: ['مانجا', 'manga', 'm'],
  chapters: ['فصول', 'chapters', 'ch'],
  chapter: ['فصل', 'chapter', 'c', 'dl', 'تحميل'],
  ping: ['ping', 'بنج'],
};
const COMMANDS = {};
for (const [name, list] of Object.entries(ALIASES)) for (const a of list) COMMANDS[a] = name;

// ───────────── أدوات الرسائل ─────────────
function unwrap(m) {
  while (m) {
    if (m.ephemeralMessage) m = m.ephemeralMessage.message;
    else if (m.viewOnceMessage) m = m.viewOnceMessage.message;
    else if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
    else break;
  }
  return m;
}

function extractText(m) {
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || '';
}

const helpText = () => `📖 *بوت المانجا PDF*

1️⃣ *.بحث* <اسم المانجا>
    أو في مصدر واحد: *.بحث* <المصدر> <الاسم>
    المصادر: ${sources.map((s) => s.key).join(' / ')}
2️⃣ *.مانجا* <رقم النتيجة>
3️⃣ *.فصول* [رقم الصفحة]
4️⃣ *.فصل* <رقم الفصل>  → يصلك PDF

أمثلة:
• .بحث solo leveling
• .بحث hijala solo
• .فصل 12
• .فصل 5-8  (حتى ${config.maxRange} فصول)
• .فصل اخر  (آخر فصل)
• .فصل #3  (الفصل رقم 3 في القائمة)`;

// ───────────── البحث في عدة مصادر ─────────────
function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      t = setTimeout(() => reject(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

async function searchOne(src, q, ms) {
  const p = Promise.resolve().then(() => src.search(q));
  p.catch(() => {}); // حتى لا يظهر خطأ غير معالج إن انتهت المهلة أولاً
  try {
    const res = await withTimeout(p, ms);
    return { src, results: (res || []).map((r) => ({ ...r, src: src.key })) };
  } catch (e) {
    return { src, results: [], error: e };
  }
}

// ───────────── المعالج الرئيسي ─────────────
export async function handleMessage(sock, msg) {
  if (!msg.message || msg.key.fromMe) return;
  const chat = msg.key.remoteJid;
  if (!chat || chat === 'status@broadcast' || chat.endsWith('@newsletter')) return;
  if (chat.endsWith('@g.us') && !config.allowGroups) return;

  const text = extractText(unwrap(msg.message)).trim();
  const prefix = config.prefixes.find((p) => text.startsWith(p));
  if (!prefix) return;

  const [rawCmd, ...args] = text.slice(prefix.length).trim().split(/\s+/);
  const cmd = COMMANDS[(rawCmd || '').toLowerCase()];
  if (!cmd) return;

  const key = msg.key.participant || chat;
  const reply = (t) => sock.sendMessage(chat, { text: t }, { quoted: msg });

  try {
    switch (cmd) {
      case 'help':
        return await reply(helpText());

      case 'ping':
        return await reply('🏓 pong');

      case 'search': {
        let list = sources;
        let words = args;
        const only = args.length > 1 ? findSource(args[0]) : null;
        if (only) {
          list = [only];
          words = args.slice(1);
        }
        const q = words.join(' ').trim();
        if (!q) return await reply('اكتب اسم المانجا. مثال: .بحث solo leveling');

        if (list.length > 1) await reply(`🔎 جارٍ البحث في ${list.length} مصادر ...`);
        const ms = list.length > 1 ? SEARCH_TIMEOUT_MULTI : SEARCH_TIMEOUT_SINGLE;
        const outcomes = await Promise.all(list.map((src) => searchOne(src, q, ms)));

        const perSource = list.length > 1 ? 5 : config.resultsLimit;
        const results = [];
        const blocks = [];
        const notes = [];
        for (const o of outcomes) {
          const part = o.results.slice(0, perSource);
          if (part.length) {
            blocks.push(`▫️ *${o.src.name}*\n` + part.map((r) => `${results.push(r)}. ${r.title}`).join('\n'));
          } else if (o.error) {
            notes.push(
              o.error.code === 'TIMEOUT'
                ? `⏱️ ${o.src.name}: البحث يستغرق وقتاً، جرّب: .بحث ${o.src.key} ${q}`
                : `⚠️ ${o.src.name}: ${o.error.message}`
            );
          }
        }

        if (!results.length) return await reply(['❌ لا توجد نتائج.', ...notes].join('\n'));
        sessions.set(key, { results, manga: null, source: null, chapters: [] });
        const tail = notes.length ? `\n\n${notes.join('\n')}` : '';
        return await reply(`🔎 *النتائج:*\n\n${blocks.join('\n\n')}${tail}\n\nاختر: *.مانجا* <الرقم>`);
      }

      case 'manga': {
        const s = sessions.get(key);
        if (!s?.results?.length) return await reply('ابحث أولاً: .بحث <اسم>');
        const n = parseInt(args[0], 10);
        const manga = s.results[n - 1];
        if (!manga) return await reply(`اختر رقماً بين 1 و ${s.results.length}`);
        const src = findSource(manga.src);
        const chapters = (await src.getChapters(manga)) || [];
        if (!chapters.length) return await reply('❌ لا توجد فصول متاحة لهذه المانجا.');
        s.manga = manga;
        s.source = src;
        s.chapters = chapters;
        return await reply(chaptersPage(s));
      }

      case 'chapters': {
        const s = sessions.get(key);
        if (!s?.manga) return await reply('اختر مانجا أولاً: .بحث ثم .مانجا <رقم>');
        const p = args[0] ? parseInt(args[0], 10) : undefined;
        return await reply(chaptersPage(s, p));
      }

      case 'chapter': {
        const s = sessions.get(key);
        if (!s?.manga) return await reply('اختر مانجا أولاً: .بحث ثم .مانجا <رقم>');
        const arg = args.join('').trim();
        if (!arg) return await reply('اكتب رقم الفصل. مثال: .فصل 12');
        const list = pickChapters(s, arg);
        if (!list.length) return await reply('❌ لم أجد هذا الفصل. راجع القائمة بـ .فصول');
        return await downloadChapters(sock, msg, chat, key, s, list, reply);
      }
    }
  } catch (e) {
    console.error(e);
    await reply(errorText(e)).catch(() => {});
  }
}

const errorText = (e) => (e.code === 'NOT_CONFIGURED' ? `⚙️ ${e.message}` : `❌ ${e.message || 'حدث خطأ'}`);

// ───────────── عرض الفصول ─────────────
function chaptersPage(s, page) {
  const per = config.chaptersPerPage;
  const total = Math.ceil(s.chapters.length / per);
  const p = Math.min(Math.max(page || total, 1), total); // الافتراضي: آخر صفحة (الأحدث)
  const slice = s.chapters.slice((p - 1) * per, p * per);
  const lines = slice.map((c) => `• ${c.number}${c.title ? ` — ${c.title}` : ''}`).join('\n');
  return (
    `📚 *${s.manga.title}*  (${s.source.name})\nعدد الفصول: ${s.chapters.length} | الصفحة ${p}/${total}\n\n${lines}\n\n` +
    `للتحميل: *.فصل* <الرقم>\nصفحة أخرى: *.فصول* <رقم الصفحة>`
  );
}

// ───────────── اختيار الفصول (رقم / مدى / اخر / #فهرس) ─────────────
function pickChapters(s, arg) {
  const a = arg.toLowerCase();
  if (['اخر', 'آخر', 'last', 'latest'].includes(a)) return [s.chapters[s.chapters.length - 1]];
  if (a.startsWith('#')) {
    const c = s.chapters[parseInt(a.slice(1), 10) - 1];
    return c ? [c] : [];
  }
  const range = a.match(/^(\d+(?:\.\d+)?)[-–](\d+(?:\.\d+)?)$/);
  if (range) {
    const x = parseFloat(range[1]);
    const y = parseFloat(range[2]);
    const [lo, hi] = [Math.min(x, y), Math.max(x, y)];
    return s.chapters.filter((c) => {
      const n = parseFloat(c.number);
      return !Number.isNaN(n) && n >= lo && n <= hi;
    });
  }
  return s.chapters.filter((c) => String(c.number).toLowerCase() === a);
}

// ───────────── تحميل وإرسال ─────────────
async function downloadChapters(sock, msg, chat, key, s, list, reply) {
  if (list.length > config.maxRange) {
    return reply(`⚠️ الحد الأقصى ${config.maxRange} فصول في المرة الواحدة.`);
  }
  if (busy.has(key)) return reply('⏳ لديك طلب قيد التنفيذ، انتظر حتى ينتهي.');

  const { source, manga } = s; // نثبّتها الآن حتى لا تتغير إن بحث المستخدم مجدداً أثناء التحميل
  busy.add(key);
  try {
    if (queue.size > 0) await reply(`🕐 طلبك في الانتظار (${queue.size} قبلك).`);

    await queue.add(async () => {
      for (const ch of list) {
        await reply(`⏳ جارٍ تجهيز الفصل ${ch.number} ...`);
        let files = [];
        try {
          const pages = await source.getPages(ch, manga);
          if (!pages?.length) {
            await reply(`❌ الفصل ${ch.number}: لا توجد صفحات.`);
            continue;
          }
          const res = await buildPdfs(pages, {
            baseName: `${manga.title} - ${ch.number}`,
            headers: source.headers || {},
          });
          files = res.files;

          for (const f of files) {
            await sock.sendMessage(
              chat,
              {
                document: { url: f.path },
                mimetype: 'application/pdf',
                fileName: f.name,
                caption: `📖 ${manga.title}\nالفصل ${ch.number}`,
              },
              { quoted: msg }
            );
          }
          if (res.failed) await reply(`⚠️ الفصل ${ch.number}: تعذر تحميل ${res.failed} صفحة.`);
        } catch (e) {
          console.error(e);
          await reply(`${errorText(e)} (الفصل ${ch.number})`).catch(() => {});
        } finally {
          await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
        }
      }
    });
  } finally {
    busy.delete(key);
  }
}
