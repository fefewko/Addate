// src/screens/Feed.tsx
import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  ScrollView,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import * as Location from 'expo-location';
import Ionicons from '@expo/vector-icons/Ionicons';
import { supabase } from '../lib/supabase';
import { likeProfile } from '../lib/matches';
import { SOBRIETY_LABEL, SobrietyStatus, calcAge, isOnline, formatDistance } from '../lib/profileDisplay';

type Profile = {
  id: string;
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  bio: string | null;
  sobriety_status: SobrietyStatus;
  photo_url: string | null;
  last_seen_at: string | null;
  distanceKm?: number;
};

export default function Feed() {
  const navigation = useNavigation<any>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);

  const updateMyLocation = useCallback(async (userId: string) => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return; // молча пропускаем — фича необязательная

      const position = await Location.getCurrentPositionAsync({});
      await supabase
        .from('profiles')
        .update({ latitude: position.coords.latitude, longitude: position.coords.longitude })
        .eq('id', userId);
    } catch (e) {
      console.warn('Не удалось получить геопозицию:', e);
    }
  }, []);

  const loadFeed = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setMyId(user.id);

    await updateMyLocation(user.id);

    // 1. Кого я уже блокировал или кто заблокировал меня — исключаем в обе стороны
    const { data: blocksData } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

    const blockedIds = new Set<string>();
    (blocksData || []).forEach((b) => {
      blockedIds.add(b.blocker_id === user.id ? b.blocked_id : b.blocker_id);
    });

    // 2. Кому я уже поставил лайк/скип, или кто уже совпал со мной (в любом направлении)
    const { data: actedData } = await supabase
      .from('matches')
      .select('user_a, user_b')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`);

    const actedIds = new Set(
      (actedData || []).map((m) => (m.user_a === user.id ? m.user_b : m.user_a))
    );

    const excludeIds = [user.id, ...blockedIds, ...actedIds];

    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, birth_date, city, bio, sobriety_status, photo_url, last_seen_at')
      .eq('moderation_status', 'approved')
      .not('id', 'in', `(${excludeIds.join(',')})`)
      .limit(20);

    if (error) {
      setLoading(false);
      console.warn('Ошибка загрузки ленты:', error.message);
      return;
    }

    // Расстояния считаются на сервере (см. функцию nearby_profiles) —
    // клиент никогда не получает точные координаты других пользователей,
    // только готовое значение в километрах. Это осознанное решение по
    // безопасности для приложения такой тематики.
    const { data: myProfile } = await supabase
      .from('profiles')
      .select('latitude, longitude')
      .eq('id', user.id)
      .maybeSingle();

    let distanceMap = new Map<string, number>();
    if (myProfile?.latitude != null && myProfile?.longitude != null) {
      const { data: distances } = await supabase.rpc('nearby_profiles', {
        viewer_lat: myProfile.latitude,
        viewer_lng: myProfile.longitude,
      });
      (distances || []).forEach((d: { profile_id: string; distance_km: number }) => {
        distanceMap.set(d.profile_id, d.distance_km);
      });
    }

    setLoading(false);
    setProfiles((data || []).map((p) => ({ ...p, distanceKm: distanceMap.get(p.id) })));
  }, [updateMyLocation]);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  async function handleAction(target: Profile, action: 'like' | 'skip') {
    if (!myId) return;
    setActingOnId(target.id);

    if (action === 'skip') {
      await supabase.from('matches').insert({
        user_a: myId,
        user_b: target.id,
        status: 'rejected',
      });
      setProfiles((prev) => prev.filter((p) => p.id !== target.id));
      setActingOnId(null);
      return;
    }

    const result = await likeProfile(myId, target.id);
    setProfiles((prev) => prev.filter((p) => p.id !== target.id));
    setActingOnId(null);

    if (result.matched) {
      const age = calcAge(target.birth_date);
      Alert.alert('Это совпадение! 🎉', `Вы с ${target.display_name || 'этим человеком'} понравились друг другу.`, [
        {
          text: 'Написать сообщение',
          onPress: () =>
            navigation.navigate('Chat', {
              matchId: result.matchId,
              otherUserId: target.id,
              otherName: target.display_name,
              otherAge: age,
            }),
        },
        { text: 'Продолжить смотреть анкеты', style: 'cancel' },
      ]);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  if (profiles.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Анкет пока нет</Text>
        <Text style={styles.emptyBody}>
          Загляните позже — новые анкеты появляются по мере роста сообщества.
        </Text>
        <TouchableOpacity style={styles.refreshButton} onPress={loadFeed}>
          <Text style={styles.refreshButtonText}>Обновить</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const current = profiles[0];
  const age = calcAge(current.birth_date);
  const busy = actingOnId === current.id;

  return (
    <View style={styles.container}>
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => navigation.navigate('ProfileDetail', { profileId: current.id })}
      >
        {current.photo_url ? (
          <Image source={{ uri: current.photo_url }} style={styles.photo} />
        ) : (
          <View style={[styles.photo, styles.photoPlaceholder]}>
            <Text style={styles.photoPlaceholderText}>Нет фото</Text>
          </View>
        )}
      </TouchableOpacity>

      <ScrollView style={styles.infoScroll} contentContainerStyle={styles.infoContent}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>
            {current.display_name || 'Без имени'}
            {age ? `, ${age}` : ''}
          </Text>
          <View
            style={[styles.onlineDot, { backgroundColor: isOnline(current.last_seen_at) ? '#4ade80' : '#5a5a5e' }]}
          />
        </View>
        {current.city && <Text style={styles.city}>{current.city}</Text>}
        {formatDistance(current.distanceKm) && (
          <Text style={styles.distance}>{formatDistance(current.distanceKm)}</Text>
        )}
        <Text style={styles.sobriety}>{SOBRIETY_LABEL[current.sobriety_status]}</Text>
        {current.bio && <Text style={styles.bio}>{current.bio}</Text>}
      </ScrollView>

      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.skipButton}
          onPress={() => handleAction(current, 'skip')}
          disabled={busy}
        >
          <Ionicons name="close" size={28} color="#a0a0a5" />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.likeButton}
          onPress={() => handleAction(current, 'like')}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <Ionicons name="heart" size={28} color="#fff" />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#121212' },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: '#f0f0f0' },
  emptyBody: { fontSize: 14, color: '#a0a0a5', textAlign: 'center', marginBottom: 20 },
  refreshButton: { backgroundColor: '#3b82f6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  refreshButtonText: { color: '#fff', fontWeight: '600' },
  container: { flex: 1, backgroundColor: '#121212' },
  photo: { width: '100%', height: 380, backgroundColor: '#2a2a2a' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: '#9a9a9e' },
  infoScroll: { flex: 1 },
  infoContent: { padding: 16 },
  name: { fontSize: 20, fontWeight: '700', marginBottom: 4, color: '#f0f0f0' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineDot: { width: 9, height: 9, borderRadius: 5, marginBottom: 4 },
  city: { fontSize: 15, color: '#a0a0a5', marginBottom: 4 },
  distance: { fontSize: 13, color: '#a0a0a5', marginBottom: 4, fontStyle: 'italic' },
  sobriety: { fontSize: 14, color: '#3b82f6', fontWeight: '600', marginBottom: 10 },
  bio: { fontSize: 15, color: '#f0f0f0', lineHeight: 21 },
  actions: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: '#2a2a2a' },
  skipButton: { flex: 1, padding: 16, alignItems: 'center', borderRightWidth: 1, borderRightColor: '#2a2a2a' },
  likeButton: { flex: 1, padding: 16, alignItems: 'center', backgroundColor: '#3b82f6' },
});
