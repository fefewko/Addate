// src/screens/IncomingLikes.tsx
import React, { useCallback, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { supabase } from '../lib/supabase';
import LoadError from '../ui/LoadError';
import { likeProfile } from '../lib/matches';
import { colors } from '../lib/theme';
import { SOBRIETY_LABEL, SobrietyStatus, calcAge } from '../lib/profileDisplay';

type IncomingLike = {
  matchId: string;
  userId: string;
  displayName: string | null;
  birthDate: string | null;
  city: string | null;
  bio: string | null;
  sobrietyStatus: SobrietyStatus;
  photoUrl: string | null;
};

export default function IncomingLikes() {
  const navigation = useNavigation<any>();
  const [items, setItems] = useState<IncomingLike[]>([]);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
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
    setMyId(user.id);

    const { data: blocksData } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

    const blockedIds = new Set<string>();
    (blocksData || []).forEach((b) => {
      blockedIds.add(b.blocker_id === user.id ? b.blocked_id : b.blocker_id);
    });

    const { data, error } = await supabase
      .from('matches')
      .select(
        `id, user_a,
         profile:profiles!matches_user_a_fkey (display_name, birth_date, city, bio, sobriety_status, photo_url)`
      )
      .eq('user_b', user.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    setLoading(false);

    if (error) {
      setLoadError('Не удалось загрузить лайки: ' + error.message);
      console.warn('Ошибка загрузки лайков:', error.message);
      return;
    }

    const mapped: IncomingLike[] = ((data as any[]) || [])
      .filter((m) => !blockedIds.has(m.user_a))
      .map((m) => ({
        matchId: m.id,
        userId: m.user_a,
        displayName: m.profile?.display_name ?? null,
        birthDate: m.profile?.birth_date ?? null,
        city: m.profile?.city ?? null,
        bio: m.profile?.bio ?? null,
        sobrietyStatus: m.profile?.sobriety_status ?? 'ne_ukazano',
        photoUrl: m.profile?.photo_url ?? null,
      }));

    setItems(mapped);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function handleLikeBack(item: IncomingLike) {
    if (!myId) return;
    setBusyId(item.userId);

    const result = await likeProfile(myId, item.userId);
    setItems((prev) => prev.filter((i) => i.matchId !== item.matchId));
    setBusyId(null);

    if (result.matched) {
      const age = calcAge(item.birthDate);
      Alert.alert('Это совпадение! 🎉', `Вы с ${item.displayName || 'этим человеком'} понравились друг другу.`, [
        {
          text: 'Написать сообщение',
          onPress: () =>
            navigation.navigate('Chat', {
              matchId: result.matchId,
              otherUserId: item.userId,
              otherName: item.displayName,
              otherAge: age,
            }),
        },
        { text: 'Продолжить', style: 'cancel' },
      ]);
    }
  }

  async function handleSkip(item: IncomingLike) {
    setBusyId(item.userId);
    await supabase.from('matches').update({ status: 'rejected' }).eq('id', item.matchId);
    setItems((prev) => prev.filter((i) => i.matchId !== item.matchId));
    setBusyId(null);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (loadError) {
    return <LoadError message={loadError} onRetry={load} />;
  }

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Пока никто не лайкнул</Text>
        <Text style={styles.emptyBody}>Как только кто-то отметит вашу анкету — она появится здесь.</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {items.map((item) => {
        const age = calcAge(item.birthDate);
        const busy = busyId === item.userId;

        return (
          <View key={item.matchId} style={styles.card}>
            {item.photoUrl ? (
              <Image source={{ uri: item.photoUrl }} style={styles.photo} />
            ) : (
              <View style={[styles.photo, styles.photoPlaceholder]}>
                <Text style={styles.photoPlaceholderText}>Нет фото</Text>
              </View>
            )}

            <View style={styles.cardBody}>
              <Text style={styles.name}>
                {item.displayName || 'Без имени'}
                {age ? `, ${age}` : ''}
              </Text>
              {item.city && <Text style={styles.city}>{item.city}</Text>}
              <Text style={styles.sobriety}>{SOBRIETY_LABEL[item.sobrietyStatus]}</Text>
              {item.bio && <Text style={styles.bio}>{item.bio}</Text>}
            </View>

            <View style={styles.actionsRow}>
              <TouchableOpacity style={styles.skipButton} onPress={() => handleSkip(item)} disabled={busy}>
                <Ionicons name="close" size={26} color={colors.textSecondary} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.heartButton} onPress={() => handleLikeBack(item)} disabled={busy}>
                {busy ? <ActivityIndicator color={colors.white} size="small" /> : <Ionicons name="heart" size={26} color={colors.white} />}
              </TouchableOpacity>
            </View>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.bg },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center' },
  list: { padding: 16, backgroundColor: colors.bg },
  card: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, marginBottom: 16, overflow: 'hidden' },
  photo: { width: '100%', height: 240, backgroundColor: colors.surface },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: colors.textFaint },
  cardBody: { padding: 14 },
  name: { fontSize: 18, fontWeight: '600', marginBottom: 4, color: colors.textPrimary },
  city: { fontSize: 14, color: colors.textSecondary, marginBottom: 4 },
  sobriety: { fontSize: 13, color: colors.accent, fontWeight: '600', marginBottom: 8 },
  bio: { fontSize: 14, color: colors.textPrimary, lineHeight: 20 },
  actionsRow: { flexDirection: 'row', gap: 12, padding: 14, paddingTop: 0 },
  skipButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  heartButton: { flex: 1, backgroundColor: colors.accent, borderRadius: 10, padding: 14, alignItems: 'center' },
});
