// src/screens/Chat.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActionSheetIOS,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { supabase } from '../lib/supabase';

type Message = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string;
  created_at: string;
};

const REPORT_CATEGORIES: { value: string; label: string }[] = [
  { value: 'harassment', label: 'Домогательства или оскорбления' },
  { value: 'spam_or_ads', label: 'Спам или реклама веществ' },
  { value: 'fake_profile', label: 'Фейковый профиль' },
  { value: 'scam', label: 'Мошенничество' },
  { value: 'other', label: 'Другое' },
];

export default function Chat() {
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { matchId, otherUserId, otherName } = route.params;

  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    navigation.setOptions({ title: otherName || 'Чат' });
  }, [navigation, otherName]);

  const loadMessages = useCallback(async () => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return;
    setMyId(user.id);

    const { data, error } = await supabase
      .from('messages')
      .select('*')
      .eq('match_id', matchId)
      .order('created_at', { ascending: true });

    if (error) {
      console.warn('Ошибка загрузки сообщений:', error.message);
      return;
    }

    setMessages(data || []);
  }, [matchId]);

  useEffect(() => {
    loadMessages();
  }, [loadMessages]);

  // Realtime: подписка на новые сообщения в этом совпадении
  useEffect(() => {
    const channel = supabase
      .channel(`messages-${matchId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `match_id=eq.${matchId}` },
        (payload) => {
          setMessages((prev) => [...prev, payload.new as Message]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId]);

  async function handleSend() {
    if (!text.trim() || !myId) return;
    setSending(true);

    const content = text.trim();
    setText('');

    const { error } = await supabase.from('messages').insert({
      match_id: matchId,
      sender_id: myId,
      content,
    });

    setSending(false);

    if (error) {
      Alert.alert('Ошибка', 'Не удалось отправить сообщение.');
      setText(content); // возвращаем текст в поле, чтобы не потерять
    }
  }

  async function handleBlock() {
    Alert.alert(
      'Заблокировать пользователя?',
      `${otherName || 'Этот человек'} больше не сможет вам писать, и вы не увидите его(её) анкету.`,
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Заблокировать',
          style: 'destructive',
          onPress: async () => {
            if (!myId) return;
            const { error } = await supabase.from('blocks').insert({
              blocker_id: myId,
              blocked_id: otherUserId,
            });
            if (error) {
              Alert.alert('Ошибка', 'Не удалось заблокировать пользователя.');
              return;
            }
            navigation.navigate('ChatList');
          },
        },
      ]
    );
  }

  function handleReport() {
    // Простой выбор категории через нативный action sheet (iOS) или Alert (Android)
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...REPORT_CATEGORIES.map((c) => c.label), 'Отмена'],
          cancelButtonIndex: REPORT_CATEGORIES.length,
        },
        (index) => {
          if (index < REPORT_CATEGORIES.length) {
            submitReport(REPORT_CATEGORIES[index].value);
          }
        }
      );
    } else {
      Alert.alert(
        'Пожаловаться',
        'Выберите причину',
        [
          ...REPORT_CATEGORIES.map((c) => ({
            text: c.label,
            onPress: () => submitReport(c.value),
          })),
          { text: 'Отмена', style: 'cancel' as const },
        ]
      );
    }
  }

  async function submitReport(category: string) {
    if (!myId) return;
    const { error } = await supabase.from('reports').insert({
      reporter_id: myId,
      reported_id: otherUserId,
      category,
    });

    if (error) {
      Alert.alert('Ошибка', 'Не удалось отправить жалобу.');
      return;
    }
    Alert.alert('Спасибо', 'Жалоба отправлена на рассмотрение модератору.');
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={handleReport} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>Пожаловаться</Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleBlock} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, styles.blockText]}>Заблокировать</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const isMine = item.sender_id === myId;
          return (
            <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
              <Text style={isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>
                {item.content}
              </Text>
            </View>
          );
        }}
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
        placeholderTextColor="#8a8a8e"
          placeholder="Сообщение..."
          value={text}
          onChangeText={setText}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendButton, (!text.trim() || sending) && styles.sendButtonDisabled]}
          onPress={handleSend}
          disabled={!text.trim() || sending}
        >
          <Text style={styles.sendButtonText}>Отправить</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#121212' },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#2a2a2a',
  },
  headerButton: { marginLeft: 16 },
  headerButtonText: { fontSize: 13, color: '#a0a0a5' },
  blockText: { color: '#f87171' },
  messageList: { padding: 14, flexGrow: 1 },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8 },
  bubbleMine: { backgroundColor: '#3b82f6', alignSelf: 'flex-end' },
  bubbleTheirs: { backgroundColor: '#2a2a2a', alignSelf: 'flex-start' },
  bubbleTextMine: { color: '#fff', fontSize: 15 },
  bubbleTextTheirs: { color: '#f0f0f0', fontSize: 15 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  input: {
    backgroundColor: '#1c1c1e',
    color: '#f0f0f0',
    flex: 1,
    borderWidth: 1,
    borderColor: '#2a2a2a',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    maxHeight: 100,
    fontSize: 15,
  },
  sendButton: { backgroundColor: '#3b82f6', borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { color: '#fff', fontWeight: '600' },
});
