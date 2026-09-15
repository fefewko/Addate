// src/screens/ChatList.tsx
import React, { useCallback, useState } from 'react';
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
  user_a_profile: { display_name: string | null; photo_url: string | null } | null;
  user_b_profile: { display_name: string | null; photo_url: string | null } | null;
};

type MatchItem = {
  matchId: string;
  otherUserId: string;
  otherName: string;
  otherPhoto: string | null;
  matchedAt: string | null;
};

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
         user_a_profile:profiles!matches_user_a_fkey (display_name, photo_url),
         user_b_profile:profiles!matches_user_b_fkey (display_name, photo_url)`
      )
      .eq('status', 'matched')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`)
      .order('matched_at', { ascending: false });

    setLoading(false);

    if (error) {
      console.warn('Ошибка загрузки совпадений:', error.message);
      return;
    }

    const mapped: MatchItem[] = ((data as unknown as MatchRow[]) || []).map((m) => {
      const iAmUserA = m.user_a === user.id;
      const otherProfile = iAmUserA ? m.user_b_profile : m.user_a_profile;
      return {
        matchId: m.id,
        otherUserId: iAmUserA ? m.user_b : m.user_a,
        otherName: otherProfile?.display_name || 'Без имени',
        otherPhoto: otherProfile?.photo_url || null,
        matchedAt: m.matched_at,
      };
    });

    setItems(mapped);
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMatches();
    }, [loadMatches])
  );

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
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
            <Text style={styles.name}>{item.otherName}</Text>
            <Text style={styles.hint}>Нажмите, чтобы открыть переписку</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#fff' },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8 },
  emptyBody: { fontSize: 14, color: '#666', textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  avatar: { width: 52, height: 52, borderRadius: 26, marginRight: 12, backgroundColor: '#f0f0f0' },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { fontSize: 18, fontWeight: '600', color: '#999' },
  rowBody: { flex: 1 },
  name: { fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 13, color: '#999', marginTop: 2 },
});
