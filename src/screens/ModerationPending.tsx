// src/screens/ModerationPending.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';

type Status = 'pending' | 'approved' | 'rejected';

const STATUS_TEXT: Record<Status, { title: string; body: string }> = {
  pending: {
    title: 'Анкета на проверке',
    body: 'Обычно модерация занимает немного времени. Мы уведомим вас, как только анкета будет одобрена.',
  },
  rejected: {
    title: 'Анкета отклонена',
    body: 'К сожалению, анкета не прошла проверку. Вы можете отредактировать её и отправить повторно.',
  },
  approved: {
    title: 'Анкета одобрена',
    body: 'Переходим в приложение...',
  },
};

export default function ModerationPending() {
  const navigation = useNavigation<any>();
  const [status, setStatus] = useState<Status>('pending');
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
      return;
    }

    setUserId(user.id);

    const { data, error } = await supabase
      .from('profiles')
      .select('moderation_status, moderation_note')
      .eq('id', user.id)
      .maybeSingle();

    setLoading(false);

    if (error || !data) return;

    setStatus(data.moderation_status as Status);
    setNote(data.moderation_note);

    if (data.moderation_status === 'approved') {
      setTimeout(() => {
        navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
      }, 800);
    }
  }, [navigation]);

  // Проверяем статус при каждом возврате на этот экран
  useFocusEffect(
    useCallback(() => {
      fetchStatus();
    }, [fetchStatus])
  );

  // Плюс realtime-подписка: если модератор одобрит анкету, пока
  // пользователь смотрит на этот экран, редирект произойдёт сразу,
  // без необходимости выходить и возвращаться в приложение.
  useEffect(() => {
    if (!userId) return;

    const channel = supabase
      .channel(`profile-status-${userId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${userId}` },
        (payload) => {
          const newStatus = payload.new.moderation_status as Status;
          setStatus(newStatus);
          setNote(payload.new.moderation_note);
          if (newStatus === 'approved') {
            setTimeout(() => {
              navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
            }, 800);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, navigation]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    navigation.reset({ index: 0, routes: [{ name: 'SignIn' }] });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#2563eb" />
      </View>
    );
  }

  const content = STATUS_TEXT[status];

  return (
    <View style={styles.container}>
      <Text style={styles.title}>{content.title}</Text>
      <Text style={styles.body}>{content.body}</Text>

      {status === 'rejected' && note && (
        <View style={styles.noteBox}>
          <Text style={styles.noteLabel}>Комментарий модератора:</Text>
          <Text style={styles.noteText}>{note}</Text>
        </View>
      )}

      {status === 'rejected' && (
        <TouchableOpacity
          style={styles.button}
          onPress={() => navigation.navigate('ProfileSetup')}
        >
          <Text style={styles.buttonText}>Редактировать анкету</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.secondaryButton} onPress={fetchStatus}>
        <Text style={styles.secondaryButtonText}>Обновить статус</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={handleSignOut}>
        <Text style={styles.signOut}>Выйти</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '600', marginBottom: 12, textAlign: 'center' },
  body: { fontSize: 15, color: '#555', textAlign: 'center', marginBottom: 24, lineHeight: 22 },
  noteBox: { backgroundColor: '#fef2f2', borderRadius: 8, padding: 14, marginBottom: 20 },
  noteLabel: { fontSize: 13, fontWeight: '600', color: '#991b1b', marginBottom: 4 },
  noteText: { fontSize: 14, color: '#7f1d1d' },
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  secondaryButton: {
    borderWidth: 1,
    borderColor: '#2563eb',
    borderRadius: 8,
    padding: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  secondaryButtonText: { color: '#2563eb', fontSize: 16, fontWeight: '600' },
  signOut: { textAlign: 'center', color: '#888', fontSize: 14 },
});
