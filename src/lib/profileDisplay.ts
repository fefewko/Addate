// src/lib/profileDisplay.ts
// Общие константы и функции для отображения анкет — раньше были продублированы
// в Feed.tsx, AllUsers.tsx, ProfileDetail.tsx, ChatList.tsx по отдельности,
// из-за чего в разных местах приложения одни и те же статусы подписывались
// по-разному ("Трезв(а)" в одном экране, "В чистоте" в другом и т.п.).

export type SobrietyStatus = 'trezv' | 'v_sryve' | 'ne_ukazano';

export const SOBRIETY_LABEL: Record<SobrietyStatus, string> = {
  trezv: 'В чистоте',
  v_sryve: 'Нужна помощь',
  ne_ukazano: 'Не скажу',
};

// Варианты выбора для форм. Раньше этот список был продублирован в
// Profile.tsx, ProfileSetup.tsx и AllUsers.tsx, поэтому любая правка
// формулировки или добавление пункта требовали синхронных изменений
// в трёх местах.
export const SOBRIETY_OPTIONS: { value: SobrietyStatus; label: string }[] = (
  Object.keys(SOBRIETY_LABEL) as SobrietyStatus[]
).map((value) => ({ value, label: SOBRIETY_LABEL[value] }));

export const SUBSTANCE_LABEL: Record<string, string> = {
  alcohol: 'Алкоголь',
  opioids: 'Опиоиды',
  stimulants: 'Стимуляторы',
  cannabis: 'Каннабис',
  other: 'Другое',
};

export const SUBSTANCE_OPTIONS: { value: string; label: string }[] = Object.entries(SUBSTANCE_LABEL).map(
  ([value, label]) => ({ value, label })
);

const ONLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 минуты — с запасом от heartbeat раз в 45с

export function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

export function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

export function formatDistance(km: number | undefined): string | null {
  if (km === undefined) return null;
  if (km < 1) return 'Меньше 1 км от вас';
  return `~${Math.round(km)} км от вас`;
}

// Последняя активность приходит с сервера уже с учётом настройки приватности:
// если пользователь её скрыл, поля просто нет. Здесь только переводим
// timestamp в понятную подпись.
export function formatLastActive(value: string | null): string | null {
  if (!value) return null;

  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;

  const diff = Date.now() - time;
  if (diff < 0) return 'только что';
  if (diff < 60_000) return 'только что';

  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;

  const days = Math.floor(hours / 24);
  if (days === 1) return 'вчера';
  if (days < 30) return `${days} дн назад`;

  return new Date(value).toLocaleDateString('ru-RU');
}

// Дата без времени — для даты начала трезвости.
export function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString('ru-RU');
}
