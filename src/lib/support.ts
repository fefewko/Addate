// src/lib/support.ts
import { Alert } from 'react-native';
import { supabase } from './supabase';

// "Поддержка" — это просто обычный чат с аккаунтом-администратором,
// без необходимости лайка/совпадения — переиспользуем существующую
// систему matches/messages вместо отдельной инфраструктуры.
export async function openSupportChat(navigation: any) {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;

  const { data: admin } = await supabase
    .from('profiles')
    .select('id, display_name')
    .eq('is_admin', true)
    .limit(1)
    .maybeSingle();

  if (!admin) {
    Alert.alert('Недоступно', 'Поддержка временно недоступна.');
    return;
  }

  if (admin.id === user.id) {
    // сам админ не может написать сам себе
    return;
  }

  const { data: existing } = await supabase
    .from('matches')
    .select('id, status')
    .or(`and(user_a.eq.${user.id},user_b.eq.${admin.id}),and(user_a.eq.${admin.id},user_b.eq.${user.id})`)
    .maybeSingle();

  let matchId: string;

  if (existing) {
    matchId = existing.id;
    if (existing.status !== 'matched') {
      await supabase.from('matches').update({ status: 'matched', matched_at: new Date().toISOString() }).eq('id', existing.id);
    }
  } else {
    const { data: inserted, error } = await supabase
      .from('matches')
      .insert({ user_a: user.id, user_b: admin.id, status: 'matched', matched_at: new Date().toISOString() })
      .select('id')
      .single();

    if (error || !inserted) {
      Alert.alert('Ошибка', 'Не удалось открыть чат с поддержкой.');
      return;
    }
    matchId = inserted.id;
  }

  navigation.navigate('Chat', {
    matchId,
    otherUserId: admin.id,
    otherName: admin.display_name || 'Поддержка',
    otherAge: undefined,
  });
}
