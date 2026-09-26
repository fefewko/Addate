// src/lib/location.ts
import { supabase } from './supabase';

export type Coordinates = { latitude: number; longitude: number } | null;

// Свои координаты намеренно берутся не из profiles, а из my_location().
// Колонки latitude/longitude исключены из SELECT-гранта authenticated, чтобы
// точные координаты чужих анкет нельзя было вытащить обычным запросом от
// имени пользователя. Расстояние до анкет по-прежнему считает серверная
// nearby_profiles() — клиент получает только километры.
export async function getMyCoordinates(): Promise<Coordinates> {
  const { data, error } = await supabase.rpc('my_location');

  if (error || !data || data.latitude == null || data.longitude == null) {
    return null;
  }

  return { latitude: data.latitude, longitude: data.longitude };
}
