import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PDFDocument } from 'pdf-lib';
import config from '../config.js';
import { getBuffer } from './http.js';

const execFileAsync = promisify(execFile);
const cfg = config.pdf;

// ───────────── أدوات مساعدة ─────────────
function sniff(buf) {
  if (buf.length < 12) return 'unknown';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 3).toString() === 'GIF') return 'gif';
  if (buf.subarray(4, 12).toString().startsWith('ftypavi')) return 'avif';
  return 'unknown';
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const chunk = (arr, size) => {
  if (!size || size >= arr.length) return [arr];
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const safeName = (s) =>
  String(s)
    .replace(/[^\p{L}\p{N} ._()-]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'manga';

// ───────────── تحويل الصيغ غير المدعومة (webp/gif/avif) إلى JPEG ─────────────
async function toJpeg(buf, type) {
  await fs.mkdir(config.tempDir, { recursive: true });

  // 1) sharp إن كانت مثبتة (اختيارية)
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(buf, { pages: 1 })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: cfg.jpegQuality })
      .toBuffer();
  } catch {}

  // 2) ImageMagick (pkg install imagemagick)
  const id = crypto.randomBytes(6).toString('hex');
  const input = path.join(config.tempDir, `${id}.${type === 'unknown' ? 'img' : type}`);
  const output = path.join(config.tempDir, `${id}.jpg`);
  await fs.writeFile(input, buf);
  try {
    let lastErr;
    for (const bin of ['magick', 'convert']) {
      try {
        await execFileAsync(bin, [
          `${input}[0]`,
          '-background', 'white',
          '-alpha', 'remove',
          '-alpha', 'off',
          '-quality', String(cfg.jpegQuality),
          output,
        ]);
        return await fs.readFile(output);
      } catch (e) {
        lastErr = e;
        if (e.code !== 'ENOENT') break; // الأداة موجودة لكن فشل التحويل
      }
    }
    if (lastErr?.code === 'ENOENT') {
      throw new Error('لا يوجد محوّل صور. ثبّت ImageMagick: pkg install imagemagick');
    }
    throw new Error('فشل تحويل الصورة (ملف تالف؟)');
  } finally {
    fs.unlink(input).catch(() => {});
    fs.unlink(output).catch(() => {});
  }
}

async function fetchImage(page, defaultHeaders) {
  const url = typeof page === 'string' ? page : page.url;
  const headers = { ...defaultHeaders, ...(typeof page === 'object' ? page.headers : {}) };
  let buf = await getBuffer(url, { headers });
  let type = sniff(buf);
  if (type !== 'jpg' && type !== 'png') {
    buf = await toJpeg(buf, type);
    type = 'jpg';
  }
  return { buf, type };
}

async function addPage(doc, { buf, type }) {
  const image = type === 'png' ? await doc.embedPng(buf) : await doc.embedJpg(buf);
  const scale = image.height > cfg.maxPageHeight ? cfg.maxPageHeight / image.height : 1;
  const w = image.width * scale;
  const h = image.height * scale;
  const page = doc.addPage([w, h]);
  page.drawImage(image, { x: 0, y: 0, width: w, height: h });
}

// ───────────── الدالة الرئيسية ─────────────
// pages: مصفوفة روابط (أو {url, headers})
// ترجع: { files: [{ path, name }], failed, total }
export async function buildPdfs(pages, { baseName, headers = {} }) {
  await fs.mkdir(config.tempDir, { recursive: true });
  const groups = chunk(pages, cfg.maxPagesPerPdf);
  const files = [];
  let failed = 0;

  for (let g = 0; g < groups.length; g++) {
    const images = await mapLimit(groups[g], cfg.imageConcurrency, async (p) => {
      try {
        return await fetchImage(p, headers);
      } catch (e) {
        console.error('صفحة فشلت:', e.message);
        return null;
      }
    });

    const doc = await PDFDocument.create();
    let added = 0;
    for (const img of images) {
      if (!img) { failed++; continue; }
      try {
        await addPage(doc, img);
        added++;
      } catch (e) {
        console.error('تعذر إدراج صورة:', e.message);
        failed++;
      }
    }
    if (!added) continue;

    const suffix = groups.length > 1 ? ` (${g + 1}-${groups.length})` : '';
    const name = `${safeName(baseName)}${suffix}.pdf`;
    const filePath = path.join(config.tempDir, `${crypto.randomBytes(4).toString('hex')}_${name}`);
    doc.setTitle(baseName);
    await fs.writeFile(filePath, await doc.save());
    files.push({ path: filePath, name });
  }

  if (!files.length || failed > pages.length * cfg.maxFailedRatio) {
    await Promise.all(files.map((f) => fs.unlink(f.path).catch(() => {})));
    throw new Error(`تعذر تحميل الصفحات (${failed}/${pages.length} فشلت)`);
  }
  return { files, failed, total: pages.length };
}
