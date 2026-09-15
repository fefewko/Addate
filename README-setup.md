# Как собрать проект из этих файлов

## 1. Создай каркас Expo-проекта

В PowerShell:

```
cd C:\ADDate
npx create-expo-app@latest . --template default@sdk-57
```

Если появится ошибка про непустую папку — значит в ней уже есть `.git`, `README.md` и т.п. из GitHub. Это нормально, попробуй ещё раз с флагом:

```
npx create-expo-app@latest . --template default@sdk-57 --yes
```

Если и это не поможет — создай во временной папке и перенеси файлы:

```
cd C:\
npx create-expo-app@latest ADDate-temp --template default@sdk-57
robocopy C:\ADDate-temp C:\ADDate /E
rmdir /S /Q C:\ADDate-temp
```

## 2. Замени файлы на файлы из этого архива

Распакуй этот zip и скопируй его содержимое **поверх** только что созданного проекта в `C:\ADDate`, подтвердив замену `App.tsx`.

## 3. Установи дополнительные зависимости

Из папки `C:\ADDate`:

```
npx expo install @supabase/supabase-js react-native-url-polyfill @react-native-async-storage/async-storage @react-navigation/native @react-navigation/native-stack @react-navigation/bottom-tabs react-native-screens react-native-safe-area-context expo-image-picker
```

## 4. Проверь .env

Файл `.env` уже заполнен реальными данными твоего Supabase-проекта (URL и анонимный ключ) — ничего менять не нужно. Этот ключ безопасно коммитить в Git: доступ к данным всё равно ограничен политиками RLS, которые мы настроили в базе, а не секретностью ключа.

## 5. Запусти проект

```
npx expo start
```

Отсканируй QR-код приложением **Expo Go** на Android-телефоне — так можно проверить всё быстро, без сборки `.apk`.

## 6. Дальше — сборка

Когда проверишь, что всё работает через Expo Go, выполни `eas build:configure` — теперь он сработает, так как папка стала настоящим Expo-проектом. Затем запушь изменения на GitHub и подключи репозиторий в дашборде expo.dev (Settings → GitHub), как договаривались раньше.
