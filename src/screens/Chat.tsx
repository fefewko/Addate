// src/screens/Chat.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { RootNavigation } from '../lib/navigation';
import { log } from '../lib/log';
import { View, Text, TextInput, TouchableOpacity, FlatList, Image, Modal, ActivityIndicator, StyleSheet, KeyboardAvoidingView, Platform, ActionSheetIOS } from 'react-native';
import { appAlert } from '../lib/alert';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { supabase } from '../lib/supabase';
import { decryptChatImage, getSignedChatImageUrls, uploadEncryptedChatImage, writeDecryptedImage } from '../lib/chatImages';
import { colors } from '../lib/theme';
import { decryptText, encryptText, getLocalPrivateKey, getPublicKey, prepareSendSession, publicKeyToBase64 } from '../lib/e2ee';
import { offerKeyReset } from '../lib/e2eeReset';

type Message = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string | null;
  image_path: string | null;
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
  const navigation = useNavigation<RootNavigation>();
  const route = useRoute<any>();
  const { matchId, otherUserId, otherName, otherAge } = route.params;
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<Message[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [decryptedImages, setDecryptedImages] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(otherUserId ?? null);
  const [isSupport, setIsSupport] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    const title = otherAge ? `${otherName || 'Чат'}, ${otherAge}` : otherName || 'Чат';

    // Переход в анкету собеседника прямо из переписки: тап по иконке в шапке.
    // peerId может прийти позже (при открытии по ссылке chat/:matchId), поэтому
    // эффект зависит от него.
    // У чата поддержки анкеты нет — иконку не показываем.
    const peerProfileId = isSupport ? null : peerId ?? otherUserId ?? null;
    navigation.setOptions({
      title,
      headerRight: peerProfileId
        ? () => (
            <TouchableOpacity
              onPress={() => navigation.navigate('ProfileDetail', { profileId: peerProfileId })}
              accessibilityRole="button"
              accessibilityLabel="Открыть анкету"
              style={{ paddingHorizontal: 12, paddingVertical: 4 }}
            >
              <Ionicons name="person-circle-outline" size={26} color={colors.textPrimary} />
            </TouchableOpacity>
          )
        : undefined,
    });
  }, [navigation, otherName, otherAge, peerId, otherUserId, isSupport]);

  useEffect(() => {
    // При входе по ссылке chat/:matchId в параметрах есть только matchId,
    // без otherUserId. Раньше здесь шёл безусловный запрос с .eq('id', undefined),
    // который PostgREST отклонял ошибкой — надо просто пропустить проверку.
    if (!otherUserId) {
      setIsSupport(false);
      return;
    }

    supabase
      .from('profiles')
      .select('is_admin')
      .eq('id', otherUserId)
      .maybeSingle()
      .then(({ data }) => setIsSupport(!!data?.is_admin));
  }, [otherUserId]);

  // При входе по ссылке chat/:matchId в параметрах есть только matchId, без
  // otherUserId. Раньше в этом случае собеседник оставался неизвестным, и
  // отправка сообщений всегда падала с «сессия шифрования не готова»: не у
  // кого было запросить публичный ключ. Достаём второго участника из matches.
  useEffect(() => {
    if (otherUserId) {
      setPeerId(otherUserId);
      return;
    }

    let cancelled = false;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;

      const { data } = await supabase
        .from('matches')
        .select('user_a, user_b')
        .eq('id', matchId)
        .maybeSingle();
      if (cancelled || !data) return;

      setPeerId(data.user_a === user.id ? data.user_b : data.user_a);
    })();

    return () => {
      cancelled = true;
    };
  }, [otherUserId, matchId]);

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
      log.warn('Ошибка загрузки сообщений:', error.message);
      return;
    }

    // Ключи нужны для каждого сообщения, но читать их из БД N раз незачем.
    const privateKey = await getLocalPrivateKey(user.id);
    let peerPublicKeyB64: string | null = null;
    if (peerId) {
      try {
        const peerPublicKey = await getPublicKey(peerId);
        if (peerPublicKey) {
          peerPublicKeyB64 = await publicKeyToBase64(peerPublicKey);
        }
      } catch (e) {
        // Сообщения всё равно показываем: при отсутствии гранта на
        // profiles.public_key расшифровать их не получится, но список не
        // должен пропадать из-за одной ошибки чтения ключа.
        log.warn('E2EE: не удалось прочитать публичный ключ собеседника:', e);
      }
    }

    const loaded = await Promise.all(
      (data || []).map(async (m) => {
        // Изображение: content — зашифрованный JSON envelope, image_path —
        // ciphertext в storage. Расшифровываем байты и кешируем displayable URI.
        if (m.image_path) {
          const path = m.image_path;
          if (!privateKey || !peerPublicKeyB64 || !path) {
            return m;
          }
          try {
            const result = await decryptChatImage(privateKey, peerPublicKeyB64, m.content);
            if (!result) {
              return m;
            }
            const uri = await writeDecryptedImage(result.bytes, result.format.mimeType, path);
            setDecryptedImages((prev) => ({ ...prev, [path]: uri }));
          } catch (e) {
            log.warn('E2EE: не удалось расшифровать изображение:', e);
          }
          return m;
        }

        if (!m.content) {
          return m;
        }
        if (!privateKey || !peerPublicKeyB64) {
          return m;
        }
        try {
          const text = await decryptText(privateKey, peerPublicKeyB64, m.content);
          return { ...m, content: text };
        } catch (e) {
          log.warn('E2EE: не удалось расшифровать сообщение:', e);
          return m;
        }
      })
    );
    setMessages(loaded);

    const paths = loaded.map((m) => m.image_path).filter((p): p is string => !!p);
    if (paths.length > 0) {
      const urls = await getSignedChatImageUrls(paths);
      setImageUrls((prev) => ({ ...prev, ...urls }));
    }

    // Отмечаем чужие непрочитанные сообщения прочитанными — как только открыли чат
    await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('match_id', matchId)
      .neq('sender_id', user.id)
      .is('read_at', null);
  }, [matchId, peerId]);

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
        async (payload) => {
          const newMessage = payload.new as Message;
          let message = newMessage;

          let privateKey: Uint8Array | null = null;
          let peerPublicKeyB64: string | null = null;
          try {
            privateKey = myId ? await getLocalPrivateKey(myId) : null;
            if (peerId) {
              const peerPublicKey = await getPublicKey(peerId);
              if (peerPublicKey) {
                peerPublicKeyB64 = await publicKeyToBase64(peerPublicKey);
              }
            }
          } catch (e) {
            log.warn('E2EE: не удалось прочитать ключи для realtime-сообщения:', e);
          }

          if (message.image_path) {
            if (privateKey && peerPublicKeyB64) {
              try {
                const result = await decryptChatImage(privateKey, peerPublicKeyB64, newMessage.content);
                if (result && message.image_path) {
                  const uri = await writeDecryptedImage(result.bytes, result.format.mimeType, message.image_path);
                  setDecryptedImages((prev) => ({ ...prev, [message.image_path as string]: uri }));
                }
              } catch (e) {
                log.warn('E2EE: не удалось расшифровать realtime-изображение:', e);
              }
            }
            setMessages((prev) => [...prev, message]);
            return;
          }
          if (newMessage.content && privateKey && peerPublicKeyB64) {
            try {
              const text = await decryptText(privateKey, peerPublicKeyB64, newMessage.content);
              message = { ...newMessage, content: text };
            } catch (e) {
              log.warn('E2EE: не удалось расшифровать realtime-сообщение:', e);
            }
          }
          setMessages((prev) => [...prev, message]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [matchId, myId, peerId]);

  // Подписанные ссылки живут час. Если чат открыт дольше, картинки в старых
  // сообщениях перестают грузиться, поэтому по onError запрашиваем ссылку
  // заново — только для этого одного изображения.
  const refreshImage = useCallback(async (path: string) => {
    const urls = await getSignedChatImageUrls([path]);
    if (urls[path]) {
      setImageUrls((prev) => ({ ...prev, [path]: urls[path] }));
    }
  }, []);

  async function handleSend() {
    if (!text.trim() || !myId) return;
    setSending(true);

    const content = text.trim();
    setText('');

    const session = await prepareSendSession(myId, peerId);
    if (!session.ok) {
      setText(content);
      setSending(false);
      log.warn('E2EE: не удалось подготовить сессию шифрования:', session.cause ?? session.message);
      if (session.needsKeyReset) {
        // Ключ остался от старой установки: предлагаем заменить и повторить
        // отправку. Текст уже возвращён в поле, поэтому handleSend() заново
        // возьмёт то же содержимое.
        offerKeyReset(myId, session.message, () => handleSend());
      } else {
        appAlert.alert(session.title, session.message);
      }
      return;
    }
    const payload = await encryptText(session.privateKey, session.peerPublicKeyB64, content);
    const { error } = await supabase.from('messages').insert({
      match_id: matchId,
      sender_id: myId,
      content: JSON.stringify(payload),
    });

    setSending(false);

    if (error) {
      appAlert.alert('Ошибка', 'Не удалось отправить сообщение.');
      setText(content); // возвращаем текст в поле, чтобы не потерять
    }
  }

  async function handlePickImage() {
    if (!myId || uploadingImage) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      appAlert.alert('Нужен доступ', 'Разрешите доступ к галерее, чтобы отправить фото.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.6,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    await sendImage(result.assets[0].uri);
  }

  // Вынесено из handlePickImage, чтобы после замены ключа можно было повторить
  // отправку уже выбранного фото, а не заставлять пользователя выбирать его
  // заново.
  async function sendImage(uri: string) {
    if (!myId) return;
    setUploadingImage(true);
    try {
      const session = await prepareSendSession(myId, peerId);
      if (!session.ok) {
        log.warn('E2EE: не удалось подготовить сессию шифрования:', session.cause ?? session.message);
        if (session.needsKeyReset) {
          setUploadingImage(false);
          offerKeyReset(myId, session.message, () => sendImage(uri));
          return;
        }
        throw new Error(session.message);
      }
      const { path, payload, bytes, format } = await uploadEncryptedChatImage(
        matchId,
        uri,
        session.privateKey,
        session.peerPublicKeyB64
      );
      const { error } = await supabase.from('messages').insert({
        match_id: matchId,
        sender_id: myId,
        image_path: path,
        content: JSON.stringify(payload),
      });
      if (error) throw new Error(error.message);
      const displayUri = await writeDecryptedImage(bytes, format.mimeType, path);
      setDecryptedImages((prev) => ({ ...prev, [path]: displayUri }));
    } catch (e: any) {
      appAlert.alert('Ошибка', 'Не удалось отправить фото: ' + e.message);
    }
    setUploadingImage(false);
  }

  async function handleBlock() {
    appAlert.alert(
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
              if (error.message.includes('Нельзя заблокировать поддержку')) {
                appAlert.alert('Нельзя заблокировать', 'Аккаунт поддержки заблокировать нельзя.');
              } else {
                appAlert.alert('Ошибка', 'Не удалось заблокировать пользователя.');
              }
              return;
            }
            // ChatList — вкладка нижней навигации, а не экран корневого
            // стека, поэтому идём через Tabs с указанием вложенного экрана.
            navigation.navigate('Tabs', { screen: 'ChatList' });
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
      appAlert.alert(
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
      appAlert.alert('Ошибка', 'Не удалось отправить жалобу.');
      return;
    }
    appAlert.alert('Спасибо', 'Жалоба отправлена на рассмотрение модератору.');
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={handleReport} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>Пожаловаться</Text>
        </TouchableOpacity>
        {!isSupport && (
          <TouchableOpacity onPress={handleBlock} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, styles.blockText]}>Заблокировать</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const isMine = item.sender_id === myId;

          if (item.image_path) {
            const url = item.image_path ? decryptedImages[item.image_path] ?? imageUrls[item.image_path] : null;
            return (
              <View style={[styles.bubble, styles.imageBubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                {url ? (
                  <TouchableOpacity onPress={() => setPreviewUrl(url)}>
                    <Image
                      source={{ uri: url }}
                      style={styles.chatImage}
                      onError={() => refreshImage(item.image_path as string)}
                    />
                  </TouchableOpacity>
                ) : (
                  <View style={[styles.chatImage, styles.chatImageLoading]}>
                    <ActivityIndicator color={colors.white} />
                  </View>
                )}
              </View>
            );
          }

          return (
            <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
              <Text style={isMine ? styles.bubbleTextMine : styles.bubbleTextTheirs}>
                {item.content}
              </Text>
            </View>
          );
        }}
      />

      <View style={[styles.inputRow, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <TouchableOpacity style={styles.attachButton} onPress={handlePickImage} disabled={uploadingImage}>
          {uploadingImage ? (
            <ActivityIndicator color={colors.textFaint} size="small" />
          ) : (
            <Ionicons name="image-outline" size={24} color={colors.textFaint} />
          )}
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholderTextColor={colors.textFaint}
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

      <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
        <View style={styles.previewOverlay}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewUrl(null)}>
            <Ionicons name="close" size={30} color={colors.white} />
          </TouchableOpacity>
          {previewUrl && (
            <Image source={{ uri: previewUrl }} style={styles.previewImage} resizeMode="contain" />
          )}
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerButton: { marginLeft: 16 },
  headerButtonText: { fontSize: 13, color: colors.textSecondary },
  blockText: { color: colors.danger },
  messageList: { padding: 14, flexGrow: 1 },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14, marginBottom: 8 },
  imageBubble: { padding: 4 },
  bubbleMine: { backgroundColor: colors.accent, alignSelf: 'flex-end' },
  bubbleTheirs: { backgroundColor: colors.border, alignSelf: 'flex-start' },
  bubbleTextMine: { color: colors.white, fontSize: 15 },
  bubbleTextTheirs: { color: colors.textPrimary, fontSize: 15 },
  chatImage: { width: 200, height: 200, borderRadius: 10, backgroundColor: colors.surface },
  chatImageLoading: { alignItems: 'center', justifyContent: 'center' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  attachButton: { padding: 8, marginRight: 4, marginBottom: 2 },
  input: {
    backgroundColor: colors.surface,
    color: colors.textPrimary,
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginRight: 8,
    maxHeight: 100,
    fontSize: 15,
  },
  sendButton: { backgroundColor: colors.accent, borderRadius: 18, paddingHorizontal: 16, paddingVertical: 10 },
  sendButtonDisabled: { opacity: 0.5 },
  sendButtonText: { color: colors.white, fontWeight: '600' },
  previewOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.9)', justifyContent: 'center', alignItems: 'center' },
  previewClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    zIndex: 10,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewImage: { width: '100%', height: '80%' },
});
