// src/screens/CallScreen.tsx
//
// Экран голосового звонка E2EE между пользователями (task: «зашифрованные
// звонки между пользователями напрямую через приложение»).
//
// Поток:
//   - исходящий (outgoing): вызывающий нажимает кнопку в чате → CallScreen
//     запускает EncryptedCall.start(): подписка на канал звонка → приглашение
//     собеседнику → ожидание ready → offer → answer → active.
//   - входящий (incoming): приглашение приходит глобально (App.tsx) → CallScreen
//     подписывается на канал звонка и отправляет ready → получает offer →
//     предлагает принять/отклонить; после «принять» уходит answer.
//
// После успешного соединения (WebRTC connected) медиа идёт напрямую P2P,
// шифрование — WebRTC DTLS-SRTP; сервер в контуре не участвует.
//
// На экране есть журнал диагностики: в релизной сборке console.log отключён,
// поэтому без него на устройстве не видно, на каком шаге рвётся соединение.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRoute, useNavigation } from '@react-navigation/native';
import { colors } from '../lib/theme';
import { supabase } from '../lib/supabase';
import { createEncryptedCall, type CallState, type EncryptedCall } from '../lib/rtcCall';
import { errorMessage, log } from '../lib/log';
import type { RootNavigation } from '../lib/navigation';

type CallRouteParams = {
  matchId: string;
  peerId?: string;
  peerName?: string | null;
  callId?: string;
  outgoing?: boolean;
};

function formatDuration(startedAtMs: number | null): string {
  if (!startedAtMs) return '00:00';
  const diff = Math.max(0, Date.now() - startedAtMs);
  const total = Math.floor(diff / 1000);
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = Math.floor(total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function CallScreen() {
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<any>();
  const params = (route.params ?? {}) as CallRouteParams;

  const [state, setState] = useState<CallState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [muted, setMuted] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [, forceTick] = useState(0);

  const callRef = useRef<EncryptedCall | null>(null);
  const logScrollRef = useRef<ScrollView | null>(null);

  useEffect(() => {
    let cancelled = false;
    let call: EncryptedCall | null = null;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const myId = user?.id ?? '';
      if (!myId) {
        if (!cancelled) {
          setError('Не удалось определить пользователя для звонка.');
          setState('failed');
        }
        return;
      }
      if (!params.matchId) {
        if (!cancelled) {
          setError('Не удалось определить диалог для звонка.');
          setState('failed');
        }
        return;
      }
      if (cancelled) return;

      call = createEncryptedCall({
        matchId: params.matchId,
        peerId: params.peerId ?? '',
        peerName: params.peerName ?? null,
        callId: params.callId,
        myId,
      });
      callRef.current = call;

      call.setHandlers({
        onStateChange: (next) => {
          if (cancelled) return;
          setState(next);
          if (next === 'active') setConnectedAt((prev) => prev ?? Date.now());
        },
        onError: (msg) => {
          if (cancelled) return;
          setError(msg);
        },
        onConnected: () => {
          log.debug('RTC-CALL: соединение установлено');
        },
        onLog: (line) => {
          if (cancelled) return;
          setLogs((prev) => {
            const next = [...prev, line];
            return next.length > 120 ? next.slice(next.length - 120) : next;
          });
        },
      });

      if (!params.outgoing) {
        // Входящий: подписываемся на канал звонка и только после успешной
        // подписки подтверждаем готовность. Вызывающий ждёт ready и лишь затем
        // отправляет offer — иначе broadcast потеряется.
        try {
          const ok = await call.ensureChannel();
          if (ok) await call.notifyReady();
        } catch (e) {
          if (!cancelled) {
            setError('Не удалось принять приглашение: ' + errorMessage(e));
            setState('failed');
          }
        }
        return;
      }

      try {
        await call.start();
      } catch (e) {
        if (!cancelled) {
          setError('Не удалось установить соединение: ' + errorMessage(e));
          setState('failed');
        }
      }
    })();

    return () => {
      cancelled = true;
      void call?.endCall();
      callRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.matchId, params.peerId, params.peerName, params.callId, params.outgoing]);

  useEffect(() => {
    if (state !== 'active') return;
    // Тик раз в секунду: formatDuration считает от connectedAt и Date.now(),
    // поэтому достаточно перерисовать компонент.
    const timer = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  const hangup = async () => {
    const call = callRef.current;
    if (!call) return;
    await call.endCall();
  };

  const accept = async () => {
    const call = callRef.current;
    if (!call) return;
    try {
      await call.accept();
    } catch (e) {
      setError('Не удалось принять звонок: ' + errorMessage(e));
      setState('failed');
    }
  };

  const decline = async () => {
    const call = callRef.current;
    if (!call) return;
    await call.decline();
  };

  const toggleMute = () => {
    const call = callRef.current;
    if (!call) return;
    const next = !call.muted;
    call.setMuted(next);
    setMuted(next);
  };

  const titleForState = (): string => {
    switch (state) {
      case 'outgoing':
        return 'Вызов…';
      case 'incoming':
        return 'Входящий звонок';
      case 'connecting':
        return 'Соединение…';
      case 'active':
        return 'Звонок';
      case 'ended':
        return 'Звонок завершён';
      case 'failed':
        return 'Сбой соединения';
      default:
        return 'Звонок';
    }
  };

  const inProgress = state === 'outgoing' || state === 'connecting' || state === 'active';

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.peerName}>{params.peerName || 'Собеседник'}</Text>
        <Text style={styles.stateText}>{titleForState()}</Text>

        {(state === 'outgoing' || state === 'connecting') && (
          <ActivityIndicator size="large" color={colors.accent} />
        )}
        {state === 'failed' && <Text style={styles.errorText}>{error || 'Не удалось установить соединение.'}</Text>}

        {state === 'active' && <Text style={styles.timer}>{formatDuration(connectedAt)}</Text>}

        <View style={styles.actions}>
          {inProgress && (
            <TouchableOpacity style={styles.endButton} onPress={() => void hangup()} accessibilityRole="button">
              <Ionicons name="call" size={30} color={colors.danger} />
            </TouchableOpacity>
          )}

          {state === 'incoming' && (
            <>
              <TouchableOpacity style={styles.actionButton} onPress={() => void decline()} accessibilityRole="button">
                <Ionicons name="close" size={30} color={colors.white} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={() => void accept()} accessibilityRole="button">
                <Ionicons name="checkmark" size={30} color={colors.white} />
              </TouchableOpacity>
            </>
          )}

          {(state === 'ended' || state === 'failed') && (
            <TouchableOpacity
              style={styles.closeButton}
              onPress={() => navigation.goBack()}
              accessibilityRole="button"
            >
              <Text style={styles.closeButtonText}>Закрыть</Text>
            </TouchableOpacity>
          )}
        </View>

        {(state === 'active' || state === 'connecting') && (
          <TouchableOpacity style={styles.muteButton} onPress={toggleMute} accessibilityRole="button">
            <Ionicons name={muted ? 'mic-off-outline' : 'mic-outline'} size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.logPanel}>
        <Text style={styles.logTitle}>Диагностика соединения</Text>
        <ScrollView
          ref={logScrollRef}
          style={styles.logScroll}
          onContentSizeChange={() => logScrollRef.current?.scrollToEnd({ animated: false })}
        >
          {logs.length === 0 ? (
            <Text style={styles.logLine}>Ожидание событий…</Text>
          ) : (
            logs.map((line, index) => (
              <Text key={`${index}-${line.slice(0, 24)}`} style={styles.logLine}>
                {line}
              </Text>
            ))
          )}
        </ScrollView>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  peerName: { fontSize: 22, fontWeight: '600', color: colors.textPrimary, marginBottom: 8 },
  stateText: { fontSize: 16, color: colors.textSecondary, marginBottom: 20 },
  timer: { fontSize: 56, fontWeight: '600', color: colors.textPrimary, fontVariant: ['tabular-nums'] },
  errorText: { fontSize: 14, color: colors.danger, textAlign: 'center', marginBottom: 20 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 30 },
  endButton: { padding: 18, borderRadius: 40, backgroundColor: 'rgba(255,59,48,0.12)' },
  actionButton: { padding: 18, borderRadius: 40, backgroundColor: colors.surface, marginHorizontal: 12 },
  closeButton: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 24,
    backgroundColor: colors.surface,
  },
  closeButtonText: { color: colors.textPrimary, fontSize: 16, fontWeight: '600' },
  muteButton: { marginTop: 40, padding: 12 },
  logPanel: {
    maxHeight: 220,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  logTitle: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 4 },
  logScroll: { maxHeight: 180 },
  logLine: {
    color: colors.textSecondary,
    fontSize: 11,
    fontFamily: 'monospace',
    marginBottom: 1,
  },
});
