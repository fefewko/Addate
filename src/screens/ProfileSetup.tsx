// src/screens/ProfileSetup.tsx
//
// Перед использованием установи зависимость для выбора фото:
//   npx expo install expo-image-picker
//
import React, { useCallback, useEffect, useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  ScrollView,
  Image,
  Alert,
} from 'react-native';
import { useNavigation } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';
import { uploadAvatarPhoto } from '../lib/avatarUpload';
import { colors } from '../lib/theme';
import {
  SOBRIETY_OPTIONS,
  SUBSTANCE_OPTIONS,
  type SobrietyStatus,
} from '../lib/profileDisplay';
import DateOfBirthInput from '../ui/DateOfBirthInput';
import {
  EMPTY_PARTS,
  isoToParts,
  partsToIso,
  validateBirthDateParts,
  type BirthDateParts,
} from '../lib/date';

// Разбор даты, валидация и преобразование в ISO живут в src/lib/date.ts:
// после появления ввода на экране регистрации держать вторую копию означало
// бы гарантированный расхожд между двумя экранами.

export default function ProfileSetup() {
  const navigation = useNavigation<RootNavigation>();

  const [displayName, setDisplayName] = useState('');
  // Дата приходит с экрана регистрации уже заполненной. Здесь она
  // показывается и остаётся доступной для правки, но отдельным обязательным
  // вопросом не выглядит: два разных интерфейса ввода даты подряд сбивали бы
  // с толку и предлагали бы ввести одно и то же дважды.
  const [birth, setBirth] = useState<BirthDateParts>(EMPTY_PARTS);
  const [birthError, setBirthError] = useState<string | null>(null);
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const [sobrietyStatus, setSobrietyStatus] = useState<SobrietyStatus>('ne_ukazano');
  const [substances, setSubstances] = useState<string[]>([]);
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  // Фото, уже загруженное в базу. Нужно, чтобы правка отклонённой анкеты
  // не стирала его: если пользователь не выбрал новое, photo_url должен
  // остаться прежним, а не превратиться в null.
  const [savedPhotoUrl, setSavedPhotoUrl] = useState<string | null>(null);
  // Дата, которая уже была в базе. Нужна, чтобы отличить «пользователь не
  // трогал поле» от «поле очистил»: в первом случае повторно требовать ввод
  // незачем, во втором — незачем молча затирать дату.
  const [savedBirthDate, setSavedBirthDate] = useState<string | null>(null);
  const [editingExisting, setEditingExisting] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Экран открывается в двух случаях: первая регистрация (анкеты ещё нет)
  // и повторная правка после отклонения модератором (анкета уже заполнена).
  // Без загрузки существующих данных форма показывалась пустой, а сохранение
  // затирало имя, дату, город, фото и «о себе» значениями null.
  useEffect(() => {
    let active = true;

    async function loadExisting() {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from('profiles')
        .select('display_name, birth_date, city, bio, sobriety_status, substance_type, photo_url')
        .eq('id', user.id)
        .maybeSingle();

      if (!active || !data) return;

      setDisplayName(data.display_name || '');
      setBirth(isoToParts(data.birth_date));
      setSavedBirthDate(data.birth_date || null);
      setCity(data.city || '');
      setBio(data.bio || '');
      setSobrietyStatus((data.sobriety_status as SobrietyStatus) || 'ne_ukazano');
      setSubstances(data.substance_type || []);
      setSavedPhotoUrl(data.photo_url || null);
      setEditingExisting(true);
    }

    loadExisting();
    return () => {
      active = false;
    };
  }, []);

  function toggleSubstance(value: string) {
    setSubstances((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  }

  async function pickPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Нужен доступ', 'Разрешите доступ к галерее, чтобы выбрать фото.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (!result.canceled && result.assets?.[0]?.uri) {
      setPhotoUri(result.assets[0].uri);
    }
  }

  async function uploadPhoto(userId: string): Promise<string | null> {
    if (!photoUri) return null;
    return uploadAvatarPhoto(userId, photoUri, 'avatar');
  }

  async function handleSave() {
    setError(null);

    if (!displayName.trim()) {
      setError('Укажите имя.');
      return;
    }

    // Дата могла прийти с экрана регистрации уже заполненной. Если пользователь
    // её не трогал, не требуем ввода; если менял — проверяем как обычно.
    const birthProblem = validateBirthDateParts(birth);
    const birthWasEmpty = birth.day === '' && birth.month === '' && birth.year === '';
    if (birthProblem && !birthWasEmpty) {
      setBirthError(birthProblem);
      return;
    }
    if (birthWasEmpty && !savedBirthDate) {
      setBirthError(validateBirthDateParts(birth));
      return;
    }
    setBirthError(null);

    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      setError('Сессия истекла, войдите заново.');
      setLoading(false);
      navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
      return;
    }

    // Если новое фото не выбрано, сохраняем прежнее. Раньше здесь всегда писался
    // photoUrl из локального photoUri, который при правке отклонённой анкеты
    // равен null, — и фото молча пропадало из анкеты.
    let photoUrl: string | null = savedPhotoUrl;
    if (photoUri) {
      try {
        photoUrl = await uploadPhoto(user.id);
      } catch (e: any) {
        setError('Не удалось загрузить фото: ' + e.message);
        setLoading(false);
        return;
      }
    }

    // Если поле даты не трогали, сохраняем прежнее значение. Так же, как с
    // фото: иначе правка анкеты молча затирала бы дату, полученную при
    // регистрации.
    const isoBirthDate = partsToIso(birth) ?? savedBirthDate;

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim(),
        birth_date: isoBirthDate,
        city: city.trim() || null,
        bio: bio.trim() || null,
        sobriety_status: sobrietyStatus,
        substance_type: substances.length > 0 ? substances : null,
        photo_url: photoUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('id', user.id);

    setLoading(false);

    if (updateError) {
      setError('Не удалось сохранить анкету: ' + updateError.message);
      return;
    }

    setSavedBirthDate(isoBirthDate);
    navigation.reset({ index: 0, routes: [{ name: 'ModerationPending' }] });
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Расскажите о себе</Text>

      <TouchableOpacity style={styles.photoPicker} onPress={pickPhoto}>
        {photoUri || savedPhotoUrl ? (
          <Image source={{ uri: photoUri || savedPhotoUrl || undefined }} style={styles.photo} />
        ) : (
          <Text style={styles.photoPlaceholder}>Добавить фото</Text>
        )}
      </TouchableOpacity>

      {editingExisting && savedPhotoUrl && !photoUri && (
        <Text style={styles.photoHint}>Фото уже загружено — нажмите, чтобы заменить</Text>
      )}

      <Text style={styles.label}>Имя</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textFaint}
        placeholder="Как вас называть"
        value={displayName}
        onChangeText={setDisplayName}
      />

      <Text style={styles.label}>Дата рождения</Text>
      <DateOfBirthInput
        value={birth}
        onChange={(next) => {
          setBirth(next);
          if (birthError) setBirthError(null);
        }}
        error={birthError}
      />

      <Text style={styles.label}>Город</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textFaint}
        placeholder="Например, Москва"
        value={city}
        onChangeText={setCity}
      />

      <TextInput
        style={[styles.input, styles.textArea]}
        placeholderTextColor={colors.textFaint}
        placeholder="О себе (необязательно)"
        value={bio}
        onChangeText={setBio}
        multiline
        numberOfLines={4}
      />

      <Text style={styles.sectionLabel}>Статус трезвости</Text>
      {SOBRIETY_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={styles.radioRow}
          onPress={() => setSobrietyStatus(opt.value)}
        >
          <View style={[styles.radio, sobrietyStatus === opt.value && styles.radioSelected]} />
          <Text style={styles.radioLabel}>{opt.label}</Text>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionLabel}>Что употребляли (необязательно, можно несколько)</Text>
      {SUBSTANCE_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={styles.radioRow}
          onPress={() => toggleSubstance(opt.value)}
        >
          <View
            style={[
              styles.checkbox,
              substances.includes(opt.value) && styles.checkboxChecked,
            ]}
          >
            {substances.includes(opt.value) && <Text style={styles.checkboxMark}>✓</Text>}
          </View>
          <Text style={styles.radioLabel}>{opt.label}</Text>
        </TouchableOpacity>
      ))}

      {error && <Text style={styles.error}>{error}</Text>}

      <TouchableOpacity
        style={[styles.button, loading && styles.buttonDisabled]}
        onPress={handleSave}
        disabled={loading}
      >
        {loading ? (
          <ActivityIndicator color={colors.white} />
        ) : (
          <Text style={styles.buttonText}>Сохранить и продолжить</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingBottom: 48, backgroundColor: colors.bg },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 20, textAlign: 'center', color: colors.textPrimary },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, marginLeft: 2 },
  photoPicker: {
    alignSelf: 'center',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    overflow: 'hidden',
  },
  photo: { width: 120, height: 120 },
  photoPlaceholder: { color: colors.textMuted, fontSize: 13, textAlign: 'center', paddingHorizontal: 8 },
  photoHint: { color: colors.textFaint, fontSize: 12, textAlign: 'center', marginTop: -8, marginBottom: 20 },
  input: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  textArea: { height: 90, textAlignVertical: 'top' },
  sectionLabel: { fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 8, color: colors.textPrimary },
  radioRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.textMuted,
    marginRight: 10,
  },
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
  radioLabel: { fontSize: 15, color: colors.textPrimary },
  error: { color: colors.danger, marginVertical: 12, fontSize: 14 },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
});
