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
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { SOBRIETY_LABEL, SUBSTANCE_LABEL, SobrietyStatus, calcAge, isOnline } from '../lib/profileDisplay';
import { colors } from '../lib/theme';

type FullProfile = {
  id: string;
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  bio: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  sobriety_status: SobrietyStatus;
  substance_type: string[] | null;
  photo_url: string | null;
  additional_photos: string[] | null;
  last_seen_at: string | null;
};

const screenWidth = Dimensions.get('window').width;

export default function ProfileDetail() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { profileId } = route.params;

  const [profile, setProfile] = useState<FullProfile | null>(null);
  const [distanceKm, setDistanceKm] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [matchInfo, setMatchInfo] = useState<{ matchId: string; status: 'pending' | 'matched' | 'rejected' } | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    const { data, error } = await supabase
      .from('profiles')
      .select(
        'id, display_name, birth_date, city, bio, height_cm, weight_kg, sobriety_status, substance_type, photo_url, additional_photos, last_seen_at'
      )
      .eq('id', profileId)
      .maybeSingle();

    if (!error && data) setProfile(data as FullProfile);

    // Проверяем совпадение в ОБЕ стороны — иначе не узнаем про matched,
    // если собеседник лайкнул первым.
    const { data: existingMatch } = await supabase
      .from('matches')
      .select('id, status')
      .or(`and(user_a.eq.${user.id},user_b.eq.${profileId}),and(user_a.eq.${profileId},user_b.eq.${user.id})`)
      .maybeSingle();
    setMatchInfo(existingMatch ? { matchId: existingMatch.id, status: existingMatch.status } : null);

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

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
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
            <View style={[styles.onlineDot, { backgroundColor: online ? colors.success : colors.textFaint }]} />
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

        {matchInfo?.status === 'matched' && (
          <TouchableOpacity
            style={styles.messageButton}
            onPress={() =>
              navigation.navigate('Chat', {
                matchId: matchInfo.matchId,
                otherUserId: profile.id,
                otherName: profile.display_name,
                otherAge: age,
              })
            }
          >
            <Text style={styles.likeButtonText}>Написать сообщение</Text>
          </TouchableOpacity>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  contentContainer: { paddingBottom: 40 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  emptyText: { color: colors.textSecondary, fontSize: 15 },
  mainPhoto: { height: 420, backgroundColor: colors.surface },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: colors.textFaint },
  body: { padding: 20 },
  nameRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  name: { fontSize: 22, fontWeight: '700', color: colors.textPrimary, flexShrink: 1 },
  onlineBadge: { flexDirection: 'row', alignItems: 'center' },
  onlineDot: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  onlineText: { fontSize: 12, color: colors.textSecondary },
  infoLine: { fontSize: 14, color: colors.textSecondary, marginBottom: 4 },
  sobriety: { fontSize: 14, color: colors.accent, fontWeight: '600', marginTop: 8, marginBottom: 10 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  tag: { backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 6, paddingHorizontal: 12 },
  tagText: { color: colors.textPrimary, fontSize: 13 },
  bio: { fontSize: 15, color: colors.textPrimary, lineHeight: 22, marginBottom: 24 },
  likeButtonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
  messageButton: { backgroundColor: '#22c55e', borderRadius: 10, padding: 16, alignItems: 'center' },
});
