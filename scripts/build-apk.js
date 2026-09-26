// scripts/build-apk.js
//
// Локальная сборка Android APK. Сделано скриптом, а не цепочкой команд в
// package.json, по трём причинам:
//
//   1. Нужно выставлять ANDROID_HOME: на машине переменная не задана, SDK лежит
//      в стандартном месте, и gradlew без неё SDK не находит.
//   2. Gradle требует NODE_ENV и ругается на его отсутствие.
//   3. Сборка нативного кода сразу для четырёх ABI на ноутбуке обрывается по
//      нехватке памяти. По умолчанию собираем только arm64-v8a — этого
//      достаточно для любого современного телефона.
//
// Использование:
//   npm run build:apk
//   npm run build:apk -- --arch x86_64     для эмулятора
//   npm run build:apk -- --arch all        универсальный APK
//   npm run build:apk -- --heap 6g
//   npm run build:apk -- --rebuild         перегенерировать android/
//
// Первый запуск занимает 5–10 минут: качаются Gradle и зависимости.
// Последующие — около минуты, если менялся только JS.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const ALL_ABIS = 'armeabi-v7a,arm64-v8a,x86,x86_64';
const PHONE_ABIS = 'arm64-v8a';

const isWindows = os.platform() === 'win32';

function flagValue(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1];
  }
  return fallback;
}

function findAndroidSdk() {
  const fromEnv = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;

  const candidates = isWindows
    ? [path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')]
    : [
        path.join(os.homedir(), 'Library', 'Android', 'sdk'),
        path.join(os.homedir(), 'Android', 'Sdk'),
        '/usr/local/lib/android/sdk',
      ];

  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) {
    console.error(
      '\nНе найден Android SDK.\n' +
        'Задайте ANDROID_HOME или ANDROID_SDK_ROOT и повторите.\n'
    );
    process.exit(1);
  }
  return found;
}

function fail(message) {
  console.error('\n' + message + '\n');
  process.exit(1);
}

function main() {
  const archArg = flagValue('arch', PHONE_ABIS);
  const heap = flagValue('heap', '4g');

  // Аргументы уходят в gradle через оболочку (на Windows .bat иначе не
  // запускается), поэтому неэкранированная строка от пользователя — это
  // потенциальная инъекция в команду. Проверяем значения по белому списку.
  const ALLOWED_ABIS = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
  const abis = archArg === 'all' ? ALL_ABIS : archArg;
  if (abis !== ALL_ABIS && !ALLOWED_ABIS.includes(abis)) {
    fail(`Неизвестная архитектура: ${archArg}\nДопустимо: ${ALLOWED_ABIS.join(', ')} или all.`);
  }
  if (!/^\d+[gm]$/i.test(heap)) {
    fail(`Неверный размер heap: ${heap}\nОжидается число с суффиксом, например 4g.`);
  }

  const rebuild = process.argv.includes('--rebuild');

  const sdk = findAndroidSdk();

  console.log('Локальная сборка APK');
  console.log(`  SDK:      ${sdk}`);
  console.log(`  ABI:      ${abis}`);
  console.log(`  heap:     ${heap}`);
  console.log('  NODE_ENV: production');

  if (rebuild && fs.existsSync(ANDROID_DIR)) {
    console.log('\nУдаляю android/ (--rebuild)...');
    fs.rmSync(ANDROID_DIR, { recursive: true, force: true });
  }

  // Нативный проект нужен только когда менялись нативные зависимости или
  // плагины из app.json. Правки чисто JS-овые его не трогают, поэтому
  // пересоздавать android/ на каждый билл — потеря нескольких минут.
  if (!fs.existsSync(path.join(ANDROID_DIR, 'app'))) {
    console.log('\nНативного проекта нет, выполняю prebuild...');
    const pre = spawnSync('npx expo prebuild --platform android', {
      cwd: ROOT,
      stdio: 'inherit',
      shell: isWindows,
    });
    if (pre.status !== 0) fail('prebuild не удался.');
  } else {
    console.log('\nНативный проект на месте, prebuild пропускаю.');
    console.log('Если менялись нативные зависимости — запустите с --rebuild.');
  }

  const gradlew = isWindows
    ? path.join(ANDROID_DIR, 'gradlew.bat')
    : path.join(ANDROID_DIR, 'gradlew');

  if (!fs.existsSync(gradlew)) {
    fail(`Не найден gradlew: ${gradlew}\nЗапустите с --rebuild.`);
  }

  console.log('\nСобираю, это займёт несколько минут...\n');

  // Вывод идёт прямо в терминал намеренно. Раньше здесь стояло
  // перенаправление в лог через cmd.exe, но вложенные кавычки в такой
  // конструкции ломали разбор команды. Лог всё равно не помогал бы: при обрыве
  // процесса по нехватке памяти он оставался неполным. Настоящая причина обрыва
  // устранена ограничением набора ABI, поэтому ловить обрыв логом не нужно.
  //
  // Обратите внимание: -Dorg.gradle.jvmargs идёт без -XX:MaxMetaspaceSize.
  // Значение с пробелом требует кавычек, а кавычки здесь ломают разбор
  // аргументов. Размер метапространства остаётся из android/gradle.properties.
  const gradleArgs = [
    'assembleRelease',
    `-PreactNativeArchitectures=${abis}`,
    `-Dorg.gradle.jvmargs=-Xmx${heap}`,
  ];

  // На Windows .bat запускается только через оболочку. Команда собирается
  // одной строкой, а не массивом аргументов: при shell:true с массивом Node
  // ругается DEP0190, потому что аргументы не экранируются. Здесь это
  // безопасно — все значения прошли проверку по белому списку выше и не
  // содержат пробелов, а путь к gradlew не содержит пробелов либо закавычен.
  const command = isWindows
    ? `"${gradlew}" ${gradleArgs.join(' ')}`
    : `${gradlew} ${gradleArgs.map((a) => `'${a}'`).join(' ')}`;

  const res = spawnSync(command, {
    cwd: ANDROID_DIR,
    env: {
      ...process.env,
      ANDROID_HOME: sdk,
      ANDROID_SDK_ROOT: sdk,
      NODE_ENV: 'production',
    },
    stdio: 'inherit',
    shell: isWindows,
  });

  if (res.status !== 0) {
    let hint = '';
    if (abis === ALL_ABIS) {
      hint =
        '\nЕсли процесс оборвался без сообщения об ошибке, соберите arm64-v8a ' +
        '(вариант по умолчанию): четыре ABI требуют заметно больше памяти.';
    }
    fail('Сборка не удалась.' + hint);
  }

  const apkPath = path.join(
    ANDROID_DIR,
    'app',
    'build',
    'outputs',
    'apk',
    'release',
    'app-release.apk'
  );

  if (!fs.existsSync(apkPath)) {
    fail(`Сборка отчётся успешной, но APK не найден: ${apkPath}`);
  }

  const mb = (fs.statSync(apkPath).size / 1024 / 1024).toFixed(1);
  console.log('\nГотово.');
  console.log(`  APK: ${apkPath} (${mb} MB)`);
  console.log(`  ABI: ${abis}`);
  console.log('\nПодпись — отладочным ключом android/app/debug.keystore.');
  console.log('Поэтому такой APK не встанет поверх собранного в EAS: подписи');
  console.log('разные, старый сначала нужно удалить с телефона.');
  console.log('\nPush-уведомления не заработают: нужны FCM-credentials');
  console.log('(google-services.json), их в проекте нет.');
}

main();
