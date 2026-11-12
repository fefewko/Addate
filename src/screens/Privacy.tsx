// src/screens/Privacy.tsx
//
// «Моя приватность» — отдельный раздел настроек. Раньше приватность
// подразумевалась сама собой, а анкета целиком была видна всем. Теперь
// пользователь сам решает, какие чувствительные поля показывать.
//
// Все переключатели сохраняются сразу: отдельной кнопки «Сохранить» здесь нет,
// как и в остальных настройках. Значения по умолчанию — «скрыто». Маскирование
// выполняет сервер (public.profile_cards / feed_profiles), поэтому выключенный
// тумблер скрывает поле не только в интерфейсе, но и в ответах API.

import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  Switch,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import { appAlert } from '../lib/alert';
import LoadError from '../ui/LoadError';
import { colors } from '../lib/theme';

type PrivacySettings = {
  profile_visible: boolean;
  profile_hidden: boolean;
  show_age: boolean;
  show_city: boolean;
  show_sobriety_since: boolean;
  show_substance_type: boolean;
  show_photos: boolean;
  show_online_status: boolean;
  show_last_active: boolean;
};

type PrivacyKey = keyof PrivacySettings;

const DEFAULT_SETTINGS: PrivacySettings = {
  profile_visible: true,
  profile_hidden: false,
  show_age: false,
  show_city: false,
  show_sobriety_since: false,
  show_substance_type: false,
  show_photos: false,
  show_online_status: false,
  show_last_active: false,
};

const FIELD_ROWS: { key: PrivacyKey; label: string; hint: string }[] = [
  {
    key: 'show_age',
    label: 'Возраст',
    hint: 'Показывать другим возраст. Сама дата рождения не показывается.',
  },
  {
    key: 'show_city',
    label: 'Город',
    hint: 'Показывать город в анкете и списке анкет.',
  },
  {
    key: 'show_sobriety_since',
    label: 'Дата трезвости',
    hint: 'Показывать дату начала трезвости.',
  },
  {
    key: 'show_substance_type',
    label: 'Тип зависимости',
    hint: 'Показывать, какие вещества вы употребляли.',
  },
  {
    key: 'show_photos',
    label: 'Фотографии',
    hint: 'Показывать основное и дополнительные фото.',
  },
  {
    key: 'show_online_status',
    label: 'Онлайн-статус',
    hint: 'Показывать зелёный индикатор «В сети».',
  },
  {
    key: 'show_last_active',
    label: 'Последняя активность',
    hint: 'Показывать, когда вы последний раз заходили.',
  },
];

const SHOW_KEYS: PrivacyKey[] = FIELD_ROWS.map((row) => row.key);

export default function Privacy() {
  const [settings, setSettings] = useState<PrivacySettings>(DEFAULT_SETTINGS);
  const [userId, setUserId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<PrivacyKey | 'all' | null>(null);
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

    const { data, error } = await supabase
      .from('profiles')
      .select(
        'profile_visible, profile_hidden, show_age, show_city, show_sobriety_since, show_substance_type, show_photos, show_online_status, show_last_active'
      )
      .eq('id', user.id)
      .maybeSingle();

    setLoading(false);

    if (error) {
      setLoadError('Не удалось загрузить настройки приватности: ' + error.message);
      return;
    }
    if (!data) {
      setLoadError('Анкета не найдена.');
      return;
    }

    setUserId(user.id);
    setSettings({
      profile_visible: data.profile_visible ?? DEFAULT_SETTINGS.profile_visible,
      profile_hidden: data.profile_hidden ?? DEFAULT_SETTINGS.profile_hidden,
      show_age: data.show_age ?? DEFAULT_SETTINGS.show_age,
      show_city: data.show_city ?? DEFAULT_SETTINGS.show_city,
      show_sobriety_since: data.show_sobriety_since ?? DEFAULT_SETTINGS.show_sobriety_since,
      show_substance_type: data.show_substance_type ?? DEFAULT_SETTINGS.show_substance_type,
      show_photos: data.show_photos ?? DEFAULT_SETTINGS.show_photos,
      show_online_status: data.show_online_status ?? DEFAULT_SETTINGS.show_online_status,
      show_last_active: data.show_last_active ?? DEFAULT_SETTINGS.show_last_active,
    });
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  async function savePatch(patch: Partial<PrivacySettings>, key: PrivacyKey | 'all') {
    if (!userId) return;

    const previous = settings;
    setSettings((current) => ({ ...current, ...patch }));
    setSavingKey(key);

    const { error } = await supabase.from('profiles').update(patch).eq('id', userId);

    setSavingKey(null);

    if (error) {
      setSettings(previous);
      appAlert.alert('Ошибка', 'Не удалось сохранить настройку: ' + error.message);
    }
  }

  function toggle(key: PrivacyKey, value: boolean) {
    savePatch({ [key]: value }, key);
  }

  function hideAllFields() {
    const patch = SHOW_KEYS.reduce(
      (acc, key) => ({ ...acc, [key]: false }),
      {} as Partial<PrivacySettings>
    );
    savePatch(patch, 'all');
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

  const hidden = settings.profile_hidden;
  const busy = savingKey !== null;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.introCard}>
        <Text style={styles.introTitle}>По умолчанию всё скрыто</Text>
        <Text style={styles.introText}>
          Другие видят только имя и «О себе». Возраст, город, дата трезвости,
          тип зависимости, фотографии, онлайн-статус и последняя активность
          скрыты, пока вы не включите их сами.
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Видимость анкеты</Text>

      <View style={[styles.row, hidden && styles.rowDisabled]}>
        <View style={styles.rowText}>
          <Text style={styles.rowLabel}>Показывать в ленте и поиске</Text>
          <Text style={styles.rowHint}>
            Если выключить, анкета не появится в ленте и поиске. Совпадения и
            переписка сохранятся.
          </Text>
        </View>
        <Switch
          value={settings.profile_visible}
          onValueChange={(value) => toggle('profile_visible', value)}
          disabled={busy || hidden}
          trackColor={{ false: colors.border, true: colors.accent }}
        />
      </View>

      <View style={[styles.row, styles.dangerRow]}>
        <View style={styles.rowText}>
          <Text style={styles.dangerLabel}>Полностью скрыть анкету</Text>
          <Text style={styles.rowHint}>
            Анкета исчезнет из ленты, поиска и лайков. Даже при открытии по
            прямой ссылке другие увидят только пометку «Анкета скрыта».
          </Text>
        </View>
        <Switch
          value={settings.profile_hidden}
          onValueChange={(value) => toggle('profile_hidden', value)}
          disabled={busy}
          trackColor={{ false: colors.border, true: colors.danger }}
        />
      </View>

      <Text style={styles.sectionTitle}>Что показывать другим</Text>

      {FIELD_ROWS.map((row) => (
        <View key={row.key} style={[styles.row, hidden && styles.rowDisabled]}>
          <View style={styles.rowText}>
            <Text style={styles.rowLabel}>{row.label}</Text>
            <Text style={styles.rowHint}>{row.hint}</Text>
          </View>
          <Switch
            value={settings[row.key]}
            onValueChange={(value) => toggle(row.key, value)}
            disabled={busy || hidden}
            trackColor={{ false: colors.border, true: colors.accent }}
          />
        </View>
      ))}

      {hidden && (
        <Text style={styles.hiddenHint}>
          Пока анкета полностью скрыта, эти настройки не действуют. Выключите
          «Полностью скрыть анкету», чтобы они снова заработали.
        </Text>
      )}

      <TouchableOpacity
        style={[styles.hideAllButton, (busy || hidden) && styles.buttonDisabled]}
        onPress={hideAllFields}
        disabled={busy || hidden}
      >
        <Text style={styles.hideAllText}>Скрыть все поля</Text>
      </TouchableOpacity>

      <Text style={styles.footerHint}>
        Изменения сохраняются сразу. Скрытые поля не отдаются другим
        пользователям сервером — их нельзя увидеть даже через API.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  introCard: {
    backgroundColor: colors.surface,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
  },
  introTitle: { color: colors.textPrimary, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  introText: { color: colors.textSecondary, fontSize: 13, lineHeight: 19 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.textFaint,
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: colors.border,
  },
  rowDisabled: { opacity: 0.45 },
  dangerRow: { borderColor: colors.dangerBg },
  rowText: { flex: 1, marginRight: 12 },
  rowLabel: { color: colors.textPrimary, fontSize: 14, fontWeight: '600', marginBottom: 3 },
  dangerLabel: { color: colors.danger, fontSize: 14, fontWeight: '600', marginBottom: 3 },
  rowHint: { color: colors.textFaint, fontSize: 12, lineHeight: 16 },
  hiddenHint: {
    color: colors.dangerLight,
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
    marginBottom: 4,
  },
  hideAllButton: {
    marginTop: 18,
    backgroundColor: colors.surface,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: colors.border,
  },
  buttonDisabled: { opacity: 0.45 },
  hideAllText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  footerHint: { color: colors.textFaint, fontSize: 12, lineHeight: 17, marginTop: 18 },
});
