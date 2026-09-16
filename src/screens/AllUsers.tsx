// src/screens/AllUsers.tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { supabase } from '../lib/supabase';

type Profile = {
  id: string;
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  bio: string | null;
  sobriety_status: 'trezv' | 'v_sryve' | 'ne_ukazano';
  photo_url: string | null;
  last_seen_at: string | null;
  distanceKm?: number;
};

const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;
function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

function formatDistance(km: number | undefined): string | null {
  if (km === undefined) return null;
  if (km < 1) return 'Меньше 1 км от вас';
  return `~${Math.round(km)} км от вас`;
}

const SOBRIETY_LABEL: Record<string, string> = {
  trezv: 'Чист(а)',
  v_sryve: 'Всё сложно',
  ne_ukazano: 'Статус не указан',
};

function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

export default function AllUsers() {
  const navigation = useNavigation<any>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setMyId(user.id);

    const { data: blocksData } = await supabase
      .from('blocks')
      .select('blocker_id, blocked_id')
      .or(`blocker_id.eq.${user.id},blocked_id.eq.${user.id}`);

    const blockedIds = new Set<string>();
    (blocksData || []).forEach((b) => {
      blockedIds.add(b.blocker_id === user.id ? b.blocked_id : b.blocker_id);
    });

    const { data: myActions } = await supabase
      .from('matches')
      .select('user_b')
      .eq('user_a', user.id);
    setLikedIds(new Set((myActions || []).map((m) => m.user_b)));

    const excludeIds = [user.id, ...blockedIds];

    const { data, error } = await supabase
      .from('profiles')
      .select('id, display_name, birth_date, city, bio, sobriety_status, photo_url, last_seen_at')
      .eq('moderation_status', 'approved')
      .not('id', 'in', `(${excludeIds.join(',')})`)
      .order('created_at', { ascending: false });

    if (error) {
      setLoading(false);
      console.warn('Ошибка загрузки списка пользователей:', error.message);
      return;
    }

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
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  async function handleLike(target: Profile) {
    if (!myId || likedIds.has(target.id)) return;
    setBusyId(target.id);

    const { data: reverseMatch } = await supabase
      .from('matches')
      .select('id, status')
      .eq('user_a', target.id)
      .eq('user_b', myId)
      .maybeSingle();

    if (reverseMatch && reverseMatch.status === 'pending') {
      await supabase
        .from('matches')
        .update({ status: 'matched', matched_at: new Date().toISOString() })
        .eq('id', reverseMatch.id);

      setLikedIds((prev) => new Set(prev).add(target.id));
      setBusyId(null);
      Alert.alert('Это совпадение! 🎉', `Вы с ${target.display_name || 'этим человеком'} понравились друг другу.`, [
        { text: 'Написать сообщение', onPress: () => navigation.navigate('ChatList') },
        { text: 'Продолжить', style: 'cancel' },
      ]);
      return;
    }

    await supabase.from('matches').insert({ user_a: myId, user_b: target.id, status: 'pending' });
    setLikedIds((prev) => new Set(prev).add(target.id));
    setBusyId(null);
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
        <Text style={styles.emptyTitle}>Пока никого нет</Text>
        <TouchableOpacity style={styles.refreshButton} onPress={loadAll}>
          <Text style={styles.refreshButtonText}>Обновить</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {profiles.map((profile) => {
        const age = calcAge(profile.birth_date);
        const liked = likedIds.has(profile.id);
        const busy = busyId === profile.id;

        return (
          <View key={profile.id} style={styles.card}>
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => navigation.navigate('ProfileDetail', { profileId: profile.id })}
            >
              {profile.photo_url ? (
                <Image source={{ uri: profile.photo_url }} style={styles.photo} />
              ) : (
                <View style={[styles.photo, styles.photoPlaceholder]}>
                  <Text style={styles.photoPlaceholderText}>Нет фото</Text>
                </View>
              )}

              <View style={styles.cardBody}>
                <View style={styles.nameRow}>
                  <Text style={styles.name}>
                    {profile.display_name || 'Без имени'}
                    {age ? `, ${age}` : ''}
                  </Text>
                  <View style={[styles.onlineDot, { backgroundColor: isOnline(profile.last_seen_at) ? '#4ade80' : '#5a5a5e' }]} />
                </View>
                {profile.city && <Text style={styles.city}>{profile.city}</Text>}
                {formatDistance(profile.distanceKm) && (
                  <Text style={styles.distance}>{formatDistance(profile.distanceKm)}</Text>
                )}
                <Text style={styles.sobriety}>{SOBRIETY_LABEL[profile.sobriety_status]}</Text>
                {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}
              </View>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.likeButton, liked && styles.likeButtonDone]}
              onPress={() => handleLike(profile)}
              disabled={liked || busy}
            >
              {busy ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <Text style={styles.likeButtonText}>{liked ? 'Отправлено ✓' : 'Нравится'}</Text>
              )}
            </TouchableOpacity>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#121212' },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 16, color: '#f0f0f0' },
  refreshButton: { backgroundColor: '#3b82f6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  refreshButtonText: { color: '#fff', fontWeight: '600' },
  list: { padding: 16, backgroundColor: '#121212' },
  card: { borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 12, marginBottom: 16, overflow: 'hidden' },
  photo: { width: '100%', height: 220, backgroundColor: '#1c1c1e' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: '#8a8a8e' },
  cardBody: { padding: 14 },
  name: { fontSize: 18, fontWeight: '600', marginBottom: 4, color: '#f0f0f0' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineDot: { width: 9, height: 9, borderRadius: 5, marginBottom: 4 },
  city: { fontSize: 14, color: '#a0a0a5', marginBottom: 4 },
  distance: { fontSize: 13, color: '#a0a0a5', marginBottom: 4, fontStyle: 'italic' },
  sobriety: { fontSize: 13, color: '#3b82f6', fontWeight: '600', marginBottom: 8 },
  bio: { fontSize: 14, color: '#f0f0f0', lineHeight: 20 },
  likeButton: {
    backgroundColor: '#3b82f6',
    padding: 14,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  likeButtonDone: { backgroundColor: '#2a2a2a' },
  likeButtonText: { color: '#fff', fontWeight: '600' },
});
