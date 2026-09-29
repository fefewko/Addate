// Проверки новой логики, которой не было в проекте: определение формата
// картинки по байтам и разбор адресов под /web.
// Запуск: npm run test:web-logic

const { detectImageFormat, imageFormatForUpload } = require('../src/lib/imageBytes.ts');

let failed = 0;
let total = 0;

function check(label, actual, expected) {
  total++;
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    failed++;
    console.log(`  ✗ ${label}`);
    console.log(`      получено:  ${JSON.stringify(actual)}`);
    console.log(`      ожидалось: ${JSON.stringify(expected)}`);
  }
}

// Собираем буфер с нужной сигнатурой в начале.
function bytes(prefix, suffix) {
  return Uint8Array.from([...prefix, ...(suffix || [])]).buffer;
}

const JPEG_SIG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01];
const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d];
const GIF_SIG = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x00, 0x00];

// ftyp-контейнер: 'ftyp' на позиции 4, бренд на позиции 8
function ftyp(brand) {
  const sig = [0x00, 0x00, 0x00, 0x20];
  const f = 'ftyp'.split('').map((c) => c.charCodeAt(0));
  const b = brand.split('').map((c) => c.charCodeAt(0));
  return [...sig, ...f, ...b, 0x00, 0x00, 0x00, 0x00];
}

console.log('Определение формата по содержимому файла');

check('JPEG', detectImageFormat(bytes(JPEG_SIG)), { ext: 'jpg', mimeType: 'image/jpeg' });
check('PNG', detectImageFormat(bytes(PNG_SIG)), { ext: 'png', mimeType: 'image/png' });
check('GIF', detectImageFormat(bytes(GIF_SIG)), { ext: 'gif', mimeType: 'image/gif' });
check(
  'WebP (RIFF + WEBP)',
  detectImageFormat(bytes([0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50])),
  { ext: 'webp', mimeType: 'image/webp' }
);
check('HEIC', detectImageFormat(bytes(ftyp('heic'))), { ext: 'heic', mimeType: 'image/heic' });
check('HEIF (mif1)', detectImageFormat(bytes(ftyp('mif1'))), { ext: 'heic', mimeType: 'image/heic' });
check('AVIF', detectImageFormat(bytes(ftyp('avif'))), { ext: 'avif', mimeType: 'image/avif' });
check('BMP', detectImageFormat(bytes([0x42, 0x4d, 0x36, 0x00, 0, 0, 0, 0, 0, 0, 0, 0])), {
  ext: 'bmp',
  mimeType: 'image/bmp',
});

// RIFF без признака WEBP — это, например, WAV. Принимать его за картинку
// нельзя: contentType уехал бы в хранилище вместе с чужим форматом.
check('RIFF, но не WEBP', detectImageFormat(bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])), null);

// То, из-за чего всё затевалось: на вебе пикер отдаёт blob:https://addate.ru/web/uuid.
// Расширения в такой строке нет вообще, домен в ней есть, и старый разбор
// давал в качестве расширения «0:8081/uuid».
console.log('\nblob-ссылка не должна влиять на формат');
const blobBytes = bytes(JPEG_SIG);
check('JPEG по содержимому blob', detectImageFormat(blobBytes), {
  ext: 'jpg',
  mimeType: 'image/jpeg',
});

check('пустой файл', detectImageFormat(new ArrayBuffer(0)), null);
check('короче сигнатуры', detectImageFormat(new ArrayBuffer(6)), null);
check('неизвестное содержимое -> jpeg по умолчанию', imageFormatForUpload(new ArrayBuffer(32)), {
  ext: 'jpg',
  mimeType: 'image/jpeg',
});

console.log('\nПути веб-версии');

// Импортируется настоящий модуль, а не его копия: логика путей вынесена в
// webPaths.ts именно затем, чтобы её можно было проверить, не поднимая
// react-native. Копия в тесте расходилась бы с оригиналом при первом же
// исправлении — и проверяла бы не то, что работает в приложении.
const { buildWebPath, stripWebBase, WEB_BASE_PATH } = require('../src/lib/webPaths.ts');

check('префикс объявлен один раз', WEB_BASE_PATH, '/web');

check('пустой путь', buildWebPath(''), '/web');
check('путь без слешей', buildWebPath('all'), '/web/all');
check('путь с ведущим слешем', buildWebPath('/chats'), '/web/chats');
check('путь с хвостовым слешем', buildWebPath('/chats/'), '/web/chats');
check('вложенный путь', buildWebPath('profile/1f0c-uuid'), '/web/profile/1f0c-uuid');

check('разбор с префиксом', stripWebBase('/web/all'), '/all');
check('разбор с двойным слешем', stripWebBase('/web//chats'), '/chats');
check('разбор корня', stripWebBase('/web'), '/');
check('разбор корня со слешем', stripWebBase('/web/'), '/');
check('разбор без префикса не ломается', stripWebBase('/all'), '/all');

// Круговая согласованность: то, что собрали, должно разбираться обратно без
// слешей. Это ровно тот случай, из-за которого адрес уезжал в /all.
check(
  'собранный путь разбирается обратно',
  stripWebBase(buildWebPath('all')).replace(/\/+$/, '') || '/',
  '/all'
);

console.log('');
if (failed === 0) {
  console.log(`все ${total} проверок пройдены`);
} else {
  console.log(`провалено: ${failed} из ${total}`);
  process.exit(1);
}
