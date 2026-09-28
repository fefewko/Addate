// src/screens/Settings.tsx
import React, { useCallback, useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { View, Text, TouchableOpacity, StyleSheet, Switch, Alert, ScrollView, Linking } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';
import { openSupportChat } from '../lib/support';
import { getNotificationsEnabled, enableNotifications, disableNotifications, unregisterPushToken } from '../lib/pushNotifications';
import { colors } from '../lib/theme';

const DOCS = [
  ['Пользовательское соглашение', 'https://addate.ru/terms.html'],
  ['Правила сообщества', 'https://addate.ru/rules.html'],
  ['Политика конфиденциальности', 'https://addate.ru/privacy.html'],
  ['Согласие на обработку ПД', 'https://addate.ru/personal-data-consent.html'],
  ['Удаление аккаунта', 'https://addate.ru/delete-account.html'],
] as const;

export default function Settings() {
  const navigation = useNavigation<RootNavigation>();
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [notificationsBusy, setNotificationsBusy] = useState(false);
  const [updatingLocation, setUpdatingLocation] = useState(false);

  useFocusEffect(useCallback(() => {
    let active = true;
    getNotificationsEnabled().then((enabled) => { if (active) setNotificationsEnabled(enabled); });
    return () => { active = false; };
  }, []));

  async function handleToggleNotifications(next: boolean) {
    setNotificationsBusy(true);
    try {
      if (next) {
        const ok = await enableNotifications();
        if (!ok) Alert.alert('Нет доступа', 'Разрешите уведомления в настройках телефона, иначе включить их не получится.');
        setNotificationsEnabled(ok);
      } else {
        await disableNotifications();
        setNotificationsEnabled(false);
      }
    } finally { setNotificationsBusy(false); }
  }

  async function handleUpdateLocation() {
    setUpdatingLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') { Alert.alert('Нет доступа', 'Разрешите доступ к геопозиции в настройках телефона.'); setUpdatingLocation(false); return; }
      const position = await Location.getCurrentPositionAsync({});
      const { data: { user } } = await supabase.auth.getUser();
      if (user) await supabase.from('profiles').update({ latitude: position.coords.latitude, longitude: position.coords.longitude }).eq('id', user.id);
      Alert.alert('Готово', 'Геопозиция обновлена.');
    } catch (e: any) { Alert.alert('Ошибка', 'Не удалось обновить геопозицию: ' + e.message); }
    setUpdatingLocation(false);
  }

  async function handleSignOut() {
    await unregisterPushToken();
    await supabase.auth.signOut();
    navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
  }

  function openDoc(url: string) { Linking.openURL(url).catch(() => Alert.alert('Ошибка', 'Не удалось открыть документ.')); }

  async function handleDeleteAccount() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { Alert.alert('Нужно войти', 'Войдите в аккаунт, чтобы удалить его.'); return; }
    Alert.alert(
      'Удалить аккаунт?',
      'Будут удалены аккаунт, анкета, фотографии, совпадения и связанные данные. Действие необратимо.',
      [
        { text: 'Отмена', style: 'cancel' },
        { text: 'Удалить', style: 'destructive', onPress: async () => {
          const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
          if (error) { Alert.alert('Ошибка', 'Не удалось удалить аккаунт: ' + error.message); return; }
          navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
        } },
      ]
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Уведомления</Text>
      <View style={styles.row}><Text style={styles.rowLabel}>Push-уведомления о совпадениях и сообщениях</Text><Switch value={notificationsEnabled} onValueChange={handleToggleNotifications} disabled={notificationsBusy} trackColor={{ false: colors.border, true: colors.accent }} /></View>
      <Text style={styles.hint}>Выключение снимает push-токен этого устройства.</Text>

      <Text style={styles.sectionTitle}>Геопозиция</Text>
      <TouchableOpacity style={styles.actionRow} onPress={handleUpdateLocation} disabled={updatingLocation}><Text style={styles.actionText}>{updatingLocation ? 'Обновляем…' : 'Обновить геопозицию вручную'}</Text></TouchableOpacity>
      <Text style={styles.hint}>Используется для подбора анкет и расчёта расстояния.</Text>

      <Text style={styles.sectionTitle}>Документы</Text>
      {DOCS.map(([label, url]) => <TouchableOpacity key={url} style={styles.actionRow} onPress={() => openDoc(url)}><Text style={styles.actionText}>{label}</Text></TouchableOpacity>)}

      <Text style={styles.sectionTitle}>О приложении</Text>
      <View style={styles.row}><Text style={styles.rowLabel}>Версия</Text><Text style={styles.rowValue}>{Constants.expoConfig?.version || '—'}</Text></View>
      <TouchableOpacity style={styles.actionRow} onPress={() => openSupportChat(navigation)}><Text style={styles.actionText}>Написать в поддержку</Text></TouchableOpacity>

      <Text style={styles.sectionTitle}>Аккаунт</Text>
      <TouchableOpacity style={styles.actionRow} onPress={() => navigation.navigate('BlockedUsers')}><Text style={styles.actionText}>Заблокированные пользователи</Text></TouchableOpacity>
      <TouchableOpacity style={styles.actionRow} onPress={handleSignOut}><Text style={styles.signOutText}>Выйти из аккаунта</Text></TouchableOpacity>

      <Text style={styles.sectionTitle}>Опасная зона</Text>
      <TouchableOpacity style={styles.dangerRow} onPress={handleDeleteAccount}><Text style={styles.dangerText}>Удалить аккаунт</Text></TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  sectionTitle: { fontSize: 13, fontWeight: '600', color: colors.textFaint, textTransform: 'uppercase', marginTop: 24, marginBottom: 10 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginBottom: 8 },
  rowLabel: { color: colors.textPrimary, fontSize: 14, flex: 1, marginRight: 12 },
  rowValue: { color: colors.textSecondary, fontSize: 14 },
  actionRow: { backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginBottom: 8 },
  actionText: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  signOutText: { color: colors.textSecondary, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  hint: { color: colors.textFaint, fontSize: 12, marginBottom: 8 },
  dangerRow: { backgroundColor: colors.surface, borderRadius: 10, padding: 14, marginBottom: 8, borderWidth: 1, borderColor: colors.dangerBg },
  dangerText: { color: colors.danger, fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
