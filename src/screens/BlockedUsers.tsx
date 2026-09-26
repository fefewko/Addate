// src/screens/BlockedUsers.tsx
import React, { useCallback, useState } from 'react';
import { View, Text, Image, TouchableOpacity, StyleSheet, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { supabase } from '../lib/supabase';
import LoadError from '../ui/LoadError';
import { colors } from '../lib/theme';

type BlockedItem = {
  blockId: string;
  userId: string;
  displayName: string;
  photoUrl: string | null;
};

export default function BlockedUsers() {
  const [items, setItems] = useState<BlockedItem[]>([]);
  const [loading, setLoading] = useState(true);
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

    const { data: blocks } = await supabase
      .from('blocks')
      .select('id, blocked_id')
      .eq('blocker_id', user.id);

    if (!blocks || blocks.length === 0) {
      setItems([]);
      setLoading(false);
      return;
    }

    const ids = blocks.map((b) => b.blocked_id);
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, display_name, photo_url')
      .in('id', ids);

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));

    setItems(
      blocks.map((b) => ({
        blockId: b.id,
        userId: b.blocked_id,
        displayName: profileMap.get(b.blocked_id)?.display_name || 'Без имени',
        photoUrl: profileMap.get(b.blocked_id)?.photo_url || null,
      }))
    );
    setLoading(false);
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load])
  );

  function handleUnblock(item: BlockedItem) {
    Alert.alert('Разблокировать?', `${item.displayName} снова сможет видеть вашу анкету и писать вам.`, [
      { text: 'Отмена', style: 'cancel' },
      {
        text: 'Разблокировать',
        onPress: async () => {
          await supabase.from('blocks').delete().eq('id', item.blockId);
          setItems((prev) => prev.filter((i) => i.blockId !== item.blockId));
        },
      },
    ]);
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

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Заблокированных пользователей нет.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {items.map((item) => (
        <View key={item.blockId} style={styles.row}>
          {item.photoUrl ? (
            <Image source={{ uri: item.photoUrl }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarPlaceholder]}>
              <Text style={styles.avatarPlaceholderText}>{item.displayName.charAt(0).toUpperCase()}</Text>
            </View>
          )}
          <Text style={styles.name}>{item.displayName}</Text>
          <TouchableOpacity style={styles.unblockButton} onPress={() => handleUnblock(item)}>
            <Text style={styles.unblockButtonText}>Разблокировать</Text>
          </TouchableOpacity>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24, backgroundColor: colors.bg },
  emptyText: { color: colors.textSecondary, fontSize: 15, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  avatar: { width: 44, height: 44, borderRadius: 22, marginRight: 12, backgroundColor: colors.surface },
  avatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  avatarPlaceholderText: { fontSize: 16, fontWeight: '600', color: colors.textMuted },
  name: { flex: 1, color: colors.textPrimary, fontSize: 15, fontWeight: '600' },
  unblockButton: { paddingVertical: 8, paddingHorizontal: 12 },
  unblockButtonText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
});
