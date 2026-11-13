// src/lib/keyBackup.ts
//
// Резервная копия приватного ключа E2EE.
//
// Зачем: приватный ключ хранится только на устройстве. Переустановка
// приложения или очистка данных означали потерю всей истории переписки, а до
// 0.0.23 — ещё и невозможность писать, пока ключ не заменят вручную.
//
// Как устроено:
//   * из пароля учётной записи выводится ключ шифрования (PBKDF2-HMAC-SHA512,
//     случайная соль на пользователя);
//   * приватный ключ шифруется этим ключом (XSalsa20-Poly1305, secretbox) и
//     кладётся в таблицу e2ee_key_backups — строку видит только её владелец;
//   * сервер получает только шифртекст: без пароля он бесполезен, поэтому
//     E2EE-гарантия «сервер не читает переписку» сохраняется;
//   * при входе на новом устройстве ключ расшифровывается паролем,
//     сохраняется локально и публикуется в профиле.
//
// Пароль никогда не сохраняется. Выведенный из него ключ кешируется в
// защищённом хранилище ОС (Keychain/Keystore): он нужен, чтобы после замены
// ключа (resetIdentity) обновить резервную копию без повторного ввода пароля.
// Риск не увеличивается — приватный ключ и так лежит на устройстве.
//
// Ограничение: если пароль изменён вне приложения (например, через службу
// восстановления Supabase), старая копия этим паролем уже не откроется. При
// следующем входе на устройстве, где ключ на месте, копия перезаписывается
// новым паролем.

import { getSecret, setSecret, deleteSecret } from './secureStorage';
import { getNacl, getLocalPrivateKey, setLocalPrivateKey, getPublicKey, savePublicKey, publicKeyFromSecretKey, ensureIdentity } from './e2ee';
import { base64ToBytes, bytesToBase64, utf8ToBytes } from './encoding';
import { supabase } from './supabase';
import { log } from './log';

// 50 000 итераций — компромисс: PBKDF2-HMAC-SHA512 в чистом JS на телефоне
// занимает порядка 2–4 секунд (на десктопе ~0.8 с). Больше итераций надёжнее,
// но вход становится заметно медленнее; вывод выполняется только когда копию
// действительно нужно создать или восстановить, а не при каждом входе.
const PBKDF2_ITERATIONS = 50_000;
const SALT_BYTES = 16;
const SECRETBOX_NONCE_BYTES = 24;
const SECRET_KEY_BYTES = 32;

const SHA512_BLOCK_BYTES = 128;

// PBKDF2 — тяжёлый синхронный цикл. Если выполнять его одним куском, главный
// поток (и индикатор загрузки на экране входа) замирает на несколько секунд, а
// на медленных устройствах это риск ANR. Раз в 4096 итераций отдаём управление
// циклу событий — вычисление от этого не медленнее заметно, зато интерфейс
// продолжает перерисовываться.
const YIELD_EVERY_ITERATIONS = 4096;

const cachedKeyStorageKey = (userId: string) => `e2ee:backupKey:${userId}`;

export type KeyBackupPayload = {
  v: 1;
  kdf: 'pbkdf2-sha512';
  iterations: number;
  /** base64: соль PBKDF2. */
  salt: string;
  /** base64: nonce secretbox. */
  nonce: string;
  /** base64: зашифрованный приватный ключ (secretbox). */
  ct: string;
  /** base64: публичный ключ, соответствующий зашифрованному приватному. */
  publicKey: string;
};

type CachedBackupKey = {
  /** base64: выведенный из пароля ключ шифрования копии. */
  kek: string;
  /** base64: соль, с которой он был выведен. */
  salt: string;
  iterations: number;
};

export type BackupSyncResult =
  /** Ключ восстановлен из копии и опубликован в профиле. */
  | 'restored'
  /** Копия создана или обновлена по текущему локальному ключу. */
  | 'created'
  /** На устройстве уже рабочий ключ, копия на месте. */
  | 'active'
  /** Ни копии, ни рабочего ключа: нужна замена ключа вручную. */
  | 'conflict'
  /** Копия есть, но не расшифровалась (пароль изменился / данные повреждены). */
  | 'failed';

// ---------------------------------------------------------------------------
// PBKDF2-HMAC-SHA512 на чистом JS
// ---------------------------------------------------------------------------
//
// В expo-crypto нет PBKDF2, а тянуть нативную библиотеку ради одной операции
// не хочется. Нужен только HMAC-SHA512, а SHA-512 уже есть в tweetnacl
// (nacl.hash). Реализация проверена на векторах Node crypto.

function sha512(data: Uint8Array): Uint8Array {
  return getNacl().hash(data);
}

function createHmacSha512(key: Uint8Array): (message: Uint8Array) => Uint8Array {
  const normalized = key.length > SHA512_BLOCK_BYTES ? sha512(key) : key;

  const keyBlock = new Uint8Array(SHA512_BLOCK_BYTES);
  keyBlock.set(normalized);

  const innerPad = new Uint8Array(SHA512_BLOCK_BYTES);
  const outerPad = new Uint8Array(SHA512_BLOCK_BYTES);
  for (let i = 0; i < SHA512_BLOCK_BYTES; i++) {
    innerPad[i] = keyBlock[i] ^ 0x36;
    outerPad[i] = keyBlock[i] ^ 0x5c;
  }

  return function hmac(message: Uint8Array): Uint8Array {
    const inner = new Uint8Array(SHA512_BLOCK_BYTES + message.length);
    inner.set(innerPad, 0);
    inner.set(message, SHA512_BLOCK_BYTES);

    const innerHash = sha512(inner);

    const outer = new Uint8Array(SHA512_BLOCK_BYTES + innerHash.length);
    outer.set(outerPad, 0);
    outer.set(innerHash, SHA512_BLOCK_BYTES);

    return sha512(outer);
  };
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function pbkdf2Sha512(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  keyLength: number
): Promise<Uint8Array> {
  const hmac = createHmacSha512(password);
  const result = new Uint8Array(keyLength);
  let written = 0;
  let blockIndex = 1;

  while (written < keyLength) {
    const firstInput = new Uint8Array(salt.length + 4);
    firstInput.set(salt, 0);
    firstInput[salt.length] = (blockIndex >>> 24) & 0xff;
    firstInput[salt.length + 1] = (blockIndex >>> 16) & 0xff;
    firstInput[salt.length + 2] = (blockIndex >>> 8) & 0xff;
    firstInput[salt.length + 3] = blockIndex & 0xff;

    let u = hmac(firstInput);
    const t = u.slice();

    for (let i = 1; i < iterations; i++) {
      u = hmac(u);
      for (let j = 0; j < t.length; j++) {
        t[j] ^= u[j];
      }
      if (i % YIELD_EVERY_ITERATIONS === 0) {
        await nextTick();
      }
    }

    const take = Math.min(t.length, keyLength - written);
    result.set(t.subarray(0, take), written);
    written += take;
    blockIndex++;
  }

  return result;
}

async function deriveBackupKey(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  return pbkdf2Sha512(utf8ToBytes(password), salt, iterations, SECRET_KEY_BYTES);
}

// ---------------------------------------------------------------------------
// Кеш выведенного ключа
// ---------------------------------------------------------------------------

async function cacheBackupKey(
  userId: string,
  kek: Uint8Array,
  salt: string,
  iterations: number
): Promise<void> {
  const cached: CachedBackupKey = {
    kek: bytesToBase64(kek),
    salt,
    iterations,
  };
  // KEK — такой же секрет, как приватный ключ: с ним открывается резервная
  // копия. Поэтому он тоже уходит в Keychain/Keystore, а не в AsyncStorage.
  await setSecret(cachedKeyStorageKey(userId), JSON.stringify(cached));
}

async function readCachedBackupKey(userId: string): Promise<CachedBackupKey | null> {
  try {
    const raw = await getSecret(cachedKeyStorageKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedBackupKey;
    if (!parsed?.kek || !parsed?.salt || !parsed?.iterations) return null;
    return parsed;
  } catch (e) {
    log.warn('Резервная копия ключа: не удалось прочитать кеш ключа:', e);
    return null;
  }
}

async function clearCachedBackupKey(userId: string): Promise<void> {
  await deleteSecret(cachedKeyStorageKey(userId));
}

// ---------------------------------------------------------------------------
// Хранилище на сервере
// ---------------------------------------------------------------------------

/** Есть ли на сервере резервная копия ключа (нужно для предупреждений). */
export async function hasKeyBackup(userId: string): Promise<boolean> {
  return (await fetchBackupRow(userId)) !== null;
}

async function fetchBackupRow(userId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('e2ee_key_backups')
    .select('backup')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    // Таблицы может не быть, пока миграция не применена. Это не повод ломать
    // вход: резервная копия — вспомогательная функция.
    log.warn('Резервная копия ключа: не удалось прочитать копию:', error.message);
    return null;
  }

  return (data as { backup?: string } | null)?.backup ?? null;
}

async function uploadBackup(userId: string, payload: KeyBackupPayload): Promise<void> {
  // .select() нужен, чтобы убедиться, что строка действительно записалась:
  // PostgREST при RLS/отсутствии гранта может ответить успехом, не изменив
  // ничего (та же ловушка, что и с profiles.public_key).
  const { data, error } = await supabase
    .from('e2ee_key_backups')
    .upsert(
      {
        user_id: userId,
        backup: JSON.stringify(payload),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select('user_id');

  if (error) {
    throw new Error(
      'не удалось сохранить резервную копию ключа: ' + error.message
    );
  }
  if (!data || data.length === 0) {
    throw new Error(
      'резервная копия ключа не сохранилась: нет прав на таблицу e2ee_key_backups (примените миграцию 20261113000000_e2ee_key_backup.sql)'
    );
  }
}

async function deleteBackup(userId: string): Promise<void> {
  const { error } = await supabase.from('e2ee_key_backups').delete().eq('user_id', userId);
  if (error) {
    log.warn('Резервная копия ключа: не удалось удалить устаревшую копию:', error.message);
  }
}

function parsePayload(raw: string | null): KeyBackupPayload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as KeyBackupPayload;
    if (
      parsed?.v !== 1 ||
      parsed.kdf !== 'pbkdf2-sha512' ||
      !parsed.salt ||
      !parsed.nonce ||
      !parsed.ct ||
      !parsed.publicKey
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Создание и восстановление
// ---------------------------------------------------------------------------

async function createBackup(
  userId: string,
  password: string,
  privateKey: Uint8Array,
  publicKeyB64: string
): Promise<void> {
  const nacl = getNacl();
  const salt = nacl.randomBytes(SALT_BYTES);
  const iterations = PBKDF2_ITERATIONS;
  const kek = await deriveBackupKey(password, salt, iterations);
  const nonce = nacl.randomBytes(SECRETBOX_NONCE_BYTES);
  const ciphertext = nacl.secretbox(privateKey, nonce, kek);

  // Кеш пишем ДО отправки: если сервер недоступен или миграция ещё не
  // применена, копию можно будет дослать позже без повторного ввода пароля
  // (syncKeyBackupWithCache при следующем запуске приложения).
  await cacheBackupKey(userId, kek, bytesToBase64(salt), iterations);

  await uploadBackup(userId, {
    v: 1,
    kdf: 'pbkdf2-sha512',
    iterations,
    salt: bytesToBase64(salt),
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ciphertext),
    publicKey: publicKeyB64,
  });
}

async function restoreFromBackup(
  userId: string,
  raw: string,
  password: string
): Promise<BackupSyncResult> {
  const payload = parsePayload(raw);
  if (!payload) {
    log.warn('Резервная копия ключа: незнакомый формат копии');
    return 'failed';
  }

  const salt = base64ToBytes(payload.salt);
  const kek = await deriveBackupKey(password, salt, payload.iterations);
  const privateKey = getNacl().secretbox.open(
    base64ToBytes(payload.ct),
    base64ToBytes(payload.nonce),
    kek
  );

  if (!privateKey || privateKey.length !== SECRET_KEY_BYTES) {
    log.warn(
      'Резервная копия ключа: копия не расшифровалась — пароль изменился или данные повреждены'
    );
    return 'failed';
  }

  const publicKeyB64 = publicKeyFromSecretKey(privateKey);
  if (payload.publicKey !== publicKeyB64) {
    log.warn('Резервная копия ключа: публичный ключ не совпадает с закрытым');
    return 'failed';
  }

  await setLocalPrivateKey(userId, privateKey);
  await savePublicKey(userId, publicKeyB64);
  await cacheBackupKey(userId, kek, payload.salt, payload.iterations);

  return 'restored';
}

/**
 * Вызывается сразу после входа с паролем.
 *
 * 1. Если на устройстве уже лежит ключ, совпадающий с profiles.public_key,
 *    ничего не восстанавливаем — только следим, чтобы копия существовала и
 *    соответствовала этому ключу.
 * 2. Если локального рабочего ключа нет (переустановка) — восстанавливаем из
 *    копии и публикуем ключ в профиле.
 * 3. Если ни копии, ни рабочего ключа нет — создаём личность и копию.
 *
 * Ошибки сети/прав не бросаем наружу: вход не должен зависеть от копии.
 */
export async function syncKeyBackup(
  userId: string,
  password: string
): Promise<BackupSyncResult> {
  const rawBackup = await fetchBackupRow(userId);

  const localPrivateKey = await getLocalPrivateKey(userId);
  const localPublicKey = localPrivateKey ? publicKeyFromSecretKey(localPrivateKey) : null;

  let profilePublicKey: string | null = null;
  try {
    const published = await getPublicKey(userId);
    profilePublicKey = published ? bytesToBase64(published) : null;
  } catch (e) {
    log.warn('Резервная копия ключа: не удалось прочитать profiles.public_key:', e);
  }

  const localKeyIsActive = !!localPublicKey && localPublicKey === profilePublicKey;

  // Переустановка или новое устройство: в профиле (или в копии) ключ есть, а
  // рабочий локальный ключ либо отсутствует, либо не совпадает с профилем.
  if (rawBackup && !localKeyIsActive) {
    return restoreFromBackup(userId, rawBackup, password);
  }

  if (localKeyIsActive) {
    const meta = parsePayload(rawBackup);
    if (meta && meta.publicKey === localPublicKey) {
      return 'active';
    }
    // Копии нет или она от другого ключа — перезаписываем текущим.
    await createBackup(userId, password, localPrivateKey!, localPublicKey!);
    return 'created';
  }

  // Ни рабочего ключа, ни копии: обычный первый вход.
  const identity = await ensureIdentity(userId);
  if (identity.keyConflict) {
    return 'conflict';
  }
  if (!identity.privateKey || !identity.publicKeyB64 || !identity.ownPublicKeyPublished) {
    return 'failed';
  }

  await createBackup(userId, password, identity.privateKey, identity.publicKeyB64);
  return 'created';
}

/**
 * Обновляет или досылает копию, используя закешированный ключ. Пароль не
 * нужен, поэтому функция безопасна для вызова в фоне при запуске приложения.
 *
 * Зачем: копия может не сохраниться при входе (нет сети, миграция применена
 * позже) — тогда следующий запуск досылает её сам, без участия пользователя.
 */
export async function syncKeyBackupWithCache(userId: string): Promise<void> {
  const cached = await readCachedBackupKey(userId);
  if (!cached) return;

  const privateKey = await getLocalPrivateKey(userId);
  if (!privateKey) return;

  const publicKeyB64 = publicKeyFromSecretKey(privateKey);

  // Не перезаписываем копию ключом, который не опубликован в профиле: значит,
  // на этом устройстве рабочий ключ ещё не готов (конфликт после переустановки).
  try {
    const published = await getPublicKey(userId);
    if (!published || bytesToBase64(published) !== publicKeyB64) return;
  } catch (e) {
    log.warn('Резервная копия ключа: не удалось проверить profiles.public_key:', e);
    return;
  }

  const meta = parsePayload(await fetchBackupRow(userId));
  if (meta?.publicKey === publicKeyB64) {
    return; // копия уже соответствует ключу на устройстве
  }

  const nacl = getNacl();
  const nonce = nacl.randomBytes(SECRETBOX_NONCE_BYTES);
  const ciphertext = nacl.secretbox(privateKey, nonce, base64ToBytes(cached.kek));

  await uploadBackup(userId, {
    v: 1,
    kdf: 'pbkdf2-sha512',
    iterations: cached.iterations,
    salt: cached.salt,
    nonce: bytesToBase64(nonce),
    ct: bytesToBase64(ciphertext),
    publicKey: publicKeyB64,
  });
}

/**
 * Перешифровывает копию новым паролем. Нужно после смены пароля: копия
 * привязана к паролю, и со старым она бы не открылась после переустановки.
 *
 * Возвращает false, если локального ключа нет (тогда перешифровывать нечего).
 */
export async function reencryptKeyBackup(userId: string, password: string): Promise<boolean> {
  const privateKey = await getLocalPrivateKey(userId);
  if (!privateKey) return false;

  const publicKeyB64 = publicKeyFromSecretKey(privateKey);

  // Копируем только рабочий ключ — тот, что опубликован в профиле. Иначе при
  // конфликте устройств (в профиле ключ другого телефона) мы бы записали в
  // резервную копию нерабочий ключ и при следующем входе подменили им профиль.
  const published = await getPublicKey(userId);
  if (!published || bytesToBase64(published) !== publicKeyB64) return false;

  await createBackup(userId, password, privateKey, publicKeyB64);
  return true;
}

/**
 * Обновляет резервную копию после замены ключа (resetIdentity).
 *
 * Без этого копия осталась бы от старого ключа, и следующий вход на новом
 * устройстве вернул бы потерянный ключ — сообщения, отправленные после замены,
 * снова стали бы нечитаемыми. Если выведенного ключа нет (пароль не вводили в
 * этой установке), копию удаляем: лучше никакой, чем заведомо устаревшая.
 */
export async function refreshKeyBackupAfterReset(userId: string): Promise<void> {
  const cached = await readCachedBackupKey(userId);
  if (!cached) {
    await deleteBackup(userId);
    await clearCachedBackupKey(userId);
    return;
  }

  await syncKeyBackupWithCache(userId);
}
