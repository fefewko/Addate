# Аудит инфраструктуры ADDate

Дата: 13.11.2026  
Область: клиент `src/`, миграции `supabase/migrations/`, конфигурация `supabase/config.toml`.  
Метод: статический разбор RLS, грантов, `SECURITY DEFINER`-функций, Storage-политик и клиентского кода. Runtime-проверка на живой БД не выполнялась.

Важно: часть выводов зависит от фактических прав в облачном проекте Supabase (они не хранятся в репозитории). Для таких пунктов приведены проверочные SQL-запросы. Всё, что помечено «требует проверки», нужно подтвердить в SQL Editor перед исправлением.

---

## 1. Краткий итог

Базовая защита построена грамотно: RLS включён на всех таблицах, служебные поля профиля защищены триггером, координаты убраны из клиентского SELECT, переписка и фото в чате шифруются на клиенте, резервная копия ключа хранится только в зашифрованном виде, тексты сообщений не логируются.

При этом найдены дыры, которые ломают заявленные гарантии:

| № | Проблема | Уровень |
|---|---|---|
| C1 | Пользователь может удалить свою строку `profiles` и вставить новую с `is_admin = true` / `moderation_status = 'approved'` — обход модерации и эскалация до администратора | критический |
| C2 | Согласия при регистрации не сохраняются: в `SignUp.tsx` отправляются несуществующие колонки, а `terms_accepted_at` запрещён триггером | высокий |
| C3 | Пару `matches` можно создать сразу со `status = 'matched'` (или перевести `pending` → `matched`) без взаимного лайка — любой может писать незнакомому человеку | высокий |
| C4 | Любой авторизованный читает **все** фото из `report-images` (жалобы) | высокий |
| C5 | Бакет `avatars` публичный: фото профиля доступны и перечисляемы даже при `show_photos = false` | высокий |
| C6 | `moderation_note` выдан всем авторизованным в прямом SELECT `profiles` | средний |
| C7 | Автор жалобы и её текст видны тому, на кого жалуются (`reported_id`) | средний |
| C8 | Новый пользователь создаётся со `moderation_status = 'pending'` и в ленту не попадает до ручного одобрения; дефолт колонки при этом синтаксически испорчен | средний |
| C9 | Приватный ключ E2EE и производный ключ резервной копии лежат в открытом AsyncStorage; PBKDF2 — 50 000 итераций | средний |
| C10 | Нет аутентификации ключей и forward secrecy: сервер может подменить `public_key` и встать в середину | средний |
| C11 | `nearby_profiles()` и `my_location()` исполняемы `anon` (по умолчанию `PUBLIC`) | низкий |
| C12 | Расшифрованные фото чата остаются в `documentDirectory` без очистки | низкий |
| C13 | Нет резервного копирования/восстановления БД в репозитории, нет проверки restore | средний (процесс) |
| C14 | Edge-функции `telegram-start`, `telegram-exchange`, `delete-account` отсутствуют в репозитории | средний (аудит невозможен) |

---

## 2. Что проверено по пунктам задания

### 2.1. Supabase Auth и управление сессиями

Реализовано:

- `src/lib/supabase.ts` — `persistSession`, `autoRefreshToken`, хранение сессии в AsyncStorage, `detectSessionInUrl: false` (для нативной части это правильно).
- `App.tsx:319-332` — подписка `onAuthStateChange`: при `SIGNED_OUT` приложение возвращается на `SignIn`. `TOKEN_REFRESHED` не трогает маршрут — верно.
- `App.tsx:337-344` — при возврате в приложение перепроверяется анкета (реакция на отклонение модератором).
- `AuthCallback.tsx` — обмен PKCE-кода на сессию, без доверия к токенам из URL.
- `SignIn.tsx` — вход по паролю; после входа вызывается `syncKeyBackup`.
- `SignUp.tsx` — регистрация, проверка 18+ на клиенте (и в БД триггером `check_profile_age`).
- `config.toml`: `jwt_expiry = 3600`, `enable_refresh_token_rotation = true`, `refresh_token_reuse_interval = 10` — разумно.

Замечания:

- `minimum_password_length = 6` и `password_requirements = ""` (`config.toml:181-184`). Для сервиса со специальными категориями данных это слабо; рекомендуется 8–12 символов и базовая проверка утечек.
- `enable_confirmations = false` (`config.toml:225`) — локальный конфиг. Если на проде так же, email не подтверждается: можно регистрироваться на чужой адрес. Проверить в Dashboard → Authentication → Providers → Email.
- Нет MFA для администраторов.
- Смена пароля (`ChangePassword.tsx`) не завершает сессии на других устройствах. Supabase может отзывать refresh-токены при смене пароля в зависимости от настроек проекта — проверить; безопаснее явно вызывать `signOut({ scope: 'others' })`.
- Telegram-вход отключён в UI (`TELEGRAM_LOGIN_ENABLED = false`), но серверные функции не версионированы (см. 2.9).

### 2.2. RLS-политики таблиц

RLS включён на: `profiles`, `matches`, `messages`, `blocks`, `reports`, `report_attachments`, `support_tickets`, `support_messages`, `push_tokens`, `telegram_identities`, `telegram_login_tokens`, `e2ee_key_backups`.

Проверенные политики:

- `profiles`: «Просмотр одобренных анкет», «Редактирование своей анкеты», «Создание своей анкеты», «Удаление своей анкеты», админские. Служебные поля (`is_admin`, `moderation_status`, `moderation_note`, `terms_accepted_at`) защищены `protect_profile_service_fields`.
- `matches`: «Свои совпадения», «Создание лайка от своего имени», «Обновление статуса своего совпадения», «Отмена своего скипа». Плюс триггеры `no_self_match`, `guard_support_flag` / `set_support_flag`.
- `messages`: чтение только по `status = 'matched'` и участию в паре; INSERT — от своего имени в подтверждённой паре и без блокировки; UPDATE ограничен колонкой `read_at`.
- `blocks`: «Свои блокировки» (FOR ALL, `blocker_id = auth.uid()`).
- `reports`: INSERT от своего имени; SELECT — автор **или тот, на кого пожаловались** (см. C7); админ видит все.
- `support_*`: владелец видит свои, админ — все; отправка в закрытый тикет запрещена.
- `telegram_identities`, `telegram_login_tokens`: RLS включён, политик нет → доступ только `service_role`. Это правильно.
- `e2ee_key_backups`: 4 политики, доступ только владельцу; проверка в миграции падает, если политик не 4.

Найденные дефекты — в разделах 3 (C1, C3, C7) и ниже.

### 2.3. Права на `profiles`, `matches`, `messages`

`profiles`:

- `SELECT` уровня таблицы отозван; выдан список колонок (`20261116000000:339-356`): `id`, `is_admin`, `moderation_status`, `moderation_note`, `created_at`, `updated_at`, `public_key`, флаги приватности. Содержимое анкеты — только через `profile_cards` / `my_profile()`.
- `UPDATE` уровня таблицы выдан намеренно (`20261116000001:19`), иначе не сохранялась бы анкета. Служебные поля закрывает триггер.
- **`INSERT` и `DELETE` не отозваны.** См. C1.

`matches`:

- `SELECT` — только свои пары.
- `INSERT` — `auth.uid() = user_a`; значение `status` не ограничено (C3).
- `UPDATE` — только `status`, `matched_at`; политика разрешает любому участнику пары.
- `DELETE` — только свой `rejected`-скип.

`messages`:

- `INSERT` — от своего имени, в `matched`-паре, без блокировки.
- `SELECT` — только участники `matched`-пары.
- `UPDATE` — только `read_at`, любой участник пары.
- `DELETE` — политики нет (и не нужно).

Проверить фактические гранты:

```sql
select c.relname, r.rolname, acl.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) acl
join pg_roles r on r.oid = acl.grantee
where n.nspname = 'public'
  and c.relname in ('profiles','matches','messages','blocks','reports',
                    'support_tickets','support_messages','report_attachments',
                    'push_tokens','e2ee_key_backups')
  and r.rolname in ('anon','authenticated')
order by c.relname, r.rolname, acl.privilege_type;
```

### 2.4. Функции `SECURITY DEFINER`

| Функция | Оценка |
|---|---|
| `private.is_admin()` | Корректно: `STABLE`, `search_path = ''`, читает только свою строку. `USAGE` на схему `private` выдан только `authenticated`. |
| `public.my_profile()` | Корректно: возвращает только `id = auth.uid()`, `EXECUTE` только `authenticated`. |
| `public.feed_profiles(...)` | Корректно: `search_path = ''`, исключает себя, блоки, невидимые и скрытые анкеты, маскирует поля. `EXECUTE` только `authenticated`. |
| `public.nearby_profiles(...)` | Работает, но `EXECUTE` остался у `PUBLIC`/`anon` (C11). |
| `public.my_location()` | То же: `EXECUTE` по умолчанию у `PUBLIC`; для `anon` вернёт пусто, но лучше закрыть. |
| `public.admin_user_emails()` | Корректно: проверяет `private.is_admin()`, `REVOKE` у `public`/`anon`, `GRANT` только `authenticated`. |
| `public.notify_new_message()` | Корректно: trigger-only, `search_path = ''`, передаёт только имя отправителя, не текст. |
| `public.set_support_flag()` | Корректно: ставит `is_support` только для пары с администратором. |
| `public.protect_profile_service_fields()` | Защищает только UPDATE (C1). |
| `public.stamp_terms_accepted()` | Ставит дату на INSERT, клиент не может подделать. |
| `public.check_profile_age()` | Проверяет 18–120 лет на INSERT и UPDATE `birth_date`. |
| `public.handle_new_user()` | `SECURITY DEFINER`, но `SET search_path TO 'public'` вместо `''`. Не критично (все объекты и так в `public`), но лучше привести к общему стилю. |

Вывод: критичных ошибок в `SECURITY DEFINER` нет; главная проблема — не функция, а незакрытый `INSERT` в `profiles`.

### 2.5. Права администратора и модераторов

- Роль одна — `profiles.is_admin`. Отдельной роли модератора нет.
- Админ видит все анкеты, жалобы, тикеты поддержки и сообщения поддержки; может править любую анкету.
- Админ **не** может читать обычную переписку: политика `messages` требует участия в паре. Это правильно и согласуется с E2EE.
- `is_admin` нельзя выдать себе через UPDATE — триггер блокирует. Но можно через DELETE + INSERT профиля (C1).
- У администратора нет MFA и нет журнала действий (audit log). Для возможности править любые анкеты и видеть email это существенный пробел.
- `prevent_admin_block` не даёт заблокировать администратора.
- `admin_user_emails()` отдаёт email всех пользователей только админу — корректно. Мелочь: после создания функции нет `NOTIFY pgrst, 'reload schema'`.

Рекомендация: добавить таблицу `admin_audit_log` (кто, что, когда изменил) и включить MFA для админского аккаунта.

### 2.6. Storage и доступ к фотографиям

| Бакет | Политика | Оценка |
|---|---|---|
| `avatars` | публичный (`public = true`), SELECT для `public`, INSERT/UPDATE/DELETE только своей папки `{uid}/` | C5: публичность обходит `show_photos`; файлы можно перечислять |
| `chat-images` | приватный, INSERT только участнику `matched`-пары, SELECT — участнику пары, файл содержит ciphertext | В целом корректно. Нет DELETE-политики: файлы не удаляются. SELECT не проверяет `status = 'matched'` (только участие) — низкий риск |
| `report-images` | приватный, но SELECT для **всех** авторизованных | C4: утечка всех вложений жалоб |

Дополнительно:

- Нет ограничений на размер и MIME загружаемых файлов на уровне политик — возможен абьюз хранилища.
- `Chat.tsx`/`AllUsers.tsx` отправляют фото жалоб не используют, но политика уже открыта.
- `chat-images`: расшифрованные файлы пишутся в `documentDirectory` (`chatImages.ts:107-109`) и не удаляются (C12).

### 2.7. Реализация E2EE

- Примитивы: X25519 + XSalsa20-Poly1305 (`tweetnacl`), nonce 24 байта на сообщение, формат `{v, nonce, ct}`.
- Текст: `encryptText` → `messages.content` (JSON-конверт). Plaintext в БД не пишется.
- Фото: `encryptBytes` → ciphertext в `chat-images`, конверт — в `content`; `image_path` указывает на ciphertext.
- Расшифровка: `decryptText` / `decryptBytes` только локально, ключ собеседника берётся из `profiles.public_key`.
- Подделка/повтор nonce маловероятны (24 случайных байта).
- Сервер видит только шифртекст; push-уведомление содержит имя отправителя и «Новое сообщение», без текста.

Ограничения модели (важно зафиксировать):

1. **Нет аутентификации ключей.** `public_key` не подписан и не привязан к истории. Сервер (или тот, кто получил `service_role`) может подменить ключ собеседника и читать новые сообщения, встав в середину. Без key transparency / подписей это неустранимо.
2. **Нет forward secrecy.** Статическая пара ключей: компрометация приватного ключа расшифровывает всю историю. Нет ratchet (Double Ratchet).
3. **Один ключ на аккаунт, не на устройство.** При смене устройства старые сообщения нечитаемы by design; при конфликте предлагается замена ключа.
4. Legacy-сообщения до E2EE могли остаться plaintext; политика `last_message_preview` для них сохраняет первые 80 символов в `matches`.

Для текущего продукта модель приемлема, но её нужно явно описать пользователю и в политике конфиденциальности.

### 2.8. Хранение и восстановление ключей

- Приватный ключ: `e2ee:privateKey:<userId>` в AsyncStorage (`e2ee.ts:60-72`).
- Резервная копия: `e2ee_key_backups`, шифрование `secretbox` ключом из PBKDF2-HMAC-SHA512, соль 16 байт, 50 000 итераций (`keyBackup.ts:39`).
- Производный ключ (KEK) кешируется в AsyncStorage (`keyBackup.ts:186-198`), чтобы досылать копию без пароля.
- Восстановление: `syncKeyBackup` при входе с паролем; при успехе ключ публикуется в профиль.
- После смены пароля копия перешифровывается (`ChangePassword.tsx:95`).
- После `resetIdentity` копия обновляется или удаляется (`keyBackup.ts:497-505`).
- RLS `e2ee_key_backups` — только владелец; админ не видит.

Замечания:

- AsyncStorage не шифрует данные. На Android это приватный каталог приложения, на iOS — тоже, но без Keychain. При бэкапе устройства/root приватный ключ и KEK утекают. Рекомендуется `expo-secure-store` для ключа и KEK (с fallback для web).
- 50 000 итераций PBKDF2-SHA512 ниже современных рекомендаций (OWASP: ~210 000 для SHA-512). Увеличить с версионированием параметров (в payload уже есть `iterations` — миграция возможна).
- Восстановление возможно только по паролю. Вход через Telegram (когда включат) не сможет восстановить копию; нужен отдельный пароль/фраза восстановления.

### 2.9. Отсутствие открытых сообщений в логах

Проверено:

- В `src/` нет `console.*` вне `log.ts`; релизный `log` пишет только `error`.
- Логи содержат тексты ошибок и идентификаторы, но не `content` сообщений.
- Push-текст: `title` — имя, `body` — «Новое сообщение», без переписки (`push_direct_pg_net.sql:52-66`).
- `matches.last_message_preview` для E2EE — «🔒 Сообщение» / «Фото», не ciphertext.
- В БД `messages.content` — только JSON-конверт.

Остаточные риски:

- Legacy plaintext-сообщения (если есть) читаемы сервером и могут попадать в preview.
- Postgres/PostgREST могут логировать текст ошибок; при нарушении CHECK в `messages` в лог может попасть `content` (ciphertext, не plaintext).
- `notify_new_message` кладёт в очередь pg_net `push_tokens` и имя; текста нет.

### 2.10. Резервное копирование базы

В репозитории нет:

- скриптов дампа/восстановления,
- описания RPO/RTO,
- проверки restore,
- настройки PITR.

Фактически всё зависит от тарифа Supabase (daily backups / PITR). Нужно:

1. Зафиксировать в документации: кто, как часто, куда делает бэкап.
2. Проверить восстановление на отдельном проекте (не только наличие бэкапа).
3. Помнить: бэкап БД содержит ciphertext переписки и `e2ee_key_backups`, но не содержит приватных ключей устройств. Восстановление БД не восстановит переписку без пароля пользователя.

### 2.11. Версионирование Edge-функций

В репозитории нет `supabase/functions/`, но клиент вызывает:

- `telegram-start`, `telegram-exchange` (`telegramAuth.ts`),
- `delete-account` (`Settings.tsx:94`).

Их код, проверка JWT, работа с `service_role` и удаление данных не проверяемы. Это разрыв в аудите и риск дрейфа. Рекомендуется добавить функции в репозиторий (или хотя бы их исходники и версии) и проверить, что `delete-account` требует валидный JWT и удаляет только своего пользователя.

---

## 3. Подробности по критичным находкам

### C1. Эскалация через INSERT/DELETE профиля

Цепочка:

1. `authenticated` имеет `DELETE` на `profiles` (грант по умолчанию Supabase) и политику «Удаление своей анкеты» (`baseline:987`).
2. `authenticated` имеет `INSERT` на `profiles` и политику «Создание своей анкеты» (`baseline:971`) с проверкой только `id = auth.uid()`.
3. Единственный триггер защиты служебных полей — `BEFORE UPDATE` (`lock_down_profiles.sql:167-170`).
4. Значит, можно выполнить:
   ```sql
   delete from profiles where id = auth.uid();
   insert into profiles (id, is_admin, moderation_status, display_name)
   values (auth.uid(), true, 'approved', 'x');
   ```
   и получить администратора с одобренной анкетой.

Даже без `is_admin` это обход модерации и подмена даты согласия.

Проверка (от имени обычного пользователя, в транзакции с ROLLBACK):

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '<uuid пользователя>', true);
delete from public.profiles where id = '<uuid пользователя>';
insert into public.profiles (id, is_admin, moderation_status)
values ('<uuid пользователя>', true, 'approved');
select id, is_admin, moderation_status from public.profiles where id = '<uuid пользователя>';
rollback;
```

Если обе строки проходят — дыра подтверждена.

Исправление — в разделе 4, пункт 1.

### C2. Согласия при регистрации не сохраняются

`SignUp.tsx:83-91` обновляет `profiles` полями:

- `terms_accepted_at` — существует, но защищён триггером от изменения (`terms_consent.sql:95`), поэтому UPDATE падает с `42501`;
- `terms_version`, `privacy_accepted_at`, `privacy_version`, `special_data_consent_at`, `special_data_consent_version` — **в миграциях таких колонок нет**. PostgREST вернёт `PGRST204`, и не сохранится вообще ничего, включая `birth_date`.

Ошибка только логируется (`SignUp.tsx:94`), пользователь её не видит.

Последствия:

- нет подтверждённого согласия на обработку специальных категорий данных;
- версии документов не зафиксированы;
- `birth_date` при регистрации не сохраняется (потом спрашивается в `ProfileSetup`);
- `terms_accepted_at` остаётся только датой, проставленной триггером при создании строки.

Это не «дыра доступа», но юридически значимый дефект. Исправление — в разделе 4, пункт 2.

### C3. Совпадение без взаимности

`matches` INSERT разрешает `status = 'matched'`:

- `baseline:964`: `WITH CHECK (auth.uid() = user_a)`;
- `lock_down_profiles.sql:206`: UPDATE разрешён на `status`, `matched_at` любому участнику пары.

Сценарий: пользователь A вставляет `(user_a = A, user_b = B, status = 'matched')`, затем вставляет сообщение в эту пару. Политика `messages` проверит только `status = 'matched'` и участие — то есть A получает возможность писать B без согласия B.

Это же поведение используется поддержкой (`support.ts` вставляет `status = 'matched'`), поэтому просто запретить `matched` нельзя — нужно разделить «лайк» и «обращение в поддержку» (например, RPC `like_profile()` / `open_support_chat()` с проверками внутри).

Минимальное ужесточение — разрешить `matched` при INSERT только если второй участник — администратор, а UPDATE `status = 'matched'` — только через RPC. Полное решение — вынести лайки в `SECURITY DEFINER`-функцию, которая проверяет reciprocity.

### C4. Все фото жалоб доступны всем авторизованным

`baseline:1009`:

```sql
CREATE POLICY "Пользователи могут видеть фото жа" ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'report-images');
```

Любой вошедший пользователь может скачать/перечислить все вложения жалоб. Политика «Просмотр фото своей жалобы» (`baseline:1014`) уже покрывает легитимные случаи (свой путь или вложение своей жалобы или админ). Широкую политику нужно удалить.

Примечание: клиент сейчас не загружает фото к жалобам, но политика уже активна.

### C5. Публичный бакет аватаров обходит `show_photos`

`20261112000000_storage_avatars_policies.sql`:

- `avatars.public = true` (`:20-22`);
- SELECT для `public` (`:54-59`).

Следствия:

- URL аватара работает без авторизации;
- через Storage API можно перечислить все объекты бакета (политика SELECT разрешает `bucket_id = 'avatars'`);
- `show_photos = false` скрывает только поле `photo_url` в `profile_cards`/`feed_profiles`, но не сам файл.

Если обещание «фото скрыты по умолчанию» должно выполняться, бакет нужно сделать приватным и выдавать signed URL через RPC, который проверяет `show_photos` и блокировки. Альтернатива — честно указать в политике конфиденциальности, что фото профиля публичны.

### C6. `moderation_note` виден всем

`20261116000000:339-356` выдаёт `authenticated` колонку `moderation_note` в прямом SELECT. Политика `profiles` разрешает читать одобренные строки, поэтому заметки модератора о любом пользователе доступны всем.

Исправление: отозвать колонку и отдавать заметку только себе через `my_profile()` (тогда `ModerationPending.tsx` нужно перевести на `my_profile()`), либо завести отдельную таблицу `moderation_notes` с админским доступом.

### C7. Жалоба видна тому, на кого жалуются

`baseline:929`:

```sql
USING ((auth.uid() = reporter_id) OR (auth.uid() = reported_id))
```

Пользователь видит жалобы на себя, включая `reporter_id`, категорию и описание. Это риск retaliation и утечка личности заявителя. Оставить только `reporter_id` и админа.

### C8. Новый пользователь не появляется в ленте

`handle_new_user()` (`baseline:35-54`) создаёт профиль со `moderation_status = 'pending'`. `feed_profiles` и `profile_cards` показывают только `approved`. Значит, без ручного одобрения новый пользователь в ленту не попадёт (и застрянет на `ModerationPending`).

Дополнительно: дефолт колонки испорчен:

```sql
moderation_status text DEFAULT '''approved''::text'::text
```

Это строка `'approved'` вместе с кавычками, она не проходит CHECK-ограничение. Сейчас не проявляется только потому, что `handle_new_user` задаёт значение явно. Любой INSERT без `moderation_status` упадёт.

Нужно решить продуктово:

- либо автоодобрение после заполнения анкеты (`moderation_status = 'approved'` при первом сохранении полной анкеты),
- либо оставить ручную модерацию и явно показывать очередь модератору.

В любом случае исправить дефолт на `'pending'`.

### C9. Ключи в AsyncStorage и слабый PBKDF2

- `e2ee.ts:60-72` — приватный ключ в AsyncStorage.
- `keyBackup.ts:186-198` — KEK (производный от пароля) в AsyncStorage.
- `keyBackup.ts:39` — 50 000 итераций.

Рекомендации:

1. Перевести хранение приватного ключа и KEK на `expo-secure-store` (Keychain/Keystore). На web — оставить fallback.
2. Поднять итерации до ≥210 000 с сохранением `iterations` в payload (уже есть) и ленивой миграцией при следующем входе.
3. Не кешировать KEK дольше сессии, если это возможно; либо шифровать его ключом из SecureStore.

### C10. Нет аутентификации ключей и forward secrecy

Сервер раздаёт `public_key` без подписи. Владелец `service_role` или взлом БД может подменить ключ и читать новые сообщения. Это ограничение архитектуры, а не баг реализации. Минимум — зафиксировать в модели угроз и документах; максимум — подписывать ключи и хранить цепочку смен.

### C11. `nearby_profiles()` доступна анонимам

Функция создана без `REVOKE ALL ... FROM PUBLIC`, поэтому `anon` может её вызвать и получить список UUID одобренных анкет с расстояниями. Для незалогиненного пользователя это лишняя утечка метаданных. Добавить:

```sql
revoke all on function public.nearby_profiles(double precision, double precision) from public, anon;
grant execute on function public.nearby_profiles(double precision, double precision) to authenticated;
-- то же для my_location()
```

### C12. Расшифрованные фото чата остаются на диске

`chatImages.ts:104-109` пишет plaintext в `documentDirectory` под именем из пути. Файлы не удаляются ни при выходе, ни при очистке истории. Рекомендуется использовать `cacheDirectory` и удалять файлы при закрытии чата/выходе, либо перезаписывать один временный файл.

### C13. Бэкапы БД

См. 2.10. Нужен документированный процесс и проверка restore.

### C14. Edge-функции вне репозитория

См. 2.11. `delete-account` — особенно чувствительная: она должна требовать JWT и удалять только `auth.uid()`. Без исходников это не проверить.

---

## 4. Предлагаемые исправления (SQL для ручного применения)

Ниже — минимальный пакет для критичных пунктов. Применять в SQL Editor после проверки на копии. Все блоки идемпотентны.

### 4.1. Закрыть INSERT/DELETE профиля и защитить служебные поля на INSERT

```sql
begin;

-- 1. Клиент не создаёт и не удаляет строку профиля: это делает
--    handle_new_user() и удаление аккаунта через service_role.
revoke insert, delete on public.profiles from anon, authenticated;

drop policy if exists "Создание своей анкеты" on public.profiles;
drop policy if exists "Удаление своей анкеты" on public.profiles;

-- 2. Защита служебных полей и на INSERT (defense in depth).
create or replace function public.protect_profile_service_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null and not private.is_admin() then
    if tg_op = 'INSERT' then
      new.is_admin := false;
      new.moderation_status := 'pending';
      new.moderation_note := null;
      new.terms_accepted_at := null;  -- проставит stamp_terms_accepted
    else
      if new.is_admin is distinct from old.is_admin
         or new.moderation_status is distinct from old.moderation_status
         or new.moderation_note is distinct from old.moderation_note
         or new.terms_accepted_at is distinct from old.terms_accepted_at then
        raise exception 'Служебные поля анкеты (модерация, права и согласие) изменяются только модератором'
          using errcode = '42501';
      end if;
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists protect_profile_service_fields on public.profiles;
create trigger protect_profile_service_fields
  before insert or update on public.profiles
  for each row execute function public.protect_profile_service_fields();

-- 3. Исправить испорченный дефолт.
alter table public.profiles alter column moderation_status set default 'pending';

notify pgrst, 'reload schema';
commit;
```

### 4.2. Убрать `moderation_note` из прямого SELECT

```sql
begin;
revoke select (moderation_note) on public.profiles from authenticated;
notify pgrst, 'reload schema';
commit;
```

После этого `ModerationPending.tsx` должен читать заметку через `my_profile()` (функция возвращает все колонки своей строки).

### 4.3. Закрыть `report-images` и `nearby_profiles`

```sql
begin;

drop policy if exists "Пользователи могут видеть фото жа" on storage.objects;

revoke all on function public.nearby_profiles(double precision, double precision) from public, anon;
grant execute on function public.nearby_profiles(double precision, double precision) to authenticated;

revoke all on function public.my_location() from public, anon;
grant execute on function public.my_location() to authenticated;

commit;
```

### 4.4. Жалобы: убрать доступ для `reported_id`

```sql
begin;
drop policy if exists "Просмотр жалоб" on public.reports;
create policy "Просмотр жалоб"
  on public.reports
  for select
  to authenticated
  using (auth.uid() = reporter_id or private.is_admin());
commit;
```

### 4.5. Согласия: отдельная таблица вместо колонок в `profiles`

```sql
begin;

create table if not exists public.user_consents (
  user_id     uuid not null references public.profiles(id) on delete cascade,
  document    text not null check (document in ('terms','privacy','special_data')),
  version     text not null,
  accepted_at timestamptz not null default now(),
  primary key (user_id, document, version)
);

alter table public.user_consents enable row level security;

revoke all on public.user_consents from anon, authenticated;
grant select, insert on public.user_consents to authenticated;

drop policy if exists "Свои согласия: чтение" on public.user_consents;
create policy "Свои согласия: чтение"
  on public.user_consents for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Свои согласия: создание" on public.user_consents;
create policy "Свои согласия: создание"
  on public.user_consents for insert to authenticated
  with check (auth.uid() = user_id);

-- Дату ставит база, клиент её не присылает. UPDATE/DELETE не выдаём.
create or replace function public.stamp_consent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.accepted_at := now();
  return new;
end;
$$;

drop trigger if exists stamp_consent on public.user_consents;
create trigger stamp_consent
  before insert on public.user_consents
  for each row execute function public.stamp_consent();

notify pgrst, 'reload schema';
commit;
```

Затем в `SignUp.tsx`:

- убрать `terms_accepted_at` и несуществующие колонки из UPDATE;
- после `signUp` вставить три строки в `user_consents` (или вызвать RPC, который сделает это атомарно);
- `birth_date` оставить в UPDATE, он не защищён.

### 4.6. Взаимность лайков (архитектурно)

Полное решение:

1. `REVOKE INSERT, UPDATE ON public.matches FROM authenticated;`
2. RPC `public.like_profile(target uuid)` `SECURITY DEFINER`:
   - проверяет, что `target` — одобренная, не скрытая, не заблокированная анкета;
   - ищет пару в любом направлении;
   - если пары нет — создаёт `pending`;
   - если пара `pending` и `user_a`/`user_b` — цель, ставит `matched`;
   - если пара `rejected` — ставит `pending`.
3. RPC `public.skip_profile(target uuid)` и `public.undo_skip(match_id uuid)`.
4. Отдельный RPC `public.open_support_chat()` для пары с администратором.

Это убирает возможность подделать `matched` и заодно упрощает клиент.

---

## 5. Чек-лист по заданию

| Пункт | Статус |
|---|---|
| Supabase Auth и сессии | Работает; включить подтверждение email, усилить пароль, MFA админу |
| RLS всех таблиц | Включён везде; есть дефекты C1, C3, C7 |
| Права `profiles` | C1 (INSERT/DELETE), C6 (`moderation_note`) |
| Права `matches` | C3 (взаимность) |
| Права `messages` | Корректно: чтение только matched, UPDATE только `read_at` |
| `SECURITY DEFINER` | Ошибок нет; закрыть `EXECUTE` у `nearby_profiles`/`my_location` |
| Права админа/модераторов | Работают; нет audit log и MFA |
| Storage и фото | C4, C5; нет DELETE для `chat-images` |
| E2EE | Корректная реализация; нет FS и аутентификации ключей |
| Хранение/восстановление ключей | Работает; AsyncStorage и 50k итераций |
| Отсутствие plaintext в логах | Подтверждено; legacy-plaintext и логи ошибок — остаточный риск |
| Резервное копирование БД | Не документировано, нет проверки restore |

---

## 6. Приоритетный порядок работ

1. C1 — закрыть INSERT/DELETE профиля (прямая эскалация до админа).
2. C2 — починить сохранение согласий (юридический риск, специальные категории данных).
3. C4 — закрыть `report-images`.
4. C5 — решить судьбу публичного бакета `avatars` (приватный + signed URL либо явное раскрытие в политике).
5. C3 — вынести лайки в RPC, запретить клиентский `matched`.
6. C6, C7 — убрать `moderation_note` и доступ `reported_id` к жалобам.
7. C8 — решить, автоодобрять ли новые анкеты; исправить дефолт.
8. C9, C10 — SecureStore, итерации PBKDF2, модель угроз E2EE.
9. C13, C14 — бэкапы и версионирование Edge-функций.

---

## 7. Статус применения (обновлено 13.11.2026)

Миграция `supabase/migrations/20261117000000_security_hardening.sql`, шаги
применяются вручную в SQL Editor. Каждый шаг — отдельная транзакция.

| Шаг | Содержание | Статус |
|---|---|---|
| 1 | `profiles`: отзыв INSERT, триггер на INSERT OR UPDATE, DEFAULT `pending` | применён |
| 2 | `user_consents` + RPC `accept_documents()` | применён |
| 3 | `reports`: только автор и админ | применён |
| 4 | Storage `report-images` | применён |
| 5 | `EXECUTE` на гео-функциях только `authenticated` | применён |
| 6 | `handle_new_user()`: `search_path = ''` | применён |
| 7 | `profiles`: снят табличный `SELECT` и чтение координат | применён |
| 8 | `profiles`: восстановлен колоночный белый список, `my_location()`, `nearby_profiles()` | применён |
| 9 | `moderation_note`: отзыв чтения | после установки 0.0.35 |
| 10 | `messages`/`matches`: колоночные права, `no_self_match`, чтение только `matched` | применён |

Отдельными миграциями:

| Файл | Содержание | Статус |
|---|---|---|
| `20261118000000_admin_profiles_rpc.sql` | `admin_profiles()` и `admin_profile_names()` — чтение анкет панелью модерации через `SECURITY DEFINER` с проверкой `private.is_admin()` | применён |
| `20261118000001_private_schema_grants.sql` | `USAGE` на схему `private` и `EXECUTE` на `private.is_admin()` для `authenticated` | применён |

E2EE-переписка проверена отдельно: `docs/compliance/e2ee-audit-2026-11-13.md`
(хранение ключей, восстановление, replay, смена ключа, уведомления, удаление
сообщений).

### Почему понадобились шаги 7–10 и 12

На рабочей базе обнаружены следы `ROLLBACK_20260926000000.sql`: он вернул
табличный `SELECT` на `profiles` (перекрывает колоночные гранты), снял
`my_location()`, вернул табличный `UPDATE` на `messages`/`matches`, удалил
триггер `no_self_match`, откатил политику чтения сообщений к версии без
проверки `status = 'matched'`, а также снял `USAGE` на схему `private`.
Шаги 7, 8, 10 и 12 восстанавливают задуманное состояние.

Симптомы, по которым это всплывало: `permission denied for column latitude`
при попытке отозвать координаты, `permission denied for table profiles` при
загрузке анкет в панели модерации, `permission denied for schema private`
при одобрении анкеты (триггер `protect_profile_service_fields` вызывает
`private.is_admin()` от имени пользователя).

Панель `addate_moderation` переведена на RPC `admin_profiles()` и
`admin_profile_names()`: возвращать табличный `SELECT` на `profiles` нельзя,
он отдаёт координаты и содержимое анкет всем авторизованным, а не только
администратору.

Клиентские правки, входящие в 0.0.35:

- `SignUp.tsx` — согласия через `accept_documents()` вместо несуществующих колонок;
- `ModerationPending.tsx` — статус модерации через `my_profile()`.

### Осталось вне SQL

- **`avatars`** — бакет публичный: при `show_photos = false` скрывается только
  ссылка в выдаче, файл остаётся доступен по прямой ссылке. Нужен приватный
  бакет с подписанными URL и миграция уже сохранённых ссылок.
- **E2EE** — ключ и пароль кешируются в `AsyncStorage`, PBKDF2 50 000 итераций,
  нет аутентификации ключей и forward secrecy.
- **Взаимность лайков** — `status = 'matched'` по-прежнему ставит клиент, нужен
  RPC.
- **Бэкапы и Edge-функции** — не документированы, исходников трёх функций нет
  в репозитории.
