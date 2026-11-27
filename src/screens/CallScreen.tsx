// src/screens/CallScreen.tsx
//
// Экран голосового звонка E2EE между пользователями (task: «зашифрованные
// звонки между пользователями напрямым через приложение»).
//
// Поток:
//   - исходящий (outgoing): вызывающий нажимает кнопку в чате → CallScreen
//     запускает EncryptedCall.start() → offer → answer → active.
//   - входящий (incoming): вызываемый получает offer → startIncoming() →
//     answer → active; UI предлагает принять/отклонить.
//
// После успешного соединения (WebRTC connected) медиа идёт напрямую P2P,
// шифрование — WebRTC DTLS-SRTP; сервер в контуре не участвует.

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
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
  const [seconds, setSeconds] = useState(0);

  const callRef = useRef<EncryptedCall | null>(null);

  useEffect(() => {
    let cancelled = false;
    let call: EncryptedCall | null = null;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const myId = user?.id ?? '';
      if (!myId) {
        setError('Не удалось определить пользователя для звонка.');
        return;
      }
      if (cancelled) return;

      call = createEncryptedCall({ matchId: params.matchId, peerId: params.peerId ?? '', peerName: params.peerName ?? null, myId });
      callRef.current = call;

      call.setHandlers({
        onStateChange: (next) => {
          if (cancelled) return;
          setState(next);
          if (next === 'active') setConnectedAt(Date.now());
        },
        onError: (msg) => {
          if (cancelled) return;
          setError(msg);
        },
        onConnected: () => {
          log.debug('RTC-CALL: соединение установлено');
        },
      });

      if (params.outgoing) {
        try {
          await call.start();
        } catch (e) {
          if (!cancelled) {
            setError('Не удалось установить соединение: ' + errorMessage(e));
            setState('failed');
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      void call?.endCall();
      callRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.matchId, params.peerId, params.peerName, params.outgoing]);

  useEffect(() => {
    if (state !== 'active') return;
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [state]);

  const hangup = async () => {
    const call = callRef.current;
    if (!call) return;
    await call.endCall();
  };

  const decline = async () => {
    const call = callRef.current;
    if (!call) return;
    await call.decline();
  };

  const toggleMute = () => {
    const call = callRef.current;
    if (!call) return;
    call.setMuted(!call.muted);
  };

  const titleForState = (): string => {
    switch (state) {
      case 'outgoing':
        return 'Вызов…';
      case 'incoming':
        return 'Звонок…';
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

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        <Text style={styles.peerName}>{params.peerName || 'Собеседник'}</Text>
        <Text style={styles.stateText}>{titleForState()}</Text>

        {state === 'outgoing' && <ActivityIndicator size="large" color={colors.accent} />}
        {state === 'failed' && <Text style={styles.errorText}>{error || 'Не удалось установить соединение.'}</Text>}

        {state === 'active' && <Text style={styles.timer}>{formatDuration(connectedAt)}</Text>}

        <View style={styles.actions}>
          {(state === 'active' || state === 'outgoing') && (
            <TouchableOpacity style={styles.endButton} onPress={() => void hangup()} accessibilityRole="button">
              <Ionicons name="call" size={30} color={colors.danger} />
            </TouchableOpacity>
          )}

          {state === 'incoming' && (
            <>
              <TouchableOpacity style={styles.actionButton} onPress={() => void decline()} accessibilityRole="button">
                <Ionicons name="close" size={30} color={colors.white} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.actionButton} onPress={() => void hangup()} accessibilityRole="button">
                <Ionicons name="checkmark" size={30} color={colors.white} />
              </TouchableOpacity>
            </>
          )}
        </View>

        {state === 'active' && (
          <TouchableOpacity style={styles.muteButton} onPress={toggleMute} accessibilityRole="button">
            <Ionicons name={callRef.current?.muted ? 'mic-off-outline' : 'mic-outline'} size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        )}
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
  actionButton: { padding: 18, borderRadius: 40, backgroundColor: colors.surface },
  muteButton: { marginTop: 40, padding: 12 },
});
