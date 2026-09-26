// src/screens/Feed.tsx
import React, { useEffect, useLayoutEffect, useState, useCallback } from 'react';
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
import { getMyCoordinates } from '../lib/location';
import { likeProfile } from '../lib/matches';
import { SOBRIETY_LABEL, SUBSTANCE_LABEL, SobrietyStatus, calcAge, isOnline, formatDistance } from '../lib/profileDisplay';
import { colors } from '../lib/theme';

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

const AUTO_REFRESH_MS = 60_000;

export default function Feed() {
  const navigation = useNavigation<any>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOnId, setActingOnId] = useState<string | null>(null);
  const [myId, setMyId] = useState<string | null>(null);
  const [lastSkipped, setLastSkipped] = useState<{ matchId: string; profile: Profile } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  // silent=true — фоновое обновление: список на экране не подменяем
  // спиннером, чтобы мигание каждые пару минут не раздражало.
  const loadFeed = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setLoadError(null);
      }

      const {
        data: { user },
        error: authError,
      } = await supabase.auth.getUser();

      // Раньше здесь был просто `return`, из-за чего loading навсегда
      // оставался true и экран висел на спиннере при любом сбое сессии.
      if (!user) {
        setLoading(false);
        setLoadError(authError?.message || 'Не удалось проверить сессию.');
        return;
      }

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
        .select('id, display_name, birth_date, city, bio, sobriety_status, substance_type, photo_url, last_seen_at')
        .eq('moderation_status', 'approved')
        .not('id', 'in', `(${excludeIds.join(',')})`)
        .limit(20);

      if (error) {
        setLoading(false);
        setLoadError('Не удалось загрузить анкеты: ' + error.message);
        console.warn('Ошибка загрузки ленты:', error.message);
        return;
      }

      // Расстояния считаются на сервере (см. функцию nearby_profiles) —
      // клиент никогда не получает точные координаты других пользователей,
      // только готовое значение в километрах. Это осознанное решение по
      // безопасности для приложения такой тематики.
      const myLocation = await getMyCoordinates();

      let distanceMap = new Map<string, number>();
      if (myLocation) {
        const { data: distances } = await supabase.rpc('nearby_profiles', {
          viewer_lat: myLocation.latitude,
          viewer_lng: myLocation.longitude,
        });
        (distances || []).forEach((d: { profile_id: string; distance_km: number }) => {
          distanceMap.set(d.profile_id, d.distance_km);
        });
      }

      setLoading(false);
      setLoadError(null);
      setProfiles((data || []).map((p) => ({ ...p, distanceKm: distanceMap.get(p.id) })));
    },
    [updateMyLocation]
  );

  // Лента не перезагружалась никогда, кроме первого открытия: активной
  // перезагрузки и pull-to-refresh не было, и как только список заканчивался,
  // экран показывал «Анкет пока нет» даже когда анкеты в базе были.
  useEffect(() => {
    loadFeed();
    const interval = setInterval(() => loadFeed(true), AUTO_REFRESH_MS);
    return () => clearInterval(interval);
  }, [loadFeed]);

  // Кнопка обновления в шапке. Эффект объявлен после loadFeed, чтобы в
  // зависимостях не оказалась переменная, которая ещё не инициализирована.
  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={() => loadFeed(true)} style={{ paddingHorizontal: 10 }}>
            <Ionicons name="refresh" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => navigation.navigate('IncomingLikes')}
            style={{ paddingHorizontal: 12 }}
          >
            <Ionicons name="heart-outline" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, loadFeed]);

  async function handleAction(target: Profile, action: 'like' | 'skip') {
    if (!myId) return;
    setActingOnId(target.id);

    // Если текущая анкера была последней в очереди, сразу берём следующую
    // пачку. Без этого пользователь, пролистав ленту до конца, упирался в
    // «Анкет пока нет» и был вынужден жать «Обновить» вручную.
    const dropFromFeed = () => {
      setProfiles((prev) => prev.filter((p) => p.id !== target.id));
      if (profiles.length <= 1) {
        loadFeed(true);
      }
    };

    if (action === 'skip') {
      const { data: inserted } = await supabase
        .from('matches')
        .insert({ user_a: myId, user_b: target.id, status: 'rejected' })
        .select('id')
        .single();

      if (inserted) setLastSkipped({ matchId: inserted.id, profile: target });
      dropFromFeed();
      setActingOnId(null);
      return;
    }

    setLastSkipped(null);

    const result = await likeProfile(myId, target.id);
    dropFromFeed();
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

  async function handleUndoSkip() {
    if (!lastSkipped) return;
    const { matchId, profile } = lastSkipped;

    // Удаляем запись только если это всё ещё наш собственный скип.
    // Условие по status — не подстраховка, а требование политики
    // «Отмена своего скипа»: если человек успел поставить лайк в ответ,
    // likeProfile() перевёл пару в 'pending', и удаление уничтожило бы его лайк.
    const { data: removed, error } = await supabase
      .from('matches')
      .delete()
      .eq('id', matchId)
      .eq('status', 'rejected')
      .select('id');

    // Анкета в любом случае возвращается в ленту.
    setProfiles((prev) => [profile, ...prev]);
    setLastSkipped(null);

    if (error) {
      Alert.alert('Ошибка', 'Не удалось вернуть анкету: ' + error.message);
      return;
    }

    if (!removed || removed.length === 0) {
      // Пара перекрыта лайком — вернуть в ленту можно, но пользователь
      // должен знать, что лайк уже учтён и совпадение может произойти сразу.
      Alert.alert('Обратите внимание', 'Этот человек успел поставить вам лайк, пока вы его пропускали. Анкета возвращена в ленту — лайкните, чтобы создать совпадение.');
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (loadError) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>Не удалось загрузить</Text>
        <Text style={styles.emptyBody}>{loadError}</Text>
        <TouchableOpacity style={styles.refreshButton} onPress={() => loadFeed()}>
          <Text style={styles.refreshButtonText}>Повторить</Text>
        </TouchableOpacity>
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
        <TouchableOpacity style={styles.refreshButton} onPress={() => loadFeed()}>
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
            style={[styles.onlineDot, { backgroundColor: isOnline(current.last_seen_at) ? colors.success : colors.offline }]}
          />
        </View>
        {current.substance_type && current.substance_type.length > 0 && (
          <View style={styles.tagsRow}>
            {current.substance_type.map((s) => (
              <View key={s} style={styles.tag}>
                <Text style={styles.tagText}>{SUBSTANCE_LABEL[s] || s}</Text>
              </View>
            ))}
          </View>
        )}
        {current.city && <Text style={styles.city}>{current.city}</Text>}
        {formatDistance(current.distanceKm) && (
          <Text style={styles.distance}>{formatDistance(current.distanceKm)}</Text>
        )}
        <Text style={styles.sobriety}>{SOBRIETY_LABEL[current.sobriety_status]}</Text>
        {current.bio && <Text style={styles.bio}>{current.bio}</Text>}
      </ScrollView>

      {lastSkipped && (
        <TouchableOpacity style={styles.undoRow} onPress={handleUndoSkip}>
          <Ionicons name="arrow-undo" size={16} color={colors.accent} />
          <Text style={styles.undoText}>Вернуть {lastSkipped.profile.display_name || 'анкету'}</Text>
        </TouchableOpacity>
      )}

      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={styles.skipButton}
          onPress={() => handleAction(current, 'skip')}
          disabled={busy}
        >
          <Ionicons name="close" size={28} color={colors.textSecondary} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.heartButton}
          onPress={() => handleAction(current, 'like')}
          disabled={busy}
        >
          {busy ? (
            <ActivityIndicator color={colors.white} size="small" />
          ) : (
            <Ionicons name="heart" size={28} color={colors.white} />
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.bg },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, textAlign: 'center', marginBottom: 20 },
  refreshButton: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  refreshButtonText: { color: colors.white, fontWeight: '600' },
  container: { flex: 1, backgroundColor: colors.bg },
  photo: { width: '100%', height: 380, backgroundColor: colors.border },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: colors.textMuted },
  infoScroll: { flex: 1 },
  infoContent: { padding: 16 },
  name: { fontSize: 20, fontWeight: '700', marginBottom: 4, color: colors.textPrimary },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineDot: { width: 9, height: 9, borderRadius: 5, marginBottom: 4 },
  city: { fontSize: 15, color: colors.textSecondary, marginBottom: 4 },
  tagsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 8 },
  tag: { backgroundColor: colors.surface, borderRadius: 14, paddingVertical: 5, paddingHorizontal: 12 },
  tagText: { color: colors.textPrimary, fontSize: 13 },
  distance: { fontSize: 13, color: colors.textSecondary, marginBottom: 4, fontStyle: 'italic' },
  sobriety: { fontSize: 14, color: colors.accent, fontWeight: '600', marginBottom: 10 },
  bio: { fontSize: 15, color: colors.textPrimary, lineHeight: 21 },
  actionsRow: { flexDirection: 'row', gap: 12, padding: 16 },
  undoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 8,
  },
  undoText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  skipButton: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 16,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  heartButton: { flex: 1, backgroundColor: colors.accent, borderRadius: 10, padding: 16, alignItems: 'center' },
});
