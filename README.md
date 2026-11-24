# ilova_sayt — telefon va brauzer uchun sayt

Kompyuter ilovasi (`pdd-desktop-app`) bilan **bir xil interfeys**, lekin brauzerda ishlaydi.
Savol va katalog ma’lumotlari Vercel’da joylashgan statik snapshot’dan olinib IndexedDB’da
saqlanadi. Supabase ilova ishlayotgan paytda faqat aktivatsiya uchun ishlatiladi; admin
ma’lumotlarni Supabase’da tahrirlaydi va kerak bo‘lganda GitHub’ga bir marta nashr qiladi.

## Ishga tushirish

```bash
npm install
npm run build        # dist/ papkasini yig'adi (esbuild, .env dan Supabase manzili va kalitini oladi)
npm start            # http://localhost:4173 da tekshirish
npm run dev          # ishlab chiqish: fayllar o'zgarganda avtomatik qayta yig'adi
```

`npm run dev` ishlayotganda fayllarni saqlang; sayt avtomatik qayta yig'iladi. Brauzerda yangilangan holatini ko'rish uchun sahifani qayta yuklang.

`.env` faylida `VITE_SUPABASE_URL` va `VITE_SUPABASE_ANON_KEY` bo‘lishi kerak.
`service_role` kalitni bu faylga qo‘ymang — `build.mjs` bunday kalitni ko‘rsa,
yig‘ishni to‘xtatadi.

Sayt aktivatsiyasi uchun Supabase'da
[`settings/sql/supabase_web_activation_migration.sql`](../settings/sql/supabase_web_activation_migration.sql)
migratsiyasini bir marta ishga tushiring. Qayta ishlatiladigan kodlar uchun
[`settings/sql/supabase_web_activation_reusable_codes_migration.sql`](../settings/sql/supabase_web_activation_reusable_codes_migration.sql)
migratsiyasini ham bajaring. Snapshot’ni GitHub Actions orqali olish uchun
[`settings/sql/supabase_static_site_publish_migration.sql`](../settings/sql/supabase_static_site_publish_migration.sql)
migratsiyasini ham ishga tushiring. Eski o‘rnatmalarda
[`settings/sql/supabase_single_device_auth_migration.sql`](../settings/sql/supabase_single_device_auth_migration.sql)
qo‘llangan bo‘lsa, undan keyin
[`settings/sql/supabase_web_activation_unlimited_devices_migration.sql`](../settings/sql/supabase_web_activation_unlimited_devices_migration.sql)
migratsiyasini ham bajaring; u qurilma cheklovini olib tashlaydi.

## Savollar va rasmlarni nashr qilish

1. Supabase SQL Editor’da yuqoridagi `supabase_static_site_publish_migration.sql` migratsiyasini
   bir marta bajaring.
2. `AsliddinXoliqulov/Azizbek_avto_test_ilova_sayt` GitHub repozitori Actions secrets’iga
   `SUPABASE_URL` va `SUPABASE_SERVICE_ROLE_KEY` qo‘shing.
3. Admin panel Vercel loyihasiga `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` va faqat serverda ishlatiladigan `GITHUB_WORKFLOW_TOKEN`
   muhit o‘zgaruvchilarini qo‘shing. GitHub tokeniga shu repozitoridagi workflow’ni ishga
   tushirish (`Actions: write`) va oxirgi nashr faylini o‘qish (`Contents: read`) huquqini
   bering; uni brauzerga yoki repoga joylamang.
4. Sayt Vercel loyihasida build uchun `VITE_SUPABASE_URL` va `VITE_SUPABASE_ANON_KEY`
   bo‘lishi kerak. Admin paneldagi **Kodlar → Sayt ma’lumotlarini nashr qilish** tugmasi
   GitHub Actions ishini boshlaydi: u Supabase’dan snapshot va rasmlarni olib repoga push
   qiladi, so‘ng Vercel qayta deploy qiladi.
5. Yangi sayt deploy bo‘lgach, eski savol xatolari/saqlanganlar jadvali va RPC’larini
   o‘chirish uchun Supabase’da
   [`settings/sql/supabase_remove_web_question_progress.sql`](../settings/sql/supabase_remove_web_question_progress.sql)
   migratsiyasini bajaring. Buni eski sayt versiyasi RPC ishlatmay qolganidan keyin bajaring.

## Internetga joylash

`dist/` — oddiy statik sayt. Vercel / Netlify / Cloudflare Pages / GitHub Pages — istalganiga bo'ladi.
Vercel: loyihani ulang, Environment Variables'ga `VITE_SUPABASE_URL` va `VITE_SUPABASE_ANON_KEY` ni kiriting
(`vercel.json` tayyor: build `npm run build`, chiqish `dist`).

## Qanday ishlaydi

1. **Faollashtirish.** Admin paneldagi **Sayt** bo'limidan 6 xonali raqamli kod olinadi
   (desktop kodlaridan alohida saqlanadi va ko‘p qurilmada ishlaydi).
   Kod yaratilganidan 15 kun o'tgach muddati tugaydi; shu vaqtdan keyin saytga kirish ham bloklanadi.
   Brauzer fingerprinti faqat har bir brauzerning aktivatsiya va sinxronlash holatini aniqlash uchun
   ishlatiladi; bitta kodni qayta kiritib, boshqa brauzer yoki qurilmada ham faollashtirish mumkin.
2. **Savollar va katalog.** Ilova `public/data/version.json` orqali joriy snapshot versiyasini
   tekshiradi; yangi snapshot Vercel’dan olinib IndexedDB’da saqlanadi. Supabase RPC’lari
   foydalanuvchi brauzerida chaqirilmaydi.
3. **Rasmlar.** Admin nashr qilish tugmasini bosganda GitHub Actions rasm fayllarini
   Supabase’dan `public/basa_img/` ichiga ko‘chiradi; storage papka yo‘llari saqlanadi.
   Brauzer rasmni Vercel’dan birinchi marta ko‘rganda yuklab Cache Storage’da saqlaydi;
   keyingi ochishda keshdan foydalanadi.
4. **Internetsiz ishlash.** Ilova qobig'i service worker bilan, savollar IndexedDB bilan saqlanadi. Oflayn ijara muddati
   `src/renderer/src/web/activation.js` dagi `OFFLINE_GRACE_MS` (hozir 7 kun; kompyuter ilovasida sinov uchun 1 soat).
   Kod muddati (`activation_expires_at`) bundan qat'i nazar har doim tekshiriladi.
5. **Imtihon tarixi.** Kompyuter ilovasidagidek, tugagan imtihonlar har ishga tushganda tozalanadi («bu sessiyada»).
   Doimiy saqlash uchun `src/renderer/src/web/engine.js` da `KEEP_EXAM_HISTORY = true` qiling.
6. **Ma’lumotlarni yangilash.** Admin savol yoki rasmni o‘zgartirgach, o‘zgarishlar bir joyga
   jamlanganda nashr tugmasini bosadi. Har bir tahrir Supabase’dan alohida olinmaydi.

## Tuzilma

- `src/renderer/src/` — kompyuter ilovasidan ko'chirilgan sahifalar va CSS (o'zgarmagan) + `styles/mobile.css` (telefon moslashuvi).
- `src/renderer/src/web/` — brauzer qatlami: `api.js` (`window.api`), `engine.js` (SQLite mantig'ining JS ko'chirmasi),
  `sync.js`, `images.js` (rasmlarni talab bo'yicha keshga olish), `activation.js`, `db.js` (IndexedDB), `supabase.js`.
- `public/` — `manifest.webmanifest`, `sw.js`, ikonkalar, nashr qilingan snapshot va rasmlar.

## Cheklovlar

- Sinovdan o'tgan: Chromium (telefon o'lchami), soxta Supabase javoblari bilan: faollashtirish, sinxronlash, dars/imtihon,
  tarix, internetsiz qayta ochish. Haqiqiy telefon va haqiqiy Supabase bilan sinab ko'rilmagan.
- iPhone'da Safari uzoq vaqt ochilmagan sayt ma'lumotlarini o'chirib yuborishi mumkin; shunda kod qayta kiritiladi.
- Kompyuter ilovasidagi mahalliy `images` papkasi o'rniga rasmlar kerak bo'lganda internetdan olinib, brauzer keshida saqlanadi.
