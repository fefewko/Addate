// src/lib/callInvites.ts
//
// Глобальный приём приглашений на звонок.
//
// Раньше входящий звонок нигде не всплывал: вызываемый узнавал о нём, только
// если сам открывал CallScreen (а открыть его можно было лишь кнопкой
// «Позвонить», то есть как исходящий). Offer уходил в пустоту.
//
// Теперь вызывающий шлёт короткое приглашение в канал rtc-invite-<peerId>.
// Этот модуль подписан на rtc-invite-<myId> всё время, пока пользователь внутри
// приложения, и открывает CallScreen. Сам SDP по-прежнему идёт через канал
// конкретного звонка rtc-call-<callId> — после того как экран подписался.

import type { RealtimeChannel } from '@supabase/realtime-js';
import { supabase } from './supabase';
import { log } from './log';

export type IncomingCallInvite = {
  callId: string;
  matchId: string;
  from: string;
  fromName: string | null;
};

type InvitePayload = {
  kind?: string;
  callId?: string;
  matchId?: string;
  from?: string;
  to?: string;
  fromName?: string | null;
};

// Возвращает функцию отписки. Ошибки канала не фатальны: без приглашений
// приложение просто не узнает о входящем звонке, остальное продолжает работать.
export function listenForCallInvites(
  userId: string,
  onInvite: (invite: IncomingCallInvite) => void
): () => void {
  let channel: RealtimeChannel | null = supabase
    .channel(`rtc-invite-${userId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'invite' }, (payload: any) => {
      const msg = (payload?.payload ?? payload?.data ?? payload) as InvitePayload | null;
      if (!msg || msg.kind !== 'invite') return;
      if (msg.to !== userId || msg.from === userId) return;
      if (!msg.callId || !msg.matchId || !msg.from) return;

      log.debug('RTC-CALL: входящее приглашение', {
        callId: msg.callId,
        matchId: msg.matchId,
        from: msg.from,
      });
      onInvite({
        callId: msg.callId,
        matchId: msg.matchId,
        from: msg.from,
        fromName: msg.fromName ?? null,
      });
    })
    .subscribe((status: string) => {
      log.debug('RTC-CALL: канал приглашений', status);
    });

  return () => {
    if (channel) {
      const current = channel;
      channel = null;
      void supabase.removeChannel(current);
    }
  };
}
