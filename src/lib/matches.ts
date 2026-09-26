// src/lib/matches.ts
import { supabase } from './supabase';

export type LikeResult =
  | { matched: true; matchId: string }
  | { matched: false; matchId: string | null };

// Общая логика "поставить лайк" для ленты, вкладки "Все", полной анкеты
// и взаимных лайков.
//
// В matches лежит РОВНО одна запись на пару (уникальный индекс
// matches_unique_pair), и кто именно оказался в user_a зависит от того, кто
// лайкнул первым. Поэтому пару ищем независимо от направления.
//
// Раньше поиск шёл только по (user_a = собеседник, user_b = я). Из-за этого
// сценарий «я пропустил → он лайкнул → я лайкаю в ответ» не находил пару:
// запись лежала как (я, он), статус 'pending', и likeProfile молча уходил в
// ветку конфликта и возвращал matched: false. Итог: человек лайкнул меня,
// я хотел в ответ — а совпадение не создавалось, и лайк пропадал.
export async function likeProfile(myId: string, targetId: string): Promise<LikeResult> {
  const { data: existing } = await supabase
    .from('matches')
    .select('id, status')
    .or(`and(user_a.eq.${myId},user_b.eq.${targetId}),and(user_a.eq.${targetId},user_b.eq.${myId})`)
    .maybeSingle();

  // Пары ещё нет — создаём свою запись.
  if (!existing) {
    const { data: inserted, error: insertError } = await supabase
      .from('matches')
      .insert({ user_a: myId, user_b: targetId, status: 'pending' })
      .select('id')
      .single();

    if (insertError || !inserted) {
      return { matched: false, matchId: null };
    }
    return { matched: false, matchId: inserted.id };
  }

  if (existing.status === 'matched') {
    return { matched: true, matchId: existing.id };
  }

  // 'pending' означает, что лайк с его стороны уже есть (в том числе
  // перекрытый нами скип), значит наш ответ делает лайки взаимными.
  if (existing.status === 'pending') {
    const { error } = await supabase
      .from('matches')
      .update({ status: 'matched', matched_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) {
      return { matched: false, matchId: existing.id };
    }
    return { matched: true, matchId: existing.id };
  }

  // status === 'rejected': наш прежний скип перекрываем новым лайком.
  const { error } = await supabase
    .from('matches')
    .update({ status: 'pending' })
    .eq('id', existing.id);

  return { matched: false, matchId: error ? null : existing.id };
}
