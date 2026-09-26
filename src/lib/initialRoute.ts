// src/lib/initialRoute.ts
import { supabase } from './supabase';

export type InitialRoute =
  | 'SignIn'
  | 'SignUp'
  | 'ProfileSetup'
  | 'ModerationPending'
  | 'Tabs';

// Куда отправлять пользователя после появления сессии. Вынесено отдельно,
// потому что логика нужна в двух местах: при старте приложения и после
// подтверждения email по ссылке из письма (AuthCallback).
export async function resolveInitialRoute(): Promise<InitialRoute> {
  const {
    data: { session },
    error: sessionError,
  } = await supabase.auth.getSession();

  if (sessionError) {
    throw new Error('Не удалось проверить сессию: ' + sessionError.message);
  }

  if (!session) {
    return 'SignIn';
  }

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('moderation_status, display_name')
    .eq('id', session.user.id)
    .maybeSingle();

  if (profileError) {
    throw new Error('Не удалось загрузить анкету: ' + profileError.message);
  }

  if (!profile || !profile.display_name) {
    return 'ProfileSetup';
  }

  return profile.moderation_status === 'approved' ? 'Tabs' : 'ModerationPending';
}
