// src/screens/ProfileDetail.tsx
import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Dimensions,
  Alert,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';

const SOBRIETY_LABEL: Record<string, string> = {
  trezv: 'Чист(а)',
  v_sryve: 'Всё сложно',
  ne_ukazano: 'Статус не указан',
};

const SUBSTANCE_LABEL: Record<string, string> = {
  alcohol: 'Алкоголь',
  opioids: 'Опиоиды',
  stimulants: 'Стимуляторы',
  cannabis: 'Каннабис',
  other: 'Другое',
};

const ONLINE_THRESHOLD_MS = 3 * 60 * 1000; // 3 минуты — с запасом от heartbeat раз в 45с

type FullProfile = {
  id: string;
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  bio: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  sobriety_status: 'trezv' | 'v_sryve' | 'ne_ukazano';
  substance_type: string[] | null;
  photo_url: string | null;
  additional_photos: string[] | null;
  last_seen_at: string | null;
};

function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

const screenWidth = Dimensions.get('window').width;

export default function ProfileDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { profileId } = route.params;

  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [alreadyActed, setAlreadyActed] = useState(false);
  const [liking, setLiking] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setMyId(user.id);

    const { data, error } = await supabase
      .from('profiles')
      .select(
        'id, display_name, birth_date, city, bio, height_cm, weight_kg, sobriety_status, substance_type, photo_url, additional_photos, last_seen_at'
      )
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) setProfile(data as FullProfile);

    const { data: existingMatch } = await supabase
      .from('matches')
      .select('id')
      .eq('user_a', user.id)
      .eq('user_b', profileId)
      .maybeSingle();
    setAlreadyActed(!!existingMatch);

    const { data: myProfile } = await supabase
      .from('profiles')
      .select('latitude, longitude')
      .eq('id', user.id)
      .maybeSingle();

    if (myProfile?.latitude != null && myProfile?.longitude != null) {
      const { data: distances } = await supabase.rpc('nearby_profiles', {
        viewer_lat: myProfile.latitude,
        viewer_lng: myProfile.longitude,
      });
      const match = (distances || []).find((d: { profile_id: string }) => d.profile_id === profileId);
      if (match) setDistanceKm(match.distance_km);
    }

    setLoading(false);
  }, [profileId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleLike() {
    if (!myId || !profile || alreadyActed) return;
    setLiking(true);

    const { data: reverseMatch } = await supabase
      .from('matches')
      .select('id, status')
      .eq('user_a', profile.id)
      .eq('user_b', myId)
      .maybeSingle();

    if (reverseMatch && reverseMatch.status === 'pending') {
      await supabase
        .from('matches')
        .update({ status: 'matched', matched_at: new Date().toISOString() })
        .eq('id', reverseMatch.id);
      setLiking(false);
      setAlreadyActed(true);
      Alert.alert('Это совпадение! 🎉', `Вы с ${profile.display_name || 'этим человеком'} понравились друг другу.`, [
        { text: 'Написать сообщение', onPress: () => navigation.navigate('ChatList') },
        { text: 'Продолжить', style: 'cancel' },
      ]);
      return;
    }

    await supabase.from('matches').insert({ user_a: myId, user_b: profile.id, status: 'pending' });
    setLiking(false);
    setAlreadyActed(true);
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Анкета не найдена</Text>
      </View>
    );
  }

  const age = calcAge(profile.birth_date);
  const online = isOnline(profile.last_seen_at);
  const allPhotos = [profile.photo_url, ...(profile.additional_photos || [])].filter(Boolean) as string[];

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.contentContainer}>
      {allPhotos.length > 0 ? (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false}>
          {allPhotos.map((url, i) => (
            <Image key={i} source={{ uri: url }} style={[styles.mainPhoto, { width: screenWidth }]} />
          ))}
        </ScrollView>
      ) : (
        <View style={[styles.mainPhoto, styles.photoPlaceholder, { width: screenWidth }]}>
          <Text style={styles.photoPlaceholderText}>Нет фото</Text>
        </View>
      )}

      <View style={styles.body}>
        <View style={styles.nameRow}>
          <Text style={styles.name}>
            {profile.display_name || 'Без имени'}
            {age ? `, ${age}` : ''}
          </Text>
          <View style={styles.onlineBadge}>
            <View style={[styles.onlineDot, { backgroundColor: online ? '#4ade80' : '#8a8a8e' }]} />
            <Text style={styles.onlineText}>{online ? 'В сети' : 'Не в сети'}</Text>
          </View>
        </View>

        {profile.city && <Text style={styles.infoLine}>{profile.city}</Text>}
        {distanceKm !== undefined && (
          <Text style={styles.infoLine}>
            {distanceKm < 1 ? 'Меньше 1 км от вас' : `~${Math.round(distanceKm)} км от вас`}
          </Text>
        )}

        {(profile.height_cm || profile.weight_kg) && (
          <Text style={styles.infoLine}>
            {profile.height_cm ? `${profile.height_cm} см` : ''}
            {profile.height_cm && profile.weight_kg ? ' · ' : ''}
            {profile.weight_kg ? `${profile.weight_kg} кг` : ''}
          </Text>
        )}

        <Text style={styles.sobriety}>{SOBRIETY_LABEL[profile.sobriety_status]}</Text>

        {profile.substance_type && profile.substance_type.length > 0 && (
          <View style={styles.tagsRow}>
            {profile.substance_type.map((s) => (
              <View key={s} style={styles.tag}>
                <Text style={styles.tagText}>{SUBSTANCE_LABEL[s] || s}</Text>
              </View>
            ))}
          </View>
        )}

        {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}

        <TouchableOpacity
          style={[styles.likeButton, alreadyActed && styles.likeButtonDone]}
          onPress={handleLike}
          disabled={alreadyActed || liking}
        >
          {liking ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.likeButtonText}>{alreadyActed ? 'Уже отправлено' : 'Нравится'}</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  contentContainer: { paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' },
  emptyText: { color: '#a0a0a5', fontSize: 15 },
  mainPhoto: { height: 420, backgroundColor: '#1c1c1e' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: '#8a8a8e' },
  body: { padding: 20 },
  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  name: { fontSize: 22, fontWeight: '700', color: '#f0f0f0', flexShrink: 1 },
  onlineBadge: { flexDirection: 'row', alignItems: 'center' },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  onlineText: { fontSize: 12, color: '#a0a0a5' },
  infoLine: { fontSize: 14, color: '#a0a0a5', marginBottom: 4 },
  sobriety: { fontSize: 14, color: '#3b82f6', fontWeight: '600', marginTop: 8, marginBottom: 10 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  tag: { backgroundColor: '#1c1c1e', borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12 },
  tagText: { color: '#f0f0f0', fontSize: 13 },
  bio: { fontSize: 15, color: '#f0f0f0', lineHeight: 22, marginBottom: 24 },
  likeButton: { backgroundColor: '#3b82f6', borderRadius: 10, padding: 16, alignItems: 'center' },
  likeButtonDone: { backgroundColor: '#2a2a2a' },
  likeButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
