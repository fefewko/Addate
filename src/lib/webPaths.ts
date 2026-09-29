// src/lib/webPaths.ts
//
// Чистые функции для адресов веб-версии.
//
// Отдельный файл не из-за красоты, а из-за тестируемости: webLinks.ts тянет
// react-native и @react-navigation, которые в node не запускаются, поэтому
// логику путей нельзя было бы проверить по-настоящему — пришлось бы
// переписывать её в тесте, а такая копия расходится с оригиналом при первом
// же исправлении.

export const WEB_BASE_PATH = '/web';

// Направление «состояние -> адрес». Путь приходит в разной форме: с ведущим
// слешем, без него, с хвостовым ('/chats/'), или вовсе пустым. Приводится к
// одному виду, иначе приклеивание префикса давало '/web//chats'.
//
// Результат всегда абсолютный и всегда с префиксом. Это не косметика: без
// ведущего слеша браузер разрешает адрес относительно текущего, и из
// '/web/profile/<id>' переход на 'chats' дал бы '/web/profile/chats'.
export function buildWebPath(path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return clean ? `${WEB_BASE_PATH}/${clean}` : WEB_BASE_PATH;
}

// Направление «адрес -> путь для разбора». Убирает префикс, иначе разбор
// '/web/feed' ничего не находит и приложение остаётся на экране входа.
// Повторные слеши схлопываются по той же причине, что и в buildWebPath.
export function stripWebBase(path: string): string {
  const withoutPrefix = path.startsWith(WEB_BASE_PATH) ? path.slice(WEB_BASE_PATH.length) : path;
  return `/${withoutPrefix}`.replace(/\/{2,}/g, '/');
}
