// src/screens/ProfileSetup.tsx
//
// Перед использованием установи зависимость для выбора фото:
//   npx expo install expo-image-picker
//
import React, { useState } from 'react';
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

type SobrietyStatus = 'trezv' | 'v_sryve' | 'ne_ukazano';

const SOBRIETY_OPTIONS: { value: SobrietyStatus; label: string }[] = [
  { value: 'trezv', label: 'Трезв(а)' },
  { value: 'v_sryve', label: 'Сейчас непросто' },
  { value: 'ne_ukazano', label: 'Не указывать' },
];

const SUBSTANCE_OPTIONS = [
  { value: 'alcohol', label: 'Алкоголь' },
  { value: 'opioids', label: 'Опиоиды' },
  { value: 'stimulants', label: 'Стимуляторы' },
  { value: 'cannabis', label: 'Каннабис' },
  { value: 'other', label: 'Другое' },
];

// Простая проверка формата даты YYYY-MM-DD и возраста 18+
function validateBirthDate(value: string): string | null {
  const match = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!match) return 'Введите дату в формате ГГГГ-ММ-ДД';

  const date = new Date(value);
  if (isNaN(date.getTime())) return 'Некорректная дата';

  const age = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (age < 18) return 'Регистрация доступна только с 18 лет';
  if (age > 100) return 'Проверьте дату рождения';

  return null;
}

export default function ProfileSetup() {
  const navigation = useNavigation<any>();

  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState(''); // YYYY-MM-DD
  const [city, setCity] = useState('');
  const [bio, setBio] = useState('');
  const [sobrietyStatus, setSobrietyStatus] = useState<SobrietyStatus>('ne_ukazano');
  const [substances, setSubstances] = useState<string[]>([]);
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
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

    const response = await fetch(photoUri);
    const arrayBuffer = await response.arrayBuffer();
    const fileExt = photoUri.split('.').pop() || 'jpg';
    const filePath = `${userId}/avatar.${fileExt}`;

    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(filePath, arrayBuffer, {
        contentType: `image/${fileExt}`,
        upsert: true,
      });

    if (uploadError) {
      throw new Error(uploadError.message);
    }

    const { data } = supabase.storage.from('avatars').getPublicUrl(filePath);
    return data.publicUrl;
  }

  async function handleSave() {
    setError(null);

    if (!displayName.trim()) {
      setError('Укажите имя.');
      return;
    }

    const birthDateError = validateBirthDate(birthDate);
    if (birthDateError) {
      setError(birthDateError);
      return;
    }

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

    let photoUrl: string | null = null;
    try {
      photoUrl = await uploadPhoto(user.id);
    } catch (e: any) {
      setError('Не удалось загрузить фото: ' + e.message);
      setLoading(false);
      return;
    }

    const { error: updateError } = await supabase
      .from('profiles')
      .update({
        display_name: displayName.trim(),
        birth_date: birthDate,
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

    navigation.reset({ index: 0, routes: [{ name: 'ModerationPending' }] });
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Расскажите о себе</Text>

      <TouchableOpacity style={styles.photoPicker} onPress={pickPhoto}>
        {photoUri ? (
          <Image source={{ uri: photoUri }} style={styles.photo} />
        ) : (
          <Text style={styles.photoPlaceholder}>Добавить фото</Text>
        )}
      </TouchableOpacity>

      <TextInput
        style={styles.input}
        placeholder="Имя"
        value={displayName}
        onChangeText={setDisplayName}
      />

      <TextInput
        style={styles.input}
        placeholder="Дата рождения (ГГГГ-ММ-ДД)"
        value={birthDate}
        onChangeText={setBirthDate}
        keyboardType="numbers-and-punctuation"
      />

      <TextInput style={styles.input} placeholder="Город" value={city} onChangeText={setCity} />

      <TextInput
        style={[styles.input, styles.textArea]}
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
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.buttonText}>Сохранить и продолжить</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, paddingBottom: 48, backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 20, textAlign: 'center' },
  photoPicker: {
    alignSelf: 'center',
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: '#f0f0f0',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    overflow: 'hidden',
  },
  photo: { width: 120, height: 120 },
  photoPlaceholder: { color: '#888', fontSize: 13, textAlign: 'center', paddingHorizontal: 8 },
  input: {
    borderWidth: 1,
    borderColor: '#ddd',
    borderRadius: 8,
    padding: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  textArea: { height: 90, textAlignVertical: 'top' },
  sectionLabel: { fontSize: 14, fontWeight: '600', marginTop: 12, marginBottom: 8, color: '#333' },
  radioRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: '#999',
    marginRight: 10,
  },
  radioSelected: { borderColor: '#2563eb', backgroundColor: '#2563eb' },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: '#999',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  checkboxMark: { color: '#fff', fontSize: 12, fontWeight: '700' },
  radioLabel: { fontSize: 15, color: '#333' },
  error: { color: '#dc2626', marginVertical: 12, fontSize: 14 },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
