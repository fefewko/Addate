// src/screens/AllUsers.tsx
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { log } from '../lib/log';
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
  PanResponder,
  FlatList,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { uploadChatImage, getSignedChatImageUrls } from '../lib/chatImages';
import { likeProfile } from '../lib/matches';
import { supabase } from '../lib/supabase';
import { getMyCoordinates } from '../lib/location';
import LoadError from '../ui/LoadError';
import { SOBRIETY_LABEL, SOBRIETY_OPTIONS, SUBSTANCE_OPTIONS, SobrietyStatus, calcAge, isOnline, formatDistance } from '../lib/profileDisplay';
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

// Строка от feed_profiles: та же анкета, но расстояние приходит отдельной
// колонкой от сервера, а не собирается клиентом через nearby_profiles.
type FeedRow = Omit<Profile, 'distanceKm'> & { distance_km: number | null };

type MatchInfo = { matchId: string; status: 'pending' | 'matched' | 'rejected' };

const SOBRIETY_FILTER_OPTIONS: { value: SobrietyStatus | 'any'; label: string }[] = [
  { value: 'any', label: 'Любой' },
  ...SOBRIETY_OPTIONS,
];

const DISTANCE_OPTIONS: { value: 'any' | '5'; label: string }[] = [
  { value: 'any', label: 'Не важно' },
  { value: '5', label: 'Рядом (до 5 км)' },
];

type Filters = {
  city: string;
  ageMin: number;
  ageMax: number;
  distance: 'any' | '5';
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

const AGE_MIN = 18;
const AGE_MAX = 90;
const THUMB_SIZE = 24;

// Значок статуса на карточке. Раньше ставилась тернарная цепочка
// `matched ? checkmark-done : match ? checkmark : close`, из-за чего
// status='rejected' рисовался как checkmark — то есть визуально «лайк
// отправлен», хотя на самом деле анкета была пропущена.
function badgeIcon(match: MatchInfo | undefined): keyof typeof Ionicons.glyphMap {
  switch (match?.status) {
    case 'matched':
      return 'checkmark-done';
    case 'pending':
      return 'checkmark';
    case 'rejected':
      // Стрелка предлагает повторить лайк по нажатию.
      return 'refresh';
    default:
      return 'close';
  }
}

// Один слайдер с двумя бегунками для диапазона возраста.
// Готовой библиотеки для range-слайдера в проекте нет — собран вручную на
// PanResponder (встроен в React Native), чтобы не тянуть лишнюю зависимость.
function AgeRangeSlider({
  valueMin,
  valueMax,
  onChange,
}: {
  valueMin: number;
  valueMax: number;
  onChange: (min: number, max: number) => void;
}) {
  const [trackWidth, setTrackWidth] = useState(0);
  const minValRef = useRef(valueMin);
  const maxValRef = useRef(valueMax);
  const startPos = useRef(0);

  useEffect(() => {
    minValRef.current = valueMin;
    maxValRef.current = valueMax;
  }, [valueMin, valueMax]);

  const usableWidth = Math.max(trackWidth - THUMB_SIZE, 1);

  function valueToPosition(value: number) {
    return ((value - AGE_MIN) / (AGE_MAX - AGE_MIN)) * usableWidth;
  }
  function positionToValue(pos: number) {
    const clamped = Math.max(0, Math.min(pos, usableWidth));
    const raw = AGE_MIN + (clamped / usableWidth) * (AGE_MAX - AGE_MIN);
    return Math.round(raw);
  }

  const minResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startPos.current = valueToPosition(minValRef.current);
      },
      onPanResponderMove: (_evt, gesture) => {
        let newVal = positionToValue(startPos.current + gesture.dx);
        newVal = Math.min(newVal, maxValRef.current - 1);
        if (newVal !== minValRef.current) {
          minValRef.current = newVal;
          onChange(newVal, maxValRef.current);
        }
      },
    })
  ).current;

  const maxResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startPos.current = valueToPosition(maxValRef.current);
      },
      onPanResponderMove: (_evt, gesture) => {
        let newVal = positionToValue(startPos.current + gesture.dx);
        newVal = Math.max(newVal, minValRef.current + 1);
        if (newVal !== maxValRef.current) {
          maxValRef.current = newVal;
          onChange(minValRef.current, newVal);
        }
      },
    })
  ).current;

  const minPos = valueToPosition(valueMin);
  const maxPos = valueToPosition(valueMax);

  return (
    <View
      style={sliderStyles.track}
      onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
    >
      <View style={sliderStyles.rail} />
      {trackWidth > 0 && (
        <>
          <View
            style={[
              sliderStyles.fill,
              { left: minPos + THUMB_SIZE / 2, width: Math.max(maxPos - minPos, 0) },
            ]}
          />
          <View
            {...minResponder.panHandlers}
            style={[sliderStyles.thumb, { left: minPos }]}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          />
          <View
            {...maxResponder.panHandlers}
            style={[sliderStyles.thumb, { left: maxPos }]}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          />
        </>
      )}
    </View>
  );
}

const sliderStyles = StyleSheet.create({
  track: { height: THUMB_SIZE, justifyContent: 'center', marginTop: 8, marginBottom: 4 },
  rail: { position: 'absolute', left: 0, right: 0, height: 4, borderRadius: 2, backgroundColor: colors.border },
  fill: { position: 'absolute', height: 4, borderRadius: 2, backgroundColor: colors.accent },
  thumb: {
    position: 'absolute',
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.textPrimary,
  },
});

type Message = { id: string; match_id: string; sender_id: string; content: string | null; image_path: string | null; created_at: string };

// Компактный чат прямо во всплывающем окне — чтобы можно было ответить
// человеку, не покидая вкладку "Все" и не переходя в "Сообщения".
function QuickChatModal({
  visible,
  matchId,
  otherName,
  myId,
  onClose,
}: {
  visible: boolean;
  matchId: string | null;
  otherName: string | null;
  myId: string | null;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [loading, setLoading] = useState(true);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    if (!visible || !matchId || !myId) return;

    let active = true;

    async function load() {
      setLoading(true);
      const { data } = await supabase
        .from('messages')
        .select('*')
        .eq('match_id', matchId)
        .order('created_at', { ascending: true });

      const loaded = data || [];
      if (active) {
        setMessages(loaded);
        setLoading(false);
      }

      const paths = loaded.map((m) => m.image_path).filter((p): p is string => !!p);
      if (paths.length > 0) {
        const urls = await getSignedChatImageUrls(paths);
        if (active) setImageUrls((prev) => ({ ...prev, ...urls }));
      }

      await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('match_id', matchId)
        .neq('sender_id', myId)
        .is('read_at', null);
    }
    load();

    const channel = supabase
      .channel(`quickchat-${matchId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${matchId}` },
        async (payload) => {
          const newMessage = payload.new as Message;
          setMessages((prev) => [...prev, newMessage]);
          if (newMessage.image_path) {
            const urls = await getSignedChatImageUrls([newMessage.image_path]);
            setImageUrls((prev) => ({ ...prev, ...urls }));
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [visible, matchId, myId]);

  // Подписанные ссылки живут час, поэтому по onError запрашиваем ссылку
  // заново — только для этого одного изображения. Иначе в чате, открытом
  // дольше часа, старые фотографии превращаются в битые картинки.
  const refreshImage = useCallback(async (path: string) => {
    const urls = await getSignedChatImageUrls([path]);
    if (urls[path]) {
      setImageUrls((prev) => ({ ...prev, [path]: urls[path] }));
    }
  }, []);

  async function handleSend() {
    if (!text.trim() || !myId || !matchId) return;
    setSending(true);
    const content = text.trim();
    setText('');

    const { error } = await supabase.from('messages').insert({ match_id: matchId, sender_id: myId, content });
    setSending(false);
    if (error) {
      Alert.alert('Ошибка', 'Не удалось отправить сообщение.');
      setText(content);
    }
  }

  async function handlePickImage() {
    if (!myId || !matchId || uploadingImage) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Нужен доступ', 'Разрешите доступ к галерее, чтобы отправить фото.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.6,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    setUploadingImage(true);
    try {
      const path = await uploadChatImage(matchId, result.assets[0].uri);
      const { error } = await supabase.from('messages').insert({ match_id: matchId, sender_id: myId, image_path: path });
      if (error) throw new Error(error.message);
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось отправить фото: ' + e.message);
    }
    setUploadingImage(false);
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.quickChatContainer}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <View style={styles.quickChatHeader}>
          <Text style={styles.quickChatTitle}>{otherName || 'Чат'}</Text>
          <TouchableOpacity onPress={onClose} style={{ padding: 4 }}>
            <Ionicons name="close" size={26} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.center}>
            <ActivityIndicator size="large" color={colors.accent} />
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(item) => item.id}
            contentContainerStyle={styles.quickChatList}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            renderItem={({ item }) => {
              const isMine = item.sender_id === myId;

              if (item.image_path) {
                const url = imageUrls[item.image_path];
                return (
                  <View style={[styles.bubble, styles.imageBubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                    {url ? (
                      <TouchableOpacity onPress={() => setPreviewUrl(url)}>
                        <Image
                          source={{ uri: url }}
                          style={styles.chatImage}
                          onError={() => refreshImage(item.image_path as string)}
                        />
                      </TouchableOpacity>
                    ) : (
                      <View style={[styles.chatImage, styles.chatImageLoading]}>
                        <ActivityIndicator color={colors.white} />
                      </View>
                    )}
                  </View>
                );
              }

              return (
                <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  <Text style={isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>{item.content}</Text>
                </View>
              );
            }}
          />
        )}

        <View style={[styles.quickChatInputRow, { paddingBottom: Math.max(insets.bottom, 10) }]}>
          <TouchableOpacity style={styles.attachButton} onPress={handlePickImage} disabled={uploadingImage}>
            {uploadingImage ? (
              <ActivityIndicator color={colors.textFaint} size="small" />
            ) : (
              <Ionicons name="image-outline" size={24} color={colors.textFaint} />
            )}
          </TouchableOpacity>
          <TextInput
            style={styles.quickChatInput}
            placeholder="Сообщение..."
            placeholderTextColor={colors.textFaint}
            value={text}
            onChangeText={setText}
            multiline
          />
          <TouchableOpacity
            style={[styles.quickChatSend, (!text.trim() || sending) && styles.buttonDisabledOpacity]}
            onPress={handleSend}
            disabled={!text.trim() || sending}
          >
            <Text style={styles.quickChatSendText}>Отправить</Text>
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>

      <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
        <View style={styles.previewOverlay}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewUrl(null)}>
            <Ionicons name="close" size={30} color={colors.white} />
          </TouchableOpacity>
          {previewUrl && <Image source={{ uri: previewUrl }} style={styles.previewImage} resizeMode="contain" />}
        </View>
      </Modal>
    </Modal>
  );
}

export default function AllUsers() {
  const navigation = useNavigation<RootNavigation>();
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [myId, setMyId] = useState<string | null>(null);
  const [matchMap, setMatchMap] = useState<Map<string, MatchInfo>>(new Map());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [filtersVisible, setFiltersVisible] = useState(false);
  const [quickChat, setQuickChat] = useState<{ matchId: string; otherName: string | null } | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [draftFilters, setDraftFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // Постраничная загрузка вместо «загрузить всех». Раньше страница тянула
  // ScrollView с .map() по всем одобренным анкетам: без виртуализации и без
  // ограничения выборки, что начинало ощутимо тормозить на заметном числе
  // пользователей.
  const PAGE_SIZE = 24;

  const loadAll = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    setExhausted(false);

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

    // Исключения уходят аргументом RPC, а не в URL: список заблокированных
    // рос без ограничений и примерно после 200 записей переставал помещаться
    // в запрос. Плюс заблокированных отфильтровывает сама функция.
    const myLocation = await getMyCoordinates();

    const { data, error } = await supabase.rpc('feed_profiles', {
      excluded_ids: [user.id],
      viewer_lat: myLocation?.latitude ?? null,
      viewer_lng: myLocation?.longitude ?? null,
      row_limit: PAGE_SIZE,
      row_offset: 0,
    });

    if (error) {
      setLoading(false);
      setLoadError('Не удалось загрузить анкеты: ' + error.message);
      log.warn('Ошибка загрузки списка пользователей:', error.message);
      return;
    }

    const loaded = (data || []) as FeedRow[];

    setLoading(false);
    setLoadError(null);
    setExhausted(loaded.length < PAGE_SIZE);
    setProfiles(loaded.map((p) => ({ ...p, distanceKm: p.distance_km ?? undefined })));
  }, []);

  // Догрузка следующей страницы при прокрутке до конца списка.
  const loadMore = useCallback(async () => {
    if (loadingMore || exhausted || loading || loadError || !myId) return;

    setLoadingMore(true);
    try {
      const myLocation = await getMyCoordinates();
      const { data, error } = await supabase.rpc('feed_profiles', {
        excluded_ids: [myId],
        viewer_lat: myLocation?.latitude ?? null,
        viewer_lng: myLocation?.longitude ?? null,
        row_limit: PAGE_SIZE,
        row_offset: profiles.length,
      });

      if (error) {
        log.warn('Не удалось догрузить анкеты:', error.message);
        return;
      }

      const loaded = (data || []) as FeedRow[];
      if (loaded.length < PAGE_SIZE) {
        setExhausted(true);
      }
      if (loaded.length > 0) {
        setProfiles((prev) => [
          ...prev,
          ...loaded.map((p) => ({ ...p, distanceKm: p.distance_km ?? undefined })),
        ]);
      }
    } finally {
      setLoadingMore(false);
    }
  }, [exhausted, loadError, loading, loadingMore, myId, profiles.length]);

  // Автообновление по таймеру здесь было ошибкой: loadAll() заменяет список
  // первой страницей, поэтому раз в минуту накопленные страницы исчезали и
  // пользователя отбрасывало в начало списка. Данные обновляются кнопкой в
  // шапке (она зовёт тот же loadAll) и при первом открытии экрана.
  useEffect(() => {
    loadAll();
  }, [loadAll]);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity onPress={loadAll} style={{ paddingHorizontal: 10 }}>
            <Ionicons name="refresh" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              setDraftFilters(filters);
              setFiltersVisible(true);
            }}
            style={{ paddingHorizontal: 10 }}
          >
            <Ionicons name="filter" size={22} color={colors.textPrimary} />
          </TouchableOpacity>
        </View>
      ),
    });
  }, [navigation, loadAll, filters]);

  // relike=true для анкет, которые мы ранее пропустили. Раньше повторный лайк
  // был невозможен в принципе: guard `matchMap.has(target.id)` отсекал любую
  // пару, а бейдж при status='rejected' выглядел как «лайк отправлен»
  // (синяя галочка) и при нажатии ничего не делал. Итог: пропущенного
  // в ленте человека нельзя было лайкнуть из вкладки «Все» вообще.
  async function handleLike(target: Profile, relike = false) {
    if (!myId) return;

    const existing = matchMap.get(target.id);
    if (existing && !relike) return;

    setBusyId(target.id);

    const result = await likeProfile(myId, target.id);
    setBusyId(null);

    if (result.matchId) {
      setMatchMap((prev) =>
        new Map(prev).set(target.id, {
          matchId: result.matchId as string,
          status: result.matched ? 'matched' : 'pending',
        })
      );
    }

    if (result.matched) {
      Alert.alert('Это совпадение! 🎉', `Вы с ${target.display_name || 'этим человеком'} понравились друг другу.`, [
        {
          text: 'Написать сообщение',
          onPress: () => setQuickChat({ matchId: result.matchId, otherName: target.display_name }),
        },
        { text: 'Продолжить', style: 'cancel' },
      ]);
    }
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
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (loadError) {
    return <LoadError message={loadError} onRetry={loadAll} />;
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
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
        <FlatList
          data={visibleProfiles}
          keyExtractor={(item) => item.id}
          numColumns={2}
          columnWrapperStyle={styles.column}
          contentContainerStyle={styles.list}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.footer}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : null
          }
          renderItem={({ item: profile }) => {
            const age = calcAge(profile.birth_date);
            const match = matchMap.get(profile.id);
            const busy = busyId === profile.id;

            return (
              <View style={styles.card}>
                <TouchableOpacity
                  activeOpacity={0.85}
                  onPress={() => navigation.navigate('ProfileDetail', { profileId: profile.id })}
                >
                  <View style={styles.photoWrap}>
                    {profile.photo_url ? (
                      <Image source={{ uri: profile.photo_url }} style={styles.photo} />
                    ) : (
                      <View style={[styles.photo, styles.photoPlaceholder]}>
                        <Text style={styles.photoPlaceholderText}>Нет фото</Text>
                      </View>
                    )}

                    <TouchableOpacity
                      style={[
                        styles.statusBadge,
                        match?.status === 'matched'
                          ? styles.statusBadgeMatched
                          : match?.status === 'rejected'
                          ? styles.statusBadgeNone
                          : match
                          ? styles.statusBadgeSent
                          : styles.statusBadgeNone,
                      ]}
                      onPress={() => {
                        if (match?.status === 'matched') {
                          setQuickChat({ matchId: match.matchId, otherName: profile.display_name });
                        } else if (!match || match.status === 'rejected') {
                          handleLike(profile, match?.status === 'rejected');
                        }
                      }}
                      disabled={busy || match?.status === 'pending'}
                    >
                      {busy ? (
                        <ActivityIndicator color={colors.white} size="small" />
                      ) : (
                        <Ionicons name={badgeIcon(match)} size={16} color={colors.white} />
                      )}
                    </TouchableOpacity>
                  </View>

                  <View style={styles.cardBody}>
                    <View style={styles.nameRow}>
                      <Text style={styles.name} numberOfLines={1}>
                        {profile.display_name || 'Без имени'}
                        {age ? `, ${age}` : ''}
                      </Text>
                      <View
                        style={[
                          styles.onlineDot,
                          {
                            backgroundColor: isOnline(profile.last_seen_at)
                              ? colors.success
                              : colors.offline,
                          },
                        ]}
                      />
                    </View>
                    {profile.city && (
                      <Text style={styles.city} numberOfLines={1}>
                        {profile.city}
                      </Text>
                    )}
                    {formatDistance(profile.distanceKm) && (
                      <Text style={styles.distance} numberOfLines={1}>
                        {formatDistance(profile.distanceKm)}
                      </Text>
                    )}
                    <Text style={styles.sobriety} numberOfLines={1}>
                      {SOBRIETY_LABEL[profile.sobriety_status]}
                    </Text>
                    {profile.bio && (
                      <Text style={styles.bio} numberOfLines={2}>
                        {profile.bio}
                      </Text>
                    )}
                  </View>
                </TouchableOpacity>
              </View>
            );
          }}
        />
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
                placeholderTextColor={colors.textFaint}
                value={draftFilters.city}
                onChangeText={(v) => setDraftFilters((p) => ({ ...p, city: v }))}
              />

              <Text style={styles.filterLabel}>
                Возраст: {draftFilters.ageMin} – {draftFilters.ageMax}
              </Text>
              <AgeRangeSlider
                valueMin={draftFilters.ageMin}
                valueMax={draftFilters.ageMax}
                onChange={(min, max) => setDraftFilters((p) => ({ ...p, ageMin: min, ageMax: max }))}
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

      <QuickChatModal
        visible={!!quickChat}
        matchId={quickChat?.matchId || null}
        otherName={quickChat?.otherName || null}
        myId={myId}
        onClose={() => setQuickChat(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.bg },
  emptyTitle: { fontSize: 18, fontWeight: '600', marginBottom: 8, color: colors.textPrimary },
  emptyBody: { fontSize: 14, color: colors.textSecondary, marginBottom: 16, textAlign: 'center' },
  refreshButton: { backgroundColor: colors.accent, borderRadius: 8, paddingVertical: 12, paddingHorizontal: 24 },
  refreshButtonText: { color: colors.white, fontWeight: '600' },
  filterBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: colors.surface,
  },
  filterBarText: { color: colors.textSecondary, fontSize: 13 },
  filterBarReset: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  list: { padding: 12, backgroundColor: colors.bg },
  column: { gap: 12, justifyContent: 'space-between' },
  footer: { paddingVertical: 16, alignItems: 'center' },
  card: {
    flex: 1,
    maxWidth: '48.5%',
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
  },
  photo: { width: '100%', height: 140, backgroundColor: colors.surface },
  photoWrap: { position: 'relative' },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: colors.textFaint, fontSize: 12 },
  statusBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusBadgeNone: { backgroundColor: 'rgba(90,90,94,0.85)' },
  statusBadgeSent: { backgroundColor: 'rgba(59,130,246,0.9)' },
  statusBadgeMatched: { backgroundColor: 'rgba(34,197,94,0.9)' },
  cardBody: { padding: 10 },
  name: { fontSize: 14, fontWeight: '600', marginBottom: 2, color: colors.textPrimary },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 7, height: 7, borderRadius: 4, marginBottom: 2 },
  city: { fontSize: 12, color: colors.textSecondary, marginBottom: 2 },
  distance: { fontSize: 11, color: colors.textSecondary, marginBottom: 2, fontStyle: 'italic' },
  sobriety: { fontSize: 11, color: colors.accent, fontWeight: '600', marginBottom: 4 },
  bio: { fontSize: 12, color: colors.textPrimary, lineHeight: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  modalSheet: { backgroundColor: colors.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '85%' },
  modalContent: { padding: 20, paddingBottom: 40 },
  modalTitle: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, marginBottom: 16 },
  filterLabel: { fontSize: 14, fontWeight: '600', color: colors.textPrimary, marginTop: 18, marginBottom: 8 },
  cityInput: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
  },
  optionRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  radio: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: colors.textMuted, marginRight: 10 },
  radioSelected: { borderColor: colors.accent, backgroundColor: colors.accent },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkboxMark: { color: colors.white, fontSize: 12, fontWeight: '700' },
  optionLabel: { fontSize: 15, color: colors.textPrimary },
  applyButton: { backgroundColor: colors.accent, borderRadius: 10, padding: 16, alignItems: 'center', marginTop: 24 },
  applyButtonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
  resetLink: { padding: 14, alignItems: 'center' },
  resetLinkText: { color: colors.textSecondary, fontSize: 14 },
  quickChatContainer: { flex: 1, backgroundColor: colors.bg },
  quickChatHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    paddingTop: 50,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  quickChatTitle: { fontSize: 18, fontWeight: '700', color: colors.textPrimary },
  quickChatList: { padding: 14, flexGrow: 1 },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8 },
  bubbleMine: { backgroundColor: colors.accent, alignSelf: 'flex-end' },
  bubbleTheirs: { backgroundColor: colors.border, alignSelf: 'flex-start' },
  bubbleTextMine: { color: colors.white, fontSize: 15 },
  bubbleTextTheirs: { color: colors.textPrimary, fontSize: 15 },
  quickChatInputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  quickChatInput: {
    flex: 1,
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    maxHeight: 100,
    fontSize: 15,
  },
  quickChatSend: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  quickChatSendText: { color: colors.white, fontWeight: '600' },
  buttonDisabledOpacity: { opacity: 0.5 },
  imageBubble: { padding: 4 },
  chatImage: { width: 200, height: 200, borderRadius: 10, backgroundColor: colors.surface },
  chatImageLoading: { alignItems: 'center', justifyContent: 'center' },
  attachButton: { padding: 8, marginRight: 4, marginBottom: 2 },
  previewOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  previewClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: { width: '100%', height: '80%' },
});
