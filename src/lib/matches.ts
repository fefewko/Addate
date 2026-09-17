// src/lib/matches.ts
import { supabase } from './supabase';

export type LikeResult =
  | { matched: true; matchId: string }
  | { matched: false; matchId: string | null };

// Общая логика "поставить лайк" для ленты, вкладки "Все" и полной анкеты.
// Учитывает, что в базе теперь есть жёсткое ограничение "одна пара — одна запись
// в matches" (см. миграцию matches_unique_pair) — если человек раньше пропустил
// анкету (status='rejected'), а теперь лайкает её снова, просто INSERT упадёт
// с конфликтом, и вместо этого нужно обновить уже существующую запись.
export async function likeProfile(myId: string, targetId: string): Promise<LikeResult> {
  const { data: reverseMatch } = await supabase
    .from('matches')
    .select('id, status')
    .eq('user_a', targetId)
    .eq('user_b', myId)
    .maybeSingle();

  if (reverseMatch && reverseMatch.status === 'pending') {
    await supabase
      .from('matches')
      .update({ status: 'matched', matched_at: new Date().toISOString() })
      .eq('id', reverseMatch.id);
    return { matched: true, matchId: reverseMatch.id };
  }

  if (reverseMatch && reverseMatch.status === 'matched') {
    return { matched: true, matchId: reverseMatch.id };
  }

  const { data: inserted, error: insertError } = await supabase
    .from('matches')
    .insert({ user_a: myId, user_b: targetId, status: 'pending' })
    .select('id')
    .single();

  if (!insertError) {
    return { matched: false, matchId: inserted?.id || null };
  }

  // Конфликт уникальности — значит запись между этой парой уже есть
  // (скорее всего, старый 'rejected' после пропуска). Находим её и переоживляем.
  const { data: existing } = await supabase
    .from('matches')
    .select('id, status')
    .or(`and(user_a.eq.${myId},user_b.eq.${targetId}),and(user_a.eq.${targetId},user_b.eq.${myId})`)
    .maybeSingle();

  if (!existing) {
    return { matched: false, matchId: null };
  }

  if (existing.status === 'matched') {
    return { matched: true, matchId: existing.id };
  }

  if (existing.status === 'rejected') {
    await supabase.from('matches').update({ status: 'pending' }).eq('id', existing.id);
  }

  return { matched: false, matchId: existing.id };
}
