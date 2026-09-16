// src/screens/AllUsers.tsx
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import {
  View,
  Text,
  Image,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  ScrollView,
  Alert,
  Modal,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import Ionicons from '@expo/vector-icons/Ionicons';
import Slider from '@react-native-community/slider';
import { supabase } from '../lib/supabase';

type SobrietyStatus = 'trezv' | 'v_sryve' | 'ne_ukazano';

type Profile = {
  id: string;
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  bio: string | null;
  sobriety_status: SobrietyStatus;
  substance_type: string[] | null;
  photo_url: string | null;
  last_seen_at: string | null;
  distanceKm?: number;
};

type MatchInfo = { matchId: string; status: 'pending' | 'matched' | 'rejected' };

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

const SOBRIETY_LABEL: Record<SobrietyStatus, string> = {
  trezv: 'В чистоте',
  v_sryve: 'Нужна помощь',
  ne_ukazano: 'Не скажу',
};

const SOBRIETY_FILTER_OPTIONS: { value: SobrietyStatus | 'any'; label: string }[] = [
  { value: 'any', label: 'Любой' },
  { value: 'trezv', label: 'В чистоте' },
  { value: 'v_sryve', label: 'Нужна помощь' },
  { value: 'ne_ukazano', label: 'Не скажу' },
];

const SUBSTANCE_OPTIONS = [
  { value: 'alcohol', label: 'Алкоголь' },
  { value: 'opioids', label: 'Опиоиды' },
  { value: 'stimulants', label: 'Стимуляторы' },
  { value: 'cannabis', label: 'Каннабис' },
  { value: 'other', label: 'Другое' },
];

const DISTANCE_OPTIONS: { value: 'any' | '5' | '15' | '50'; label: string }[] = [
  { value: 'any', label: 'Не важно' },
  { value: '5', label: 'Рядом (до 5 км)' },
  { value: '15', label: 'До 15 км' },
  { value: '50', label: 'До 50 км' },
];

const AUTO_REFRESH_MS = 60_000;

function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const diff = Date.now() - new Date(birthDate).getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24 * 365.25));
}

type Filters = {
  city: string;
  ageMin: number;
  ageMax: number;
  distance: 'any' | '5' | '15' | '50';
  substances: string[];
  sobriety: SobrietyStatus | 'any';
};

const DEFAULT_FILTERS: Filters = {
  city: '',
  ageMin: 18,
  ageMax: 90,
  distance: 'any',
  substances: [],
  sobriety: 'any',
};

export default function AllUsers() {
  const navigation = useNavigation<any>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [matchMap, setMatchMap] = useState<Map<string, MatchInfo>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);

  const [filtersVisible, setFiltersVisible] = useState(false);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draftFilters, setDraftFilters] = useState<Filters>(DEFAULT_FILTERS);

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

    // Смотрим совпадения в ОБЕ стороны, а не только те, что я сам инициировал —
    // иначе не увидим статус "matched", если встречный лайк пришёл первым от собеседника.
    const { data: myMatches } = await supabase
      .from('matches')
      .select('id, user_a, user_b, status')
      .or(`user_a.eq.${user.id},user_b.eq.${user.id}`);

    const newMatchMap = new Map<string, MatchInfo>();
    (myMatches || []).forEach((m) => {
      const otherId = m.user_a === user.id ? m.user_b : m.user_a;
      newMatchMap.set(otherId, { matchId: m.id, status: m.status });
    });
    setMatchMap(newMatchMap);

    const excludeIds = [user.id, ...blockedIds];

    const { data, error } = await supabase
      .from('profiles')
      .select(
        'id, display_name, birth_date, city, bio, sobriety_status, substance_type, photo_url, last_seen_at'
      )
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
    const interval = setInterval(loadAll, AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadAll]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={loadAll} style={{ paddingHorizontal: 10 }}>
            <Ionicons name="refresh" size={22} color="#f0f0f0" />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setDraftFilters(filters);
              setFiltersVisible(true);
            }}
            style={{ paddingHorizontal: 10 }}
          >
            <Ionicons name="filter" size={22} color="#f0f0f0" />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, loadAll, filters]);

  async function handleLike(target: Profile) {
    if (!myId || matchMap.has(target.id)) return;
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

      setMatchMap((prev) => new Map(prev).set(target.id, { matchId: reverseMatch.id, status: 'matched' }));
      setBusyId(null);
      Alert.alert('Это совпадение! 🎉', `Вы с ${target.display_name || 'этим человеком'} понравились друг другу.`, [
        {
          text: 'Написать сообщение',
          onPress: () => {
            const age = calcAge(target.birth_date);
            navigation.navigate('Chat', {
              matchId: reverseMatch.id,
              otherUserId: target.id,
              otherName: target.display_name,
              otherAge: age,
            });
          },
        },
        { text: 'Продолжить', style: 'cancel' },
      ]);
      return;
    }

    const { data: inserted } = await supabase
      .from('matches')
      .insert({ user_a: myId, user_b: target.id, status: 'pending' })
      .select('id')
      .single();

    setMatchMap((prev) => new Map(prev).set(target.id, { matchId: inserted?.id || '', status: 'pending' }));
    setBusyId(null);
  }

  function toggleDraftSubstance(value: string) {
    setDraftFilters((prev) => ({
      ...prev,
      substances: prev.substances.includes(value)
        ? prev.substances.filter((s) => s !== value)
        : [...prev.substances, value],
    }));
  }

  function applyFilters() {
    setFilters(draftFilters);
    setFiltersVisible(false);
  }

  function resetFilters() {
    setDraftFilters(DEFAULT_FILTERS);
    setFilters(DEFAULT_FILTERS);
    setFiltersVisible(false);
  }

  const visibleProfiles = profiles.filter((p) => {
    if (filters.city.trim() && !(p.city || '').toLowerCase().includes(filters.city.trim().toLowerCase())) {
      return false;
    }

    const age = calcAge(p.birth_date);
    if (age !== null && (age < filters.ageMin || age > filters.ageMax)) return false;

    if (filters.distance !== 'any') {
      const threshold = parseInt(filters.distance, 10);
      if (p.distanceKm === undefined || p.distanceKm > threshold) return false;
    }

    if (filters.substances.length > 0) {
      const has = (p.substance_type || []).some((s) => filters.substances.includes(s));
      if (!has) return false;
    }

    if (filters.sobriety !== 'any' && p.sobriety_status !== filters.sobriety) return false;

    return true;
  });

  const activeFilterCount =
    (filters.city.trim() ? 1 : 0) +
    (filters.ageMin !== DEFAULT_FILTERS.ageMin || filters.ageMax !== DEFAULT_FILTERS.ageMax ? 1 : 0) +
    (filters.distance !== 'any' ? 1 : 0) +
    (filters.substances.length > 0 ? 1 : 0) +
    (filters.sobriety !== 'any' ? 1 : 0);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#121212' }}>
      {activeFilterCount > 0 && (
        <View style={styles.filterBar}>
          <Text style={styles.filterBarText}>Фильтры применены ({activeFilterCount})</Text>
          <TouchableOpacity onPress={resetFilters}>
            <Text style={styles.filterBarReset}>Сбросить</Text>
          </TouchableOpacity>
        </View>
      )}

      {visibleProfiles.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>Никого не нашлось</Text>
          <Text style={styles.emptyBody}>Попробуйте изменить фильтры или загляните позже.</Text>
          <TouchableOpacity style={styles.refreshButton} onPress={loadAll}>
            <Text style={styles.refreshButtonText}>Обновить</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          {visibleProfiles.map((profile) => {
            const age = calcAge(profile.birth_date);
            const match = matchMap.get(profile.id);
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
                      <View
                        style={[
                          styles.onlineDot,
                          { backgroundColor: isOnline(profile.last_seen_at) ? '#4ade80' : '#5a5a5e' },
                        ]}
                      />
                    </View>
                    {profile.city && <Text style={styles.city}>{profile.city}</Text>}
                    {formatDistance(profile.distanceKm) && (
                      <Text style={styles.distance}>{formatDistance(profile.distanceKm)}</Text>
                    )}
                    <Text style={styles.sobriety}>{SOBRIETY_LABEL[profile.sobriety_status]}</Text>
                    {profile.bio && <Text style={styles.bio}>{profile.bio}</Text>}
                  </View>
                </TouchableOpacity>

                {match?.status === 'matched' ? (
                  <TouchableOpacity
                    style={styles.messageButton}
                    onPress={() =>
                      navigation.navigate('Chat', {
                        matchId: match.matchId,
                        otherUserId: profile.id,
                        otherName: profile.display_name,
                        otherAge: age,
                      })
                    }
                  >
                    <Text style={styles.likeButtonText}>Написать сообщение</Text>
                  </TouchableOpacity>
                ) : (
                  <TouchableOpacity
                    style={[styles.likeButton, match && styles.likeButtonDone]}
                    onPress={() => handleLike(profile)}
                    disabled={!!match || busy}
                  >
                    {busy ? (
                      <ActivityIndicator color="#fff" size="small" />
                    ) : (
                      <Text style={styles.likeButtonText}>{match ? 'Отправлено ✓' : 'Нравится'}</Text>
                    )}
                  </TouchableOpacity>
                )}
              </View>
            );
          })}
        </ScrollView>
      )}

      <Modal visible={filtersVisible} animationType="slide" transparent onRequestClose={() => setFiltersVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <ScrollView contentContainerStyle={styles.modalContent}>
              <Text style={styles.modalTitle}>Фильтры</Text>

              <Text style={styles.filterLabel}>Город</Text>
              <TextInput
                style={styles.cityInput}
                placeholder="Например, Москва"
                placeholderTextColor="#8a8a8e"
                value={draftFilters.city}
                onChangeText={(v) => setDraftFilters((p) => ({ ...p, city: v }))}
              />

              <Text style={styles.filterLabel}>
                Возраст: {draftFilters.ageMin} – {draftFilters.ageMax}
              </Text>
              <Text style={styles.sliderCaption}>От</Text>
              <Slider
                minimumValue={18}
                maximumValue={90}
                step={1}
                value={draftFilters.ageMin}
                onValueChange={(v) =>
                  setDraftFilters((p) => ({ ...p, ageMin: Math.min(v, p.ageMax) }))
                }
                minimumTrackTintColor="#3b82f6"
                maximumTrackTintColor="#2a2a2a"
                thumbTintColor="#3b82f6"
              />
              <Text style={styles.sliderCaption}>До</Text>
              <Slider
                minimumValue={18}
                maximumValue={90}
                step={1}
                value={draftFilters.ageMax}
                onValueChange={(v) =>
                  setDraftFilters((p) => ({ ...p, ageMax: Math.max(v, p.ageMin) }))
                }
                minimumTrackTintColor="#3b82f6"
                maximumTrackTintColor="#2a2a2a"
                thumbTintColor="#3b82f6"
              />

              <Text style={styles.filterLabel}>Расстояние</Text>
              {DISTANCE_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.optionRow}
                  onPress={() => setDraftFilters((p) => ({ ...p, distance: opt.value }))}
                >
                  <View style={[styles.radio, draftFilters.distance === opt.value && styles.radioSelected]} />
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                </TouchableOpacity>
              ))}

              <Text style={styles.filterLabel}>Зависимости</Text>
              {SUBSTANCE_OPTIONS.map((opt) => (
                <TouchableOpacity key={opt.value} style={styles.optionRow} onPress={() => toggleDraftSubstance(opt.value)}>
                  <View
                    style={[styles.checkbox, draftFilters.substances.includes(opt.value) && styles.checkboxChecked]}
                  >
                    {draftFilters.substances.includes(opt.value) && <Text style={styles.checkboxMark}>✓</Text>}
                  </View>
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                </TouchableOpacity>
              ))}

              <Text style={styles.filterLabel}>Чистота</Text>
              {SOBRIETY_FILTER_OPTIONS.map((opt) => (
                <TouchableOpacity
                  key={opt.value}
                  style={styles.optionRow}
                  onPress={() => setDraftFilters((p) => ({ ...p, sobriety: opt.value }))}
                >
                  <View style={[styles.radio, draftFilters.sobriety === opt.value && styles.radioSelected]} />
                  <Text style={styles.optionLabel}>{opt.label}</Text>
                </TouchableOpacity>
              ))}

              <TouchableOpacity style={styles.applyButton} onPress={applyFilters}>
                <Text style={styles.applyButtonText}>Показать анкеты</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.resetLink} onPress={resetFilters}>
                <Text style={styles.resetLinkText}>Сбросить всё</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: '#121212' },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: '#f0f0f0' },
  emptyBody: { fontSize: 14, color: '#a0a0a5', marginBottom: 16, textAlign: 'center' },
  refreshButton: { backgroundColor: '#3b82f6', borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  refreshButtonText: { color: '#fff', fontWeight: '600' },
  filterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#1c1c1e',
  },
  filterBarText: { color: '#a0a0a5', fontSize: 13 },
  filterBarReset: { color: '#3b82f6', fontSize: 13, fontWeight: '600' },
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
  messageButton: {
    backgroundColor: '#22c55e',
    padding: 14,
    alignItems: 'center',
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: '#121212', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
  modalContent: { padding: 20, paddingBottom: 40 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: '#f0f0f0', marginBottom: 16 },
  filterLabel: { fontSize: 14, fontWeight: '600', color: '#f0f0f0', marginTop: 18, marginBottom: 8 },
  sliderCaption: { fontSize: 12, color: '#8a8a8e', marginBottom: -4 },
  cityInput: {
    backgroundColor: '#1c1c1e',
    color: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: '#9a9a9e', marginRight: 10 },
  radioSelected: { borderColor: '#3b82f6', backgroundColor: '#3b82f6' },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#9a9a9e',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#3b82f6', borderColor: '#3b82f6' },
  checkboxMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  optionLabel: { fontSize: 15, color: '#f0f0f0' },
  applyButton: { backgroundColor: '#3b82f6', borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 24 },
  applyButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resetLink: { padding: 14, alignItems: 'center' },
  resetLinkText: { color: '#a0a0a5', fontSize: 14 },
});
