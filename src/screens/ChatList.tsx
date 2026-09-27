// src/screens/ChatList.tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import LoadError from '../ui/LoadError';
import { calcAge } from '../lib/profileDisplay';
import { colors } from '../lib/theme';

type MatchRow = {
  id: string;
  user_a: string;
  user_b: string;
  matched_at: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  user_a_profile: { display_name: string | null; photo_url: string | null; birth_date: string | null } | null;
  user_b_profile: { display_name: string | null; photo_url: string | null; birth_date: string | null } | null;
};

type MatchItem = {
  matchId: string;
  otherUserId: string;
  otherName: string;
  otherAge: number | null;
  otherPhoto: string | null;
  matchedAt: string | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  hasUnread: boolean;
};

// «5 мин», «2 ч», «3 дн» — для времени последнего сообщения в списке диалогов.
function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'сейчас';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} дн`;
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export default function ChatList() {
  const navigation = useNavigation<any>();
  const [items, setItems] = useState<MatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadMatches = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (!user) {
      setLoading(false);
      setLoadError(authError?.message || 'Не удалось проверить сессию.');
      return;
    }

    const { data, error } = await supabase
      .from('matches')
      .select(
        `id, user_a, user_b, matched_at, last_message_at, last_message_preview,
         user_a_profile:profiles!matches_user_a_fkey (display_name, photo_url, birth_date),
         user_b_profile:profiles!matches_user_b_fkey (display_name, photo_url, birth_date)`
      )
      .eq('status', 'matched')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
      // Порядок диалогов задаёт свежесть переписки, а не дата совпадения.
      // Раньше сортировали по matched_at, и чат с сегодняшним сообщением
      // оказывался ниже чата, который зародился месяц назад и давно молчит.
      // Сортировку делает база: клиенту тянуть всю переписку ради порядка
      // было бы слишком дорого, поэтому последнее сообщение держится
      // в matches триггером (миграция 20260926000006).
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .order('matched_at', { ascending: false });

    if (error) {
      setLoading(false);
      setLoadError('Не удалось загрузить диалоги: ' + error.message);
      console.warn('Ошибка загрузки совпадений:', error.message);
      return;
    }

    // Заблокированные (в любую сторону) не должны оставаться видимыми в списке
    // диалогов, даже если совпадение когда-то было подтверждено.
    const { data: blocksData } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

    const blockedIds = new Set<string>();
    (blocksData || []).forEach((b) => {
      blockedIds.add(b.blocker_id === user.id ? b.blocked_id : b.blocker_id);
    });

    const rows = ((data as unknown as MatchRow[]) || []).filter((m) => {
      const otherId = m.user_a === user.id ? m.user_b : m.user_a;
      return !blockedIds.has(otherId);
    });

    // Непрочитанные сообщения по каждому совпадению — одним запросом,
    // затем раскладываем по match_id на клиенте.
    const { data: unreadRows } = await supabase
      .from('messages')
      .select('match_id')
      .is('read_at', null)
      .neq('sender_id', user.id);

    const unreadMatchIds = new Set((unreadRows || []).map((m) => m.match_id));

    const mapped: MatchItem[] = rows.map((m) => {
      const iAmUserA = m.user_a === user.id;
      const otherProfile = iAmUserA ? m.user_b_profile : m.user_a_profile;
      return {
        matchId: m.id,
        otherUserId: iAmUserA ? m.user_b : m.user_a,
        otherName: otherProfile?.display_name || 'Без имени',
        otherAge: calcAge(otherProfile?.birth_date ?? null),
        otherPhoto: otherProfile?.photo_url || null,
        matchedAt: m.matched_at,
        lastMessageAt: m.last_message_at,
        lastMessagePreview: m.last_message_preview,
        hasUnread: unreadMatchIds.has(m.id),
      };
    });

    setLoading(false);
    setItems(mapped);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMatches();
    }, [loadMatches])
  );

  // Пока экран открыт, обновляем список сразу при новом сообщении или
  // отметке "прочитано" — иначе не увидим новое сообщение, не выходя с экрана.
  useEffect(() => {
    const channel = supabase
      .channel('chatlist-messages-watcher')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, () => {
        loadMatches();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [loadMatches]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (loadError) {
    return <LoadError message={loadError} onRetry={loadMatches} />;
  }

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Пока нет совпадений</Text>
        <Text style={styles.emptyBody}>
          Когда вы понравитесь друг другу взаимно, переписка появится здесь.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {items.map((item) => (
        <TouchableOpacity
          key={item.matchId}
          style={styles.row}
          onPress={() =>
            navigation.navigate('Chat', {
              matchId: item.matchId,
              otherUserId: item.otherUserId,
              otherName: item.otherName,
              otherAge: item.otherAge,
            })
          }
        >
          {item.otherPhoto ? (
            <Image source={{ uri: item.otherPhoto }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarPlaceholderText}>
                {item.otherName.charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.rowBody}>
            <View style={styles.rowTop}>
              <Text style={styles.name} numberOfLines={1}>
                {item.otherName}
                {item.otherAge ? `, ${item.otherAge}` : ''}
              </Text>
              {item.lastMessageAt && <Text style={styles.time}>{timeAgo(item.lastMessageAt)}</Text>}
            </View>
            <Text
              style={[styles.hint, item.hasUnread && styles.hintUnread]}
              numberOfLines={1}
            >
              {item.lastMessagePreview || 'Переписка ещё не началась'}
            </Text>
          </View>
          {item.hasUnread && <View style={styles.unreadDot} />}
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.bg },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  avatar: { width: 52, height: 52, borderRadius: 26, marginRight: 12, backgroundColor: colors.border },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { fontSize: 18, fontWeight: '600', color: colors.textMuted },
  rowBody: { flex: 1 },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  name: { fontSize: 16, fontWeight: '600', color: colors.textPrimary, flexShrink: 1 },
  time: { fontSize: 12, color: colors.textFaint },
  hint: { fontSize: 13, color: colors.textMuted, marginTop: 2 },
  hintUnread: { color: colors.textPrimary, fontWeight: '600' },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginLeft: 8 },
});
