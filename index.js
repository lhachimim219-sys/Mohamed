import fs from 'fs/promises';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import config from './config.js';
import { handleMessage } from './lib/commands.js';

const logger = pino({ level: 'silent' });
let pairingRequested = false;

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger,
    auth: state,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    // أول تشغيل: نطلب كود الربط بالرقم (بدون QR)
    if (qr && !sock.authState.creds.registered && !pairingRequested) {
      pairingRequested = true;
      try {
        const number = String(config.botNumber).replace(/\D/g, '');
        const code = await sock.requestPairingCode(number);
        console.log(`\n🔑 كود الربط: ${code}`);
        console.log('واتساب ← الأجهزة المرتبطة ← ربط جهاز ← الربط برقم الهاتف بدلاً من ذلك\n');
      } catch (e) {
        pairingRequested = false;
        console.error('فشل طلب كود الربط:', e.message);
      }
    }

    if (connection === 'open') console.log('✅ البوت متصل');

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.log('⛔ تم تسجيل الخروج. احذف مجلد auth ثم شغّل البوت من جديد.');
        process.exit(1);
      }
      pairingRequested = false;
      console.log('🔄 انقطع الاتصال، إعادة المحاولة...');
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      handleMessage(sock, msg).catch((e) => console.error('handler error:', e));
    }
  });
}

// تنظيف الملفات المؤقتة العالقة من تشغيل سابق
await fs.rm(config.tempDir, { recursive: true, force: true }).catch(() => {});
await start();
