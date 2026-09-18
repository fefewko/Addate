// src/screens/Settings.tsx
import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch, Alert, ScrollView, Linking } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import * as Location from 'expo-location';
import Constants from 'expo-constants';
import { supabase } from '../lib/supabase';

export default function Settings() {
  const navigation = useNavigation<any>();
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [updatingLocation, setUpdatingLocation] = useState(false);

  async function handleUpdateLocation() {
    setUpdatingLocation(true);
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Нет доступа', 'Разрешите доступ к геопозиции в настройках телефона.');
        setUpdatingLocation(false);
        return;
      }
      const position = await Location.getCurrentPositionAsync({});
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        await supabase
          .from('profiles')
          .update({ latitude: position.coords.latitude, longitude: position.coords.longitude })
          .eq('id', user.id);
      }
      Alert.alert('Готово', 'Геопозиция обновлена.');
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось обновить геопозицию: ' + e.message);
    }
    setUpdatingLocation(false);
  }

  async function handleDeleteProfile() {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;

    Alert.alert(
      'Удалить анкету?',
      'Анкета, фото, совпадения и переписки будут удалены безвозвратно. Само действие необратимо.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            // Удаление строки профиля каскадно удалит matches, messages, reports, blocks,
            // ссылающиеся на неё (см. schema.sql, ON DELETE CASCADE).
            const { error } = await supabase.from('profiles').delete().eq('id', user.id);
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
    Alert.alert('Выйти из аккаунта?', 'Вы сможете войти снова в любое время.', [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Выйти',
        style: 'destructive',
        onPress: async () => {
          const { error } = await supabase.auth.signOut();
          if (error) {
            Alert.alert('Ошибка', 'Не удалось выйти из аккаунта: ' + error.message);
            return;
          }
          navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
        },
      },
    ]);
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.sectionTitle}>Уведомления</Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Push-уведомления о совпадениях и сообщениях</Text>
        <Switch
          value={notificationsEnabled}
          onValueChange={setNotificationsEnabled}
          trackColor={{ false: '#2a2a2a', true: '#3b82f6' }}
        />
      </View>

      <Text style={styles.sectionTitle}>Геопозиция</Text>
      <TouchableOpacity style={styles.actionRow} onPress={handleUpdateLocation} disabled={updatingLocation}>
        <Text style={styles.actionText}>
          {updatingLocation ? 'Обновляем…' : 'Обновить геопозицию вручную'}
        </Text>
      </TouchableOpacity>
      <Text style={styles.hint}>
        Обновляется автоматически при открытии вкладки "Анкеты", но можно и вручную.
      </Text>

      <Text style={styles.sectionTitle}>О приложении</Text>
      <View style={styles.row}>
        <Text style={styles.rowLabel}>Версия</Text>
        <Text style={styles.rowValue}>{Constants.expoConfig?.version || '—'}</Text>
      </View>
      <TouchableOpacity
        style={styles.actionRow}
        onPress={() => Linking.openURL('mailto:support@addate.ru')}
      >
        <Text style={styles.actionText}>Написать в поддержку</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Аккаунт</Text>
      <TouchableOpacity style={styles.actionRow} onPress={handleSignOut}>
        <Text style={styles.actionText}>Выйти из аккаунта</Text>
      </TouchableOpacity>

      <Text style={styles.sectionTitle}>Опасная зона</Text>
      <TouchableOpacity style={styles.dangerRow} onPress={handleDeleteProfile}>
        <Text style={styles.dangerText}>Удалить анкету</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  content: { padding: 20, paddingBottom: 60 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#8a8a8e',
    textTransform: 'uppercase',
    marginTop: 24,
    marginBottom: 10,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  rowLabel: { color: '#f0f0f0', fontSize: 14, flex: 1, marginRight: 12 },
  rowValue: { color: '#a0a0a5', fontSize: 14 },
  actionRow: { backgroundColor: '#1c1c1e', borderRadius: 10, padding: 14, marginBottom: 8 },
  actionText: { color: '#3b82f6', fontSize: 14, fontWeight: '600' },
  hint: { color: '#8a8a8e', fontSize: 12, marginBottom: 8 },
  dangerRow: {
    backgroundColor: '#1c1c1e',
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#3a1d1d',
  },
  dangerText: { color: '#f87171', fontSize: 14, fontWeight: '600', textAlign: 'center' },
});
