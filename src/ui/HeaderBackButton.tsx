// src/ui/HeaderBackButton.tsx
//
// Кнопка «назад» в шапке — только для веба.
//
// Зачем: на телефоне стрелку возврата рисует системная шапка стека, и она
// появляется сама, когда в стеке больше одного экрана. В браузере при прямом
// переходе по адресу (/chat/<id>, /profile/<id>, /settings) стек состоит из
// одного экрана, canGoBack() = false, и стрелки нет вообще: из переписки
// нельзя вернуться к списку сообщений, остаётся только кнопка браузера.
//
// Поэтому на вебе шапка всегда получает эту кнопку. Действие выбирает
// вызывающий код: сначала возврат по стеку, а если истории нет — переход на
// вкладку, из которой экран логически открывается.
import React from 'react';
import { StyleSheet, TouchableOpacity } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { colors } from '../lib/theme';

export default function HeaderBackButton({ onPress }: { onPress: () => void }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Назад"
      style={styles.button}
    >
      <Ionicons name="chevron-back" size={26} color={colors.textPrimary} />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  button: { paddingHorizontal: 12, paddingVertical: 4 },
});
