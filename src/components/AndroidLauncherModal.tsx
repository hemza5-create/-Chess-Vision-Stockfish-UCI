import React, { useState } from 'react';
import { ArrowLeft, Check, Copy, Download, ExternalLink, Smartphone, X } from 'lucide-react';
import chessboard3dImg from '../assets/images/chessboard_3d_hero_1795336755860.jpg';

const TARGET_APP_URL =
  'https://ais-dev-p4xrlompq6d6vhvb2xmxjf-699178223939.europe-west2.run.app';

interface AndroidLauncherModalProps {
  onClose: () => void;
}

export const AndroidLauncherModal: React.FC<AndroidLauncherModalProps> = ({ onClose }) => {
  const [imageFailed, setImageFailed] = useState(false);
  const [isDownloadingAndroidZip, setIsDownloadingAndroidZip] = useState(false);
  const [isDownloadingHtml, setIsDownloadingHtml] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [downloadNote, setDownloadNote] = useState<string | null>(null);

  const triggerBlobDownload = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const handleDownloadAndroidZip = async () => {
    setIsDownloadingAndroidZip(true);
    setDownloadNote(null);
    try {
      const res = await fetch('/api/download/android-app.zip');
      if (!res.ok) throw new Error('تعذر تجهيز حزمة مشروع أندرويد.');
      const blob = await res.blob();
      triggerBlobDownload(blob, 'chess-vision-android-app.zip');
      setDownloadNote('تم تنزيل مشروع Android Studio الكامل (.zip) بنجاح.');
    } catch (err) {
      setDownloadNote(err instanceof Error ? err.message : 'تعذر تنزيل الحزمة.');
    } finally {
      setIsDownloadingAndroidZip(false);
    }
  };

  const handleDownloadSelfContainedLauncherHtml = async () => {
    setIsDownloadingHtml(true);
    setDownloadNote(null);
    try {
      let embeddedImgSrc = '/chessboard-3d.jpg';
      try {
        const imgRes = await fetch(chessboard3dImg);
        if (imgRes.ok) {
          const imgBlob = await imgRes.blob();
          embeddedImgSrc = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve(typeof reader.result === 'string' ? reader.result : '/chessboard-3d.jpg');
            reader.onerror = () => reject(new Error('read failed'));
            reader.readAsDataURL(imgBlob);
          });
        }
      } catch {
        // Keep relative path fallback if inline conversion fails
      }

      const standaloneHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <meta name="theme-color" content="#0B0E14" />
  <title>رَصْد الشطرنج — افتح</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      min-height: 100%;
      background: radial-gradient(circle at 50% 0%, #151E2E 0%, #0B0E14 68%);
      color: #F8FAFC;
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Arabic", Arial, sans-serif;
    }
    body {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
    }
    .shell { width: 100%; max-width: 440px; display: flex; flex-direction: column; gap: 14px; }
    .open-card {
      display: flex;
      flex-direction: column;
      text-decoration: none;
      background: #121722;
      border: 1.5px solid #243045;
      border-radius: 24px;
      overflow: hidden;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
      transition: transform 0.16s ease, border-color 0.2s ease;
    }
    .open-card:active { transform: scale(0.985); }
    .open-btn {
      min-height: 74px;
      padding: 18px 24px;
      background: linear-gradient(135deg, #10B981 0%, #059669 100%);
      color: #031B13;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      font-size: 28px;
      font-weight: 800;
    }
    .board-wrap { width: 100%; aspect-ratio: 1 / 1; background: #0B0E14; overflow: hidden; }
    .board-wrap img { width: 100%; height: 100%; object-fit: cover; display: block; }
  </style>
</head>
<body>
  <main class="shell">
    <a class="open-card" href="${TARGET_APP_URL}">
      <div class="open-btn">
        <span>افتح</span>
      </div>
      <div class="board-wrap">
        <img src="${embeddedImgSrc}" alt="رقعة شطرنج ثلاثية الأبعاد" />
      </div>
    </a>
  </main>
</body>
</html>`;

      const blob = new Blob([standaloneHtml], { type: 'text/html;charset=utf-8' });
      triggerBlobDownload(blob, 'chess-vision-open-launcher.html');
      setDownloadNote('تم تنزيل صفحة المشغل المتكاملة بالصورة ثلاثية الأبعاد (.html).');
    } finally {
      setIsDownloadingHtml(false);
    }
  };

  const handleCopyUrl = () => {
    navigator.clipboard?.writeText(TARGET_APP_URL);
    setCopiedUrl(true);
    window.setTimeout(() => setCopiedUrl(false), 1800);
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-label="تطبيق الأندرويد — زر افتح ورقعة الشطرنج ثلاثية الأبعاد"
    >
      {/* Compact Sticky Top Bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 px-4 sm:px-6 h-14 bg-[#121722]/95 backdrop-blur border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <Smartphone className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>واجهة تطبيق الأندرويد (افتح)</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-500 rounded-xl transition-colors"
        >
          <X className="w-4 h-4" />
          <span>العودة</span>
        </button>
      </div>

      {/* Responsive Mobile-First Body */}
      <div className="flex-1 w-full max-w-5xl mx-auto px-4 py-6 grid grid-cols-1 lg:grid-cols-12 gap-6 items-center">
        {/* Left/Center: Integrated Unified "افتح" Button + 3D Chessboard Underneath */}
        <div className="lg:col-span-6 flex flex-col items-center">
          <div className="w-full max-w-[400px] bg-[#0B0E14] border border-slate-800 rounded-3xl p-4 shadow-2xl">
            <a
              href={TARGET_APP_URL}
              className="group block w-full rounded-2xl overflow-hidden border-2 border-emerald-500/60 bg-[#121722] shadow-xl hover:border-emerald-400 active:scale-[0.985] transition-all focus:outline-none focus:ring-2 focus:ring-emerald-400"
            >
              {/* Large Prominent "افتح" Primary Button */}
              <div className="min-h-[68px] px-6 py-4 bg-gradient-to-l from-emerald-500 to-emerald-600 group-hover:from-emerald-400 group-hover:to-emerald-500 text-slate-950 flex items-center justify-center gap-3">
                <span className="text-2xl sm:text-3xl font-extrabold tracking-tight">افتح</span>
                <ArrowLeft className="w-7 h-7 stroke-[2.5]" />
              </div>

              {/* Integrated 3D Chessboard Image Directly Underneath */}
              <div className="relative aspect-square w-full bg-[#0B0E14] overflow-hidden border-t border-emerald-300/20">
                {!imageFailed ? (
                  <img
                    src={chessboard3dImg}
                    alt="رقعة شطرنج ثلاثية الأبعاد بجميع القطع"
                    onError={() => setImageFailed(true)}
                    className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-300"
                  />
                ) : (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 bg-gradient-to-br from-slate-900 via-[#121722] to-emerald-950/30 text-center">
                    <span className="text-5xl mb-3" aria-hidden="true">
                      ♚♛♜♝♞♟
                    </span>
                    <span className="text-sm font-semibold text-slate-200">
                      رقعة شطرنج ثلاثية الأبعاد
                    </span>
                  </div>
                )}
              </div>
            </a>

            <p className="mt-3 text-center text-xs text-slate-400 leading-relaxed">
              الزر الكبير <strong className="text-emerald-300">«افتح»</strong> وصورة الرقعة ثلاثية
              الأبعاد مدمجان معاً؛ الضغط على أي منهما يفتح الرابط المحدد مباشرة.
            </p>
          </div>
        </div>

        {/* Right: Android Studio Kotlin WebView Project Export & Direct Options */}
        <div className="lg:col-span-6 space-y-4">
          <div className="bg-[#121722] border border-slate-800 rounded-2xl p-5 space-y-4">
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-100">
                تجهيز تطبيق الأندرويد وتشغيله
              </h2>
              <p className="mt-1 text-xs sm:text-sm text-slate-400 leading-relaxed">
                يحتوي المشروع البرمجي للأندرويد (<span className="font-mono text-slate-200">Kotlin + WebView</span>)
                على نفس الزر الكبير <strong className="text-slate-200">«افتح»</strong> ومدمج تحته
                صورة الرقعة ثلاثية الأبعاد، مع صلاحية الكاميرا (<span className="font-mono text-slate-200">CAMERA</span>)
                وفتح الرابط المستهدف مباشرة داخل التطبيق.
              </p>
            </div>

            {/* Target URL Box */}
            <div className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3 flex items-center justify-between gap-2">
              <span
                dir="ltr"
                className="text-xs font-mono text-cyan-300 truncate select-all"
              >
                {TARGET_APP_URL}
              </span>
              <button
                type="button"
                onClick={handleCopyUrl}
                className="inline-flex items-center gap-1 min-h-[44px] px-3 text-xs font-medium text-slate-200 bg-slate-800/80 hover:bg-slate-700 rounded-lg shrink-0 transition-colors"
              >
                {copiedUrl ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span>تم النسخ</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>نسخ الرابط</span>
                  </>
                )}
              </button>
            </div>

            {/* Action Buttons (>= 48px touch targets) */}
            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => void handleDownloadSelfContainedLauncherHtml()}
                disabled={isDownloadingHtml}
                className="w-full min-h-[52px] px-4 py-3 bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-bold text-sm rounded-xl flex items-center justify-center gap-2 transition-colors active:scale-[0.99]"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>
                  {isDownloadingHtml
                    ? 'جاري توليد الملف وتضمين الصورة...'
                    : 'توليد وتنزيل ملف المشغّل المتكامل (.html)'}
                </span>
              </button>

              <button
                type="button"
                onClick={() => void handleDownloadAndroidZip()}
                disabled={isDownloadingAndroidZip}
                className="w-full min-h-[48px] px-4 py-2.5 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/40 text-cyan-300 font-semibold text-xs sm:text-sm rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                <Download className="w-4 h-4 shrink-0" />
                <span>
                  {isDownloadingAndroidZip
                    ? 'جاري توليد حزمة أندرويد...'
                    : 'توليد وتنزيل مشروع Android Studio (.zip)'}
                </span>
              </button>

              <a
                href={TARGET_APP_URL}
                className="w-full min-h-[48px] px-4 py-2.5 bg-[#0B0E14] hover:bg-slate-900 border border-slate-700 text-slate-200 font-semibold text-xs sm:text-sm rounded-xl flex items-center justify-center gap-2 transition-colors"
              >
                <ExternalLink className="w-4 h-4 shrink-0" />
                <span>افتح الرابط المستهدف الآن</span>
              </a>
            </div>

            {/* Direct Download Links */}
            <div className="bg-[#0B0E14] border border-slate-800 rounded-xl p-3.5 space-y-2">
              <p className="text-xs font-semibold text-slate-200">روابط التنزيل المباشرة:</p>
              <div className="flex flex-wrap gap-2">
                <a
                  href="/api/download/open-launcher.html"
                  download="chess-vision-open-launcher.html"
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-2 text-xs font-medium text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded-lg transition-colors"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>رابط ملف «افتح» (.html)</span>
                </a>
                <a
                  href="/api/download/android-app.zip"
                  download="chess-vision-android-app.zip"
                  className="inline-flex items-center gap-1.5 min-h-[44px] px-3 py-2 text-xs font-medium text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 rounded-lg transition-colors"
                >
                  <Download className="w-3.5 h-3.5 shrink-0" />
                  <span>رابط مشروع الأندرويد (.zip)</span>
                </a>
              </div>
            </div>

            {downloadNote && (
              <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-lg px-3 py-2">
                {downloadNote}
              </div>
            )}

            <div className="text-xs text-slate-400 bg-[#0B0E14] border border-slate-800/90 rounded-xl p-3.5 leading-relaxed space-y-1">
              <p className="font-semibold text-slate-200">ملاحظة بخصوص البناء على GitHub وملف APK:</p>
              <p>
                يتضمن ملف <span className="font-mono text-slate-300">.zip</span> جميع ملفات{' '}
                <span className="font-mono text-slate-300">Gradle Wrapper 8.9</span> وملف سير العمل{' '}
                <span className="font-mono text-slate-300">.github/workflows/android.yml</span> الذي
                يولّد مفتاح التوقيع التجريبي (<span className="font-mono text-slate-300">debug.keystore</span>)
                تلقائياً ولا يتطلب <span className="font-mono text-slate-300">google-services.json</span>،
                لإنتاج ملف <span className="font-mono text-slate-300">app-debug.apk</span> قابل للتثبيت دون أخطاء.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
