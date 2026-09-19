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

export const SUBSTANCE_LABEL: Record<string, string> = {
  alcohol: 'Алкоголь',
  opioids: 'Опиоиды',
  stimulants: 'Стимуляторы',
  cannabis: 'Каннабис',
  other: 'Другое',
};

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
