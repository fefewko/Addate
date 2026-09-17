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

type MatchRow = {
  id: string;
  user_a: string;
  user_b: string;
  matched_at: string | null;
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
  hasUnread: boolean;
};

function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

export default function ChatList() {
  const navigation = useNavigation<any>();
  const [items, setItems] = useState<MatchItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadMatches = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('matches')
      .select(
        `id, user_a, user_b, matched_at,
         user_a_profile:profiles!matches_user_a_fkey (display_name, photo_url, birth_date),
         user_b_profile:profiles!matches_user_b_fkey (display_name, photo_url, birth_date)`
      )
      .eq('status', 'matched')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
      .order('matched_at', { ascending: false });

    if (error) {
      setLoading(false);
      console.warn('Ошибка загрузки совпадений:', error.message);
      return;
    }

    const rows = (data as unknown as MatchRow[]) || [];

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
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
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
            <Text style={styles.name}>
              {item.otherName}
              {item.otherAge ? `, ${item.otherAge}` : ''}
            </Text>
            <Text style={styles.hint}>
              {item.hasUnread ? 'Новое сообщение' : 'Нажмите, чтобы открыть переписку'}
            </Text>
          </View>
          {item.hasUnread && <View style={styles.unreadDot} />}
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#121212' },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: '#f0f0f0' },
  emptyBody: { fontSize: 14, color: '#a0a0a5', textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  avatar: { width: 52, height: 52, borderRadius: 26, marginRight: 12, backgroundColor: '#2a2a2a' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { fontSize: 18, fontWeight: '600', color: '#9a9a9e' },
  rowBody: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600', color: '#f0f0f0' },
  hint: { fontSize: 13, color: '#9a9a9e', marginTop: 2 },
  unreadDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: '#3b82f6', marginLeft: 8 },
});
