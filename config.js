// ⚙️ إعدادات البوت — عدّل ما تحتاجه فقط
export default {
  // رقم الربط (بدون + أو مسافات) — يُستخدم لتوليد كود الربط عند أول تشغيل
  botNumber: process.env.BOT_NUMBER || '212632670721',

  // بادئات الأوامر
  prefixes: ['.', '/', '!'],

  // هل يعمل البوت داخل المجموعات؟
  allowGroups: true,

  // اسم ملف المصدر داخل مجلد sources (بدون .js)
  source: 'mySource',

  // عدد الأشخاص الذين يُخدمون في نفس الوقت (1 = طلب واحد في كل مرة، أخف على الهاتف)
  maxParallelJobs: 1,

  // أقصى عدد فصول في أمر واحد (مثل .فصل 5-8)
  maxRange: 5,

  // عدد النتائج والفصول في كل رسالة
  resultsLimit: 10,
  chaptersPerPage: 30,

  pdf: {
    imageConcurrency: 5,   // عدد الصور المحمّلة معاً
    jpegQuality: 85,       // جودة التحويل عند تحويل webp/gif/avif إلى JPEG
    maxPagesPerPdf: 80,    // إذا زادت صفحات الفصل عن هذا الرقم يُقسَّم إلى عدة ملفات
    maxPageHeight: 14000,  // أقصى ارتفاع لصفحة PDF (للفصول الطويلة بنمط webtoon)
    maxFailedRatio: 0.2,   // إذا فشل تحميل أكثر من 20% من الصفحات يُلغى الفصل
  },

  tempDir: './tmp',
};
