// src/screens/Profile.tsx
import React, { useCallback, useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { View, Text, TextInput, TouchableOpacity, ScrollView, Image, ActivityIndicator, StyleSheet, Modal, Dimensions } from 'react-native';
import { appAlert } from '../lib/alert';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { supabase } from '../lib/supabase';
import { uploadAvatarPhoto, deleteAvatarPhoto } from '../lib/avatarUpload';
import LoadError from '../ui/LoadError';
import { colors } from '../lib/theme';
import {
  SOBRIETY_OPTIONS,
  SUBSTANCE_OPTIONS,
  type SobrietyStatus,
} from '../lib/profileDisplay';
import DatePartsInput from '../ui/DatePartsInput';
import {
  EMPTY_PARTS,
  isoToParts,
  partsToIso,
  validatePastDateParts,
  type BirthDateParts,
} from '../lib/date';

const screenWidth = Dimensions.get('window').width;

const MAX_ADDITIONAL_PHOTOS = 4;

function sameParts(a: BirthDateParts, b: BirthDateParts): boolean {
  return a.day === b.day && a.month === b.month && a.year === b.year;
}

type MyProfileRow = {
  display_name: string | null;
  birth_date: string | null;
  city: string | null;
  height_cm: number | null;
  weight_kg: number | null;
  bio: string | null;
  sobriety_status: SobrietyStatus | null;
  sobriety_since: string | null;
  substance_type: string[] | null;
  photo_url: string | null;
  additional_photos: string[] | null;
};

export default function Profile() {
  const navigation = useNavigation<RootNavigation>();

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  // Дата рождения больше не редактируется пользователем: она проставляется при
  // регистрации (проверка возраста 18+) и ниже используется как нижняя граница
  // для даты начала трезвости. Смена имени у пользователя отключена.
  const [birth, setBirth] = useState<BirthDateParts>(EMPTY_PARTS);

  const [city, setCity] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [bio, setBio] = useState('');
  const [sobrietyStatus, setSobrietyStatus] = useState<SobrietyStatus>('ne_ukazano');
  const [sobrietySince, setSobrietySince] = useState<BirthDateParts>(EMPTY_PARTS);
  const [sobrietySinceError, setSobrietySinceError] = useState<string | null>(null);
  const [substances, setSubstances] = useState<string[]>([]);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [additionalPhotos, setAdditionalPhotos] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [original, setOriginal] = useState<{
    city: string;
    heightCm: string;
    weightKg: string;
    bio: string;
    sobrietyStatus: SobrietyStatus;
    sobrietySince: BirthDateParts;
    substances: string[];
  } | null>(null);

  const loadProfile = useCallback(async () => {
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

    setUserId(user.id);
    setEmail(user.email || '');

    const { data, error } = await supabase
      .rpc('my_profile')
      .maybeSingle();

    setLoading(false);

    if (error) {
      setLoadError('Не удалось загрузить профиль: ' + error.message);
      return;
    }

    const profile = data as MyProfileRow | null;
    if (!profile) {
      setLoadError('Анкета не найдена.');
      return;
    }

    setBirth(isoToParts(profile.birth_date));
    setCity(profile.city || '');
    setHeightCm(profile.height_cm ? String(profile.height_cm) : '');
    setWeightKg(profile.weight_kg ? String(profile.weight_kg) : '');
    setBio(profile.bio || '');
    setSobrietyStatus(profile.sobriety_status || 'ne_ukazano');
    setSobrietySince(isoToParts(profile.sobriety_since));
    setSubstances(profile.substance_type || []);
    setPhotoUrl(profile.photo_url);
    setAdditionalPhotos(profile.additional_photos || []);

    setOriginal({
      city: profile.city || '',
      heightCm: profile.height_cm ? String(profile.height_cm) : '',
      weightKg: profile.weight_kg ? String(profile.weight_kg) : '',
      bio: profile.bio || '',
      sobrietyStatus: profile.sobriety_status || 'ne_ukazano',
      sobrietySince: isoToParts(profile.sobriety_since),
      substances: profile.substance_type || [],
    });
  }, []);

  const isDirty =
    original !== null &&
    (city !== original.city ||
      heightCm !== original.heightCm ||
      weightKg !== original.weightKg ||
      bio !== original.bio ||
      sobrietyStatus !== original.sobrietyStatus ||
      !sameParts(sobrietySince, original.sobrietySince) ||
      substances.length !== original.substances.length ||
      substances.some((s) => !original.substances.includes(s)));

  useFocusEffect(
    useCallback(() => {
      loadProfile();
    }, [loadProfile])
  );

  function toggleSubstance(value: string) {
    setSubstances((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value]
    );
  }

  async function handleChangeMainPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      appAlert.alert('Нужен доступ', 'Разрешите доступ к галерее.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets?.[0]?.uri || !userId) return;

    setUploadingPhoto(true);
    try {
      const url = await uploadAvatarPhoto(userId, result.assets[0].uri, 'avatar');
      if (url) {
        await supabase.from('profiles').update({ photo_url: url }).eq('id', userId);
        setPhotoUrl(url);
      }
    } catch (e: any) {
      appAlert.alert('Ошибка', 'Не удалось загрузить фото: ' + e.message);
    }
    setUploadingPhoto(false);
  }

  async function handleAddPhoto() {
    if (additionalPhotos.length >= MAX_ADDITIONAL_PHOTOS) {
      appAlert.alert('Лимит фото', `Можно добавить не больше ${MAX_ADDITIONAL_PHOTOS} дополнительных фото.`);
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      appAlert.alert('Нужен доступ', 'Разрешите доступ к галерее.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsEditing: true,
      aspect: [3, 4],
    });

    if (result.canceled || !result.assets?.[0]?.uri || !userId) return;

    setUploadingPhoto(true);
    try {
      const fileName = `extra_${Date.now()}`;
      const url = await uploadAvatarPhoto(userId, result.assets[0].uri, fileName);
      if (url) {
        const updated = [...additionalPhotos, url];
        await supabase.from('profiles').update({ additional_photos: updated }).eq('id', userId);
        setAdditionalPhotos(updated);
      }
    } catch (e: any) {
      appAlert.alert('Ошибка', 'Не удалось загрузить фото: ' + e.message);
    }
    setUploadingPhoto(false);
  }

  function handleRemovePhoto(url: string) {
    appAlert.alert('Удалить фото?', '', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          if (!userId) return;
          const updated = additionalPhotos.filter((p) => p !== url);
          const { error } = await supabase
            .from('profiles')
            .update({ additional_photos: updated })
            .eq('id', userId);

          if (error) {
            appAlert.alert('Ошибка', 'Не удалось убрать фото: ' + error.message);
            return;
          }

          setAdditionalPhotos(updated);
          // Ссылка убрана из анкеты, но сам файл остался бы в бакете навсегда.
          await deleteAvatarPhoto(url);
        },
      },
    ]);
  }

  async function handleSave() {
    if (!userId) return;

    const sinceProblem = validatePastDateParts(sobrietySince, {
      notBeforeIso: partsToIso(birth),
    });
    if (sinceProblem) {
      setSobrietySinceError(sinceProblem);
      return;
    }
    setSobrietySinceError(null);

    setSaving(true);

    const { error } = await supabase
      .from('profiles')
      .update({
        city: city.trim() || null,
        height_cm: heightCm ? parseInt(heightCm, 10) : null,
        weight_kg: weightKg ? parseInt(weightKg, 10) : null,
        bio: bio.trim() || null,
        sobriety_status: sobrietyStatus,
        sobriety_since: partsToIso(sobrietySince),
        substance_type: substances.length > 0 ? substances : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    setSaving(false);

    if (error) {
      appAlert.alert('Ошибка', 'Не удалось сохранить: ' + error.message);
      return;
    }

    setOriginal({
      city,
      heightCm,
      weightKg,
      bio,
      sobrietyStatus,
      sobrietySince,
      substances,
    });
    appAlert.alert('Сохранено', 'Изменения профиля сохранены.');
  }

  React.useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity onPress={() => navigation.navigate('Settings')} style={{ paddingHorizontal: 12 }}>
          <Ionicons name="settings-outline" size={22} color={colors.textPrimary} />
        </TouchableOpacity>
      ),
    });
  }, [navigation]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.accent} />
      </View>
    );
  }

  if (loadError) {
    return <LoadError message={loadError} onRetry={loadProfile} />;
  }

  return (
    <>
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity style={styles.photoPicker} onPress={handleChangeMainPhoto} disabled={uploadingPhoto}>
        {photoUrl ? (
          <Image source={{ uri: photoUrl }} style={styles.photo} />
        ) : (
          <View style={[styles.photo, styles.photoPlaceholder]}>
            <Text style={styles.photoPlaceholderText}>Добавить фото</Text>
          </View>
        )}
        {uploadingPhoto && (
          <View style={styles.photoOverlay}>
            <ActivityIndicator color={colors.white} />
          </View>
        )}
        {photoUrl && !uploadingPhoto && (
          <TouchableOpacity
            style={styles.viewPhotoButton}
            onPress={() => {
              setViewerIndex(0);
              setViewerVisible(true);
            }}
          >
            <Ionicons name="eye" size={16} color={colors.white} />
          </TouchableOpacity>
        )}
      </TouchableOpacity>
      <Text style={styles.changePhotoHint}>Нажмите на фото, чтобы изменить, на значок глаза — чтобы посмотреть</Text>

      <Text style={styles.label}>Email</Text>
      <View style={styles.readOnlyField}>
        <Text style={styles.readOnlyText}>{email}</Text>
      </View>

      <Text style={styles.label}>Город</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor={colors.textFaint}
        placeholder="Например, Москва"
        value={city}
        onChangeText={setCity}
      />

      <View style={styles.row}>
        <View style={styles.halfField}>
          <Text style={styles.label}>Рост, см</Text>
          <TextInput
            style={styles.input}
            placeholderTextColor={colors.textFaint}
            placeholder="175"
            value={heightCm}
            onChangeText={(v) => setHeightCm(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            maxLength={3}
          />
        </View>
        <View style={styles.halfField}>
          <Text style={styles.label}>Вес, кг</Text>
          <TextInput
            style={styles.input}
            placeholderTextColor={colors.textFaint}
            placeholder="70"
            value={weightKg}
            onChangeText={(v) => setWeightKg(v.replace(/\D/g, ''))}
            keyboardType="number-pad"
            maxLength={3}
          />
        </View>
      </View>

      <Text style={styles.label}>О себе</Text>
      <TextInput
        style={[styles.input, styles.textArea]}
        placeholderTextColor={colors.textFaint}
        placeholder="Расскажите о себе"
        value={bio}
        onChangeText={setBio}
        multiline
        numberOfLines={4}
      />

      <Text style={styles.sectionLabel}>Статус трезвости</Text>
      {SOBRIETY_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={styles.optionRow}
          onPress={() => setSobrietyStatus(opt.value)}
        >
          <View style={[styles.radio, sobrietyStatus === opt.value && styles.radioSelected]} />
          <Text style={styles.optionLabel}>{opt.label}</Text>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionLabel}>Дата начала трезвости</Text>
      <Text style={styles.dateHint}>
        Необязательно. Другие увидят её, только если в «Моей приватности» включён
        показ даты трезвости.
      </Text>
      <DatePartsInput
        value={sobrietySince}
        onChange={(next) => {
          setSobrietySince(next);
          if (sobrietySinceError) setSobrietySinceError(null);
        }}
        error={sobrietySinceError}
        labels={{
          day: 'День начала трезвости',
          month: 'Месяц начала трезвости',
          year: 'Год начала трезвости',
        }}
      />

      <Text style={styles.sectionLabel}>Что употребляли</Text>
      {SUBSTANCE_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.value}
          style={styles.optionRow}
          onPress={() => toggleSubstance(opt.value)}
        >
          <View style={[styles.checkbox, substances.includes(opt.value) && styles.checkboxChecked]}>
            {substances.includes(opt.value) && <Text style={styles.checkboxMark}>✓</Text>}
          </View>
          <Text style={styles.optionLabel}>{opt.label}</Text>
        </TouchableOpacity>
      ))}

      <Text style={styles.sectionLabel}>
        Дополнительные фото ({additionalPhotos.length}/{MAX_ADDITIONAL_PHOTOS})
      </Text>
      <View style={styles.photosGrid}>
        {additionalPhotos.map((url) => (
          <TouchableOpacity
            key={url}
            onPress={() => {
              const combined = [photoUrl, ...additionalPhotos].filter((p): p is string => !!p);
              setViewerIndex(combined.indexOf(url));
              setViewerVisible(true);
            }}
            onLongPress={() => handleRemovePhoto(url)}
          >
            <Image source={{ uri: url }} style={styles.thumb} />
          </TouchableOpacity>
        ))}
        {additionalPhotos.length < MAX_ADDITIONAL_PHOTOS && (
          <TouchableOpacity
            style={[styles.thumb, styles.thumbAdd]}
            onPress={handleAddPhoto}
            disabled={uploadingPhoto}
          >
            <Text style={styles.thumbAddText}>+</Text>
          </TouchableOpacity>
        )}
      </View>
      <Text style={styles.hint}>Долгое нажатие на фото — удалить</Text>

      {isDirty && (
        <TouchableOpacity
          style={[styles.saveButton, saving && styles.buttonDisabled]}
          onPress={handleSave}
          disabled={saving}
        >
          {saving ? <ActivityIndicator color={colors.white} /> : <Text style={styles.saveButtonText}>Сохранить изменения</Text>}
        </TouchableOpacity>
      )}
    </ScrollView>

    <PhotoViewerModal
      visible={viewerVisible}
      photos={[photoUrl, ...additionalPhotos].filter((p): p is string => !!p)}
      startIndex={viewerIndex}
      onClose={() => setViewerVisible(false)}
    />
    </>
  );
}

function PhotoViewerModal({
  visible,
  photos,
  startIndex,
  onClose,
}: {
  visible: boolean;
  photos: string[];
  startIndex: number;
  onClose: () => void;
}) {
  const scrollRef = React.useRef<ScrollView>(null);
  const [currentIndex, setCurrentIndex] = React.useState(startIndex);

  React.useEffect(() => {
    if (visible) {
      setCurrentIndex(startIndex);
      setTimeout(() => {
        scrollRef.current?.scrollTo({ x: startIndex * screenWidth, animated: false });
      }, 50);
    }
  }, [visible, startIndex]);

  if (photos.length === 0) return null;

  return (
    <Modal visible={visible} animationType="fade" transparent={false} onRequestClose={onClose}>
      <View style={styles.viewerContainer}>
        <TouchableOpacity style={styles.viewerClose} onPress={onClose}>
          <Ionicons name="close" size={30} color={colors.white} />
        </TouchableOpacity>
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(e) => {
            const page = Math.round(e.nativeEvent.contentOffset.x / screenWidth);
            setCurrentIndex(page);
          }}
        >
          {photos.map((url, i) => (
            <View key={i} style={{ width: screenWidth, justifyContent: 'center', alignItems: 'center' }}>
              <Image source={{ uri: url }} style={styles.viewerImage} resizeMode="contain" />
            </View>
          ))}
        </ScrollView>
        {photos.length > 1 && (
          <Text style={styles.viewerCounter}>
            {currentIndex + 1} / {photos.length}
          </Text>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingBottom: 60, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.bg },
  photoPicker: {
    alignSelf: 'center',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: 120, height: 120 },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: colors.textFaint, fontSize: 13, textAlign: 'center', paddingHorizontal: 8 },
  photoOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewPhotoButton: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerContainer: { flex: 1, backgroundColor: '#000', justifyContent: 'center' },
  viewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: { width: screenWidth, height: '100%' },
  viewerCounter: {
    position: 'absolute',
    bottom: 40,
    alignSelf: 'center',
    color: colors.white,
    fontSize: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  changePhotoHint: { textAlign: 'center', color: colors.textFaint, fontSize: 12, marginTop: 8, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 6, marginLeft: 2 },
  readOnlyField: {
    backgroundColor: colors.surface,
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    opacity: 0.6,
  },
  readOnlyText: { color: colors.textSecondary, fontSize: 16 },
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
  row: { flexDirection: 'row', gap: 12 },
  halfField: { flex: 1 },
  sectionLabel: { fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 8, color: colors.textPrimary },
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
  photosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  thumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: colors.surface },
  thumbAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, borderStyle: 'dashed' },
  thumbAddText: { fontSize: 28, color: colors.textFaint },
  hint: { fontSize: 12, color: colors.textFaint, marginTop: 8, marginBottom: 8 },
  dateHint: { fontSize: 12, color: colors.textFaint, marginTop: -2, marginBottom: 8, lineHeight: 16 },
  saveButton: { backgroundColor: colors.accent, borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 20 },
  buttonDisabled: { opacity: 0.6 },
  saveButtonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
});
