ADdate — пространство для знакомств и общения людей, которые меняют свою жизнь и хотят встретить человека с похожими ценностями и опытом.

## Сборка

### Веб-версия (addate.ru/web)

```
npm install
npm run build:web
npm run serve:web
```

Подробности о выкладке на Cloudflare и о том, что на вебе работает, а что нет, — в [WEB_DEPLOY.md](WEB_DEPLOY.md).

### Android APK

Сборка APK локально, без облака EAS:

```
npm install
npm run build:apk
npm run verify:apk
```

## Проверки

```
npm run test:date   # расчёт возраста и разбор даты рождения
npm run build:web   # собирает веб-версию и проверяет результат
npm run verify:apk  # проверяет содержимое собранного APK
```
