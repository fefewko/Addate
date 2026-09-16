// src/screens/Profile.tsx
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  Image,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as ImagePicker from 'expo-image-picker';
import { supabase } from '../lib/supabase';

type SobrietyStatus = 'trezv' | 'v_sryve' | 'ne_ukazano';

const SOBRIETY_OPTIONS: { value: SobrietyStatus; label: string }[] = [
  { value: 'trezv', label: 'Чист(а)' },
  { value: 'v_sryve', label: 'Всё сложно' },
  { value: 'ne_ukazano', label: 'Не указывать' },
];

const SUBSTANCE_OPTIONS = [
  { value: 'alcohol', label: 'Алкоголь' },
  { value: 'opioids', label: 'Опиоиды' },
  { value: 'stimulants', label: 'Стимуляторы' },
  { value: 'cannabis', label: 'Каннабис' },
  { value: 'other', label: 'Другое' },
];

const MAX_ADDITIONAL_PHOTOS = 4;

export default function Profile() {
  const navigation = useNavigation<any>();

  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState('');

  const [city, setCity] = useState('');
  const [heightCm, setHeightCm] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [bio, setBio] = useState('');
  const [sobrietyStatus, setSobrietyStatus] = useState<SobrietyStatus>('ne_ukazano');
  const [substances, setSubstances] = useState<string[]>([]);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [additionalPhotos, setAdditionalPhotos] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const loadProfile = useCallback(async () => {
    setLoading(true);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    setUserId(user.id);
    setEmail(user.email || '');

    const { data, error } = await supabase
      .from('profiles')
      .select(
        'city, height_cm, weight_kg, bio, sobriety_status, substance_type, photo_url, additional_photos'
      )
      .eq('id', user.id)
      .maybeSingle();

    setLoading(false);

    if (error || !data) return;

    setCity(data.city || '');
    setHeightCm(data.height_cm ? String(data.height_cm) : '');
    setWeightKg(data.weight_kg ? String(data.weight_kg) : '');
    setBio(data.bio || '');
    setSobrietyStatus(data.sobriety_status || 'ne_ukazano');
    setSubstances(data.substance_type || []);
    setPhotoUrl(data.photo_url);
    setAdditionalPhotos(data.additional_photos || []);
  }, []);

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

  async function uploadImage(uri: string, fileName: string): Promise<string | null> {
    const response = await fetch(uri);
    const arrayBuffer = await response.arrayBuffer();
    const fileExt = uri.split('.').pop() || 'jpg';
    const filePath = `${userId}/${fileName}.${fileExt}`;

    const { error } = await supabase.storage
      .from('avatars')
      .upload(filePath, arrayBuffer, { contentType: `image/${fileExt}`, upsert: true });

    if (error) throw new Error(error.message);

    const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
    // добавляем метку времени, чтобы избежать кэширования старой фотографии по тому же пути
    return `${data.publicUrl}?t=${Date.now()}`;
  }

  async function handleChangeMainPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Нужен доступ', 'Разрешите доступ к галерее.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
      allowsEditing: true,
      aspect: [1, 1],
    });

    if (result.canceled || !result.assets?.[0]?.uri || !userId) return;

    setUploadingPhoto(true);
    try {
      const url = await uploadImage(result.assets[0].uri, 'avatar');
      if (url) {
        await supabase.from('profiles').update({ photo_url: url }).eq('id', userId);
        setPhotoUrl(url);
      }
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось загрузить фото: ' + e.message);
    }
    setUploadingPhoto(false);
  }

  async function handleAddPhoto() {
    if (additionalPhotos.length >= MAX_ADDITIONAL_PHOTOS) {
      Alert.alert('Лимит фото', `Можно добавить не больше ${MAX_ADDITIONAL_PHOTOS} дополнительных фото.`);
      return;
    }

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Нужен доступ', 'Разрешите доступ к галерее.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });

    if (result.canceled || !result.assets?.[0]?.uri || !userId) return;

    setUploadingPhoto(true);
    try {
      const fileName = `extra_${Date.now()}`;
      const url = await uploadImage(result.assets[0].uri, fileName);
      if (url) {
        const updated = [...additionalPhotos, url];
        await supabase.from('profiles').update({ additional_photos: updated }).eq('id', userId);
        setAdditionalPhotos(updated);
      }
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось загрузить фото: ' + e.message);
    }
    setUploadingPhoto(false);
  }

  function handleRemovePhoto(url: string) {
    Alert.alert('Удалить фото?', '', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Удалить',
        style: 'destructive',
        onPress: async () => {
          if (!userId) return;
          const updated = additionalPhotos.filter((p) => p !== url);
          await supabase.from('profiles').update({ additional_photos: updated }).eq('id', userId);
          setAdditionalPhotos(updated);
        },
      },
    ]);
  }

  async function handleSave() {
    if (!userId) return;
    setSaving(true);

    const { error } = await supabase
      .from('profiles')
      .update({
        city: city.trim() || null,
        height_cm: heightCm ? parseInt(heightCm, 10) : null,
        weight_kg: weightKg ? parseInt(weightKg, 10) : null,
        bio: bio.trim() || null,
        sobriety_status: sobrietyStatus,
        substance_type: substances.length > 0 ? substances : null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    setSaving(false);

    if (error) {
      Alert.alert('Ошибка', 'Не удалось сохранить: ' + error.message);
      return;
    }

    Alert.alert('Сохранено', 'Изменения профиля сохранены.');
  }

  function handleDeleteProfile() {
    Alert.alert(
      'Удалить анкету?',
      'Анкета, фото, совпадения и переписки будут удалены безвозвратно. Само действие необратимо.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            if (!userId) return;
            // Удаление строки профиля каскадно удалит matches, messages, reports, blocks,
            // ссылающиеся на неё (см. schema.sql, ON DELETE CASCADE).
            const { error } = await supabase.from('profiles').delete().eq('id', userId);
            if (error) {
              Alert.alert('Ошибка', 'Не удалось удалить анкету: ' + error.message);
              return;
            }
            await supabase.auth.signOut();
            navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
          },
        },
      ]
    );
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#3b82f6" />
      </View>
    );
  }

  return (
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
            <ActivityIndicator color="#fff" />
          </View>
        )}
      </TouchableOpacity>
      <Text style={styles.changePhotoHint}>Нажмите на фото, чтобы изменить</Text>

      <Text style={styles.label}>Email</Text>
      <View style={styles.readOnlyField}>
        <Text style={styles.readOnlyText}>{email}</Text>
      </View>

      <Text style={styles.label}>Город</Text>
      <TextInput
        style={styles.input}
        placeholderTextColor="#8a8a8e"
        placeholder="Например, Москва"
        value={city}
        onChangeText={setCity}
      />

      <View style={styles.row}>
        <View style={styles.halfField}>
          <Text style={styles.label}>Рост, см</Text>
          <TextInput
            style={styles.input}
            placeholderTextColor="#8a8a8e"
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
            placeholderTextColor="#8a8a8e"
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
        placeholderTextColor="#8a8a8e"
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
          <TouchableOpacity key={url} onLongPress={() => handleRemovePhoto(url)}>
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

      <TouchableOpacity
        style={[styles.saveButton, saving && styles.buttonDisabled]}
        onPress={handleSave}
        disabled={saving}
      >
        {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveButtonText}>Сохранить изменения</Text>}
      </TouchableOpacity>

      <TouchableOpacity style={styles.signOutButton} onPress={handleSignOut}>
        <Text style={styles.signOutButtonText}>Выйти из аккаунта</Text>
      </TouchableOpacity>

      <TouchableOpacity style={styles.deleteButton} onPress={handleDeleteProfile}>
        <Text style={styles.deleteButtonText}>Удалить анкету</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingBottom: 60, backgroundColor: '#121212' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#121212' },
  photoPicker: {
    alignSelf: 'center',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#1c1c1e',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  photo: { width: 120, height: 120 },
  photoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  photoPlaceholderText: { color: '#8a8a8e', fontSize: 13, textAlign: 'center', paddingHorizontal: 8 },
  photoOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  changePhotoHint: { textAlign: 'center', color: '#8a8a8e', fontSize: 12, marginTop: 8, marginBottom: 20 },
  label: { fontSize: 13, fontWeight: '600', color: '#a0a0a5', marginBottom: 6, marginLeft: 2 },
  readOnlyField: {
    backgroundColor: '#1c1c1e',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    opacity: 0.6,
  },
  readOnlyText: { color: '#a0a0a5', fontSize: 16 },
  input: {
    backgroundColor: '#1c1c1e',
    color: '#f0f0f0',
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  textArea: { height: 90, textAlignVertical: 'top' },
  row: { flexDirection: 'row', gap: 12 },
  halfField: { flex: 1 },
  sectionLabel: { fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 8, color: '#f0f0f0' },
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
  photosGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
  thumb: { width: 72, height: 72, borderRadius: 8, backgroundColor: '#1c1c1e' },
  thumbAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: '#2a2a2a', borderStyle: 'dashed' },
  thumbAddText: { fontSize: 28, color: '#8a8a8e' },
  hint: { fontSize: 12, color: '#8a8a8e', marginTop: 8, marginBottom: 8 },
  saveButton: { backgroundColor: '#3b82f6', borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 20 },
  buttonDisabled: { opacity: 0.6 },
  saveButtonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  signOutButton: { padding: 16, alignItems: 'center', marginTop: 12 },
  signOutButtonText: { color: '#a0a0a5', fontSize: 15 },
  deleteButton: { padding: 16, alignItems: 'center', marginTop: 4 },
  deleteButtonText: { color: '#f87171', fontSize: 15, fontWeight: '600' },
});
