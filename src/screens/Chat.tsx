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
import {
  dedupeByNonce,
  deleteMessageForEveryone,
  deleteMessageForMe,
  envelopeNonce,
  fetchHiddenMessageIds,
  loadSeenNonces,
  rememberSeenNonces,
  sendEncryptedMessage,
} from '../lib/messageApi';
import { getPeerKeyStatus, rememberPeerKey } from '../lib/keyTrust';

type Message = {
  id: string;
  match_id: string;
  sender_id: string;
  content: string | null;
  image_path: string | null;
  created_at: string;
  client_message_id?: string | null;
  deleted_at?: string | null;
  read_at?: string | null;
};

const UNDECRYPTABLE = 'Сообщение не удалось расшифровать';

// Если конверт не расшифровался (сменился ключ, нет ключа, повреждённые данные),
// показываем понятный текст вместо JSON с nonce и ciphertext. Legacy-plaintext
// (без конверта) оставляем как есть.
function undecrypted(content: string | null): string | null {
  return envelopeNonce(content) ? UNDECRYPTABLE : content;
}

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
  // params может не быть вовсе, если адрес пришёл без matchId (/chat/):
  // без значения по умолчанию обращение к route.params падало бы при рендере
  // и оставляло пустую страницу.
  const { matchId, otherUserId, otherName, otherAge } = route.params ?? {};
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<Message[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [decryptedImages, setDecryptedImages] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [peerId, setPeerId] = useState<string | null>(otherUserId ?? null);
  const [peerName, setPeerName] = useState<string | null>(null);
  const [peerPhoto, setPeerPhoto] = useState<string | null>(null);
  const [isSupport, setIsSupport] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [peerKeyB64, setPeerKeyB64] = useState<string | null>(null);
  const [peerFingerprint, setPeerFingerprint] = useState<string | null>(null);
  const [keyWarning, setKeyWarning] = useState<{
    fingerprint: string;
    previousFingerprint: string | null;
  } | null>(null);
  const listRef = useRef<FlatList>(null);
  // Синхронный флаг против двойного тапа: setSending обновляется асинхронно, и
  // второй вызов успевает проскочить до перерисовки.
  const sendingRef = useRef(false);
  // nonce уже показанных сообщений: повторный конверт с тем же nonce — replay.
  const seenNoncesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const name = peerName || otherName;
    const title = otherAge ? `${name || 'Чат'}, ${otherAge}` : name || 'Чат';

    // Переход в анкету собеседника прямо из переписки: тап по аватарке в шапке.
    // peerId может прийти позже (при открытии по ссылке chat/:matchId), поэтому
    // эффект зависит от него. У чата поддержки анкеты нет — аватарку не показываем.
    const peerProfileId = isSupport ? null : peerId ?? otherUserId ?? null;
    navigation.setOptions({
      title,
      headerRight: peerProfileId
        ? () => (
            <TouchableOpacity
              onPress={() =>
                navigation.navigate('ProfileDetail', { profileId: peerProfileId, fromChat: true })
              }
              accessibilityRole="button"
              accessibilityLabel="Открыть анкету"
              style={{ paddingHorizontal: 12, paddingVertical: 4 }}
            >
              {peerPhoto ? (
                <Image source={{ uri: peerPhoto }} style={styles.headerAvatar} />
              ) : (
                <Ionicons name="person-circle-outline" size={26} color={colors.textPrimary} />
              )}
            </TouchableOpacity>
          )
        : undefined,
    });
  }, [navigation, otherName, otherAge, peerId, otherUserId, isSupport, peerName, peerPhoto]);

  useEffect(() => {
    // Аватар и имя собеседника. Нужны и при открытии по ссылке chat/:matchId,
    // когда в параметрах есть только matchId: раньше здесь был безусловный
    // запрос с .eq('id', undefined), который PostgREST отклонял ошибкой.
    if (!peerId) {
      setIsSupport(false);
      setPeerName(null);
      setPeerPhoto(null);
      return;
    }

    let cancelled = false;
    supabase
      .from('profile_cards')
      .select('display_name, photo_url, is_admin, profile_hidden')
      .eq('id', peerId)
      .maybeSingle()
      .then(({ data }) => {
        if (cancelled) return;
        const hidden = data?.profile_hidden === true;
        setIsSupport(!!data?.is_admin);
        setPeerName(hidden ? 'Скрытая анкета' : data?.display_name ?? null);
        setPeerPhoto(hidden ? null : data?.photo_url ?? null);
      });

    return () => {
      cancelled = true;
    };
  }, [peerId]);

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

    // Скрытые у себя сообщения не показываем. Удалённые у обоих остаются в
    // списке как «Сообщение удалено», чтобы не рвать порядок. Дубли по nonce
    // отбрасываем: это один и тот же шифртекст, вставленный повторно.
    const rows = data || [];
    const hidden = await fetchHiddenMessageIds(user.id, rows.map((m) => m.id));
    const visible = dedupeByNonce(rows.filter((m) => !hidden.has(m.id)));

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

    // Доверие к ключу собеседника: первый ключ запоминаем молча (TOFU), при
    // смене показываем предупреждение с отпечатком и не даём отправить новое,
    // пока пользователь его не подтвердит.
    if (peerId && peerPublicKeyB64) {
      setPeerKeyB64(peerPublicKeyB64);
      const check = await getPeerKeyStatus(user.id, peerId, peerPublicKeyB64);
      setPeerFingerprint(check.fingerprint);
      if (check.status === 'new') {
        await rememberPeerKey(user.id, peerId, peerPublicKeyB64);
        setKeyWarning(null);
      } else if (check.status === 'changed') {
        setKeyWarning({
          fingerprint: check.fingerprint,
          previousFingerprint: check.previousFingerprint,
        });
      } else {
        setKeyWarning(null);
      }
    }

    // nonce берём из исходных строк: после расшифровки конверта в content уже
    // обычный текст, и replay по нему не отследить.
    if (peerId) {
      const nonces = visible
        .map((m) => envelopeNonce(m.content))
        .filter((n): n is string => !!n);
      // Объединяем с уже сохранёнными: у удалённых сообщений конверта больше
      // нет, но их nonce всё равно должен остаться в списке — иначе повторная
      // вставка старого шифртекста пройдёт как новое сообщение.
      const known = await loadSeenNonces(user.id, peerId);
      for (const n of nonces) known.add(n);
      seenNoncesRef.current = known;
      await rememberSeenNonces(user.id, peerId, nonces);
    }

    const loaded = await Promise.all(
      visible.map(async (m) => {
        if (m.deleted_at) {
          return { ...m, content: null, image_path: null } as Message;
        }

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
          return { ...m, content: undecrypted(m.content) };
        }
        try {
          const text = await decryptText(privateKey, peerPublicKeyB64, m.content);
          return { ...m, content: text };
        } catch (e) {
          log.warn('E2EE: не удалось расшифровать сообщение:', e);
          return { ...m, content: undecrypted(m.content) };
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

  // Ошибку загрузки сообщений нельзя оставлять необработанным промисом:
  // тогда экран молча показывает пустую переписку без объяснения.
  useEffect(() => {
    loadMessages().catch((e) => log.warn('Ошибка загрузки переписки:', e));
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

          // Replay: тот же nonce, что уже показывали. Значит, старый
          // шифртекст вставили повторно — второй раз не показываем.
          const nonce = envelopeNonce(newMessage.content);
          if (nonce && seenNoncesRef.current.has(nonce)) {
            log.warn('E2EE: повторное сообщение (replay) отброшено:', newMessage.id);
            return;
          }
          if (nonce) {
            seenNoncesRef.current.add(nonce);
            if (myId && peerId) {
              void rememberSeenNonces(myId, peerId, [nonce]);
            }
          }

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
              message = { ...newMessage, content: undecrypted(newMessage.content) };
            }
          } else if (newMessage.content) {
            message = { ...newMessage, content: undecrypted(newMessage.content) };
          }
          setMessages((prev) => [...prev, message]);
        }
      )
      // Удаление у обоих приходит как UPDATE: content и image_path очищены,
      // deleted_at заполнен. Сохраняем строку, чтобы показать «Сообщение
      // удалено» на её месте.
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'messages', filter: `match_id=eq.${matchId}` },
        (payload) => {
          const updated = payload.new as Message;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== updated.id) return m;
              if (updated.deleted_at) {
                return { ...m, deleted_at: updated.deleted_at, content: null, image_path: null };
              }
              return { ...m, read_at: updated.read_at };
            })
          );
        }
      )
      // Жёсткое удаление (например, из панели модерации) — убираем строку.
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'messages', filter: `match_id=eq.${matchId}` },
        (payload) => {
          const removed = payload.old as { id?: string };
          if (!removed?.id) return;
          setMessages((prev) => prev.filter((m) => m.id !== removed.id));
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

  // Подтверждение нового ключа собеседника. До этого отправка заблокирована:
  // иначе можно отправить сообщение на подменённый ключ.
  async function acceptPeerKey() {
    if (!myId || !peerId || !peerKeyB64) return;
    await rememberPeerKey(myId, peerId, peerKeyB64);
    setKeyWarning(null);
    await loadMessages();
  }

  async function removeMessageForMe(item: Message) {
    try {
      await deleteMessageForMe(item.id);
      setMessages((prev) => prev.filter((m) => m.id !== item.id));
    } catch (e: any) {
      appAlert.alert('Ошибка', 'Не удалось удалить сообщение: ' + (e?.message ?? ''));
    }
  }

  function confirmRemoveForEveryone(item: Message) {
    appAlert.alert(
      'Удалить у обоих?',
      'Сообщение исчезнет у вас и у собеседника. Восстановить его нельзя.',
      [
        { text: 'Отмена', style: 'cancel' },
        {
          text: 'Удалить',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteMessageForEveryone(item.id, item.image_path);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === item.id
                    ? { ...m, content: null, image_path: null, deleted_at: new Date().toISOString() }
                    : m
                )
              );
            } catch (e: any) {
              appAlert.alert('Ошибка', 'Не удалось удалить сообщение: ' + (e?.message ?? ''));
            }
          },
        },
      ]
    );
  }

  function handleMessageActions(item: Message) {
    if (item.deleted_at) return;
    const isMine = item.sender_id === myId;

    appAlert.alert('Сообщение', 'Что сделать с сообщением?', [
      ...(isMine
        ? [
            {
              text: 'Удалить у обоих',
              style: 'destructive' as const,
              onPress: () => confirmRemoveForEveryone(item),
            },
          ]
        : []),
      {
        text: 'Удалить у себя',
        style: 'destructive' as const,
        onPress: () => removeMessageForMe(item),
      },
      { text: 'Отмена', style: 'cancel' as const },
    ]);
  }

  async function handleSend() {
    if (!text.trim() || !myId || sendingRef.current) return;

    if (keyWarning) {
      appAlert.alert(
        'Ключ собеседника изменился',
        `Новый отпечаток: ${keyWarning.fingerprint}.\n\nЕсли собеседник переустановил приложение или вышел и вошёл заново — это ожидаемо. Сверьте отпечаток по другому каналу связи. Пока ключ не подтверждён, отправка заблокирована.`,
        [
          { text: 'Отмена', style: 'cancel' },
          { text: 'Принять ключ', onPress: () => acceptPeerKey() },
        ]
      );
      return;
    }

    sendingRef.current = true;
    setSending(true);

    const content = text.trim();
    setText('');

    try {
      const session = await prepareSendSession(myId, peerId);
      if (!session.ok) {
        setText(content);
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
      const result = await sendEncryptedMessage({
        matchId,
        senderId: myId,
        payload,
      });

      if (!result.ok) {
        appAlert.alert('Ошибка', 'Не удалось отправить сообщение.');
        setText(content); // возвращаем текст в поле, чтобы не потерять
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
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
      const result = await sendEncryptedMessage({
        matchId,
        senderId: myId,
        payload,
        imagePath: path,
      });
      if (!result.ok) throw new Error(result.error);
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
        {!isSupport && peerFingerprint && (
          <TouchableOpacity
            onPress={() =>
              appAlert.alert(
                'Проверка ключа',
                `Отпечаток ключа собеседника:\n${peerFingerprint}\n\nЕсли он совпадает с тем, что собеседник видит у себя, ключ не подменяли. Смена отпечатка означает переустановку приложения или новое устройство.`
              )
            }
            style={styles.headerButton}
          >
            <Text style={styles.headerButtonText}>Ключ</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={handleReport} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>Пожаловаться</Text>
        </TouchableOpacity>
        {!isSupport && (
          <TouchableOpacity onPress={handleBlock} style={styles.headerButton}>
            <Text style={[styles.headerButtonText, styles.blockText]}>Заблокировать</Text>
          </TouchableOpacity>
        )}
      </View>

      {keyWarning && (
        <View style={styles.keyWarning}>
          <Text style={styles.keyWarningTitle}>Ключ собеседника изменился</Text>
          <Text style={styles.keyWarningText}>
            Новый отпечаток: {keyWarning.fingerprint}. Старые сообщения этим ключом не
            расшифровываются. Если собеседник переустанавливал приложение или выходил из
            аккаунта — это ожидаемо. Сверьте отпечаток по другому каналу связи.
          </Text>
          <TouchableOpacity onPress={acceptPeerKey} style={styles.keyWarningButton}>
            <Text style={styles.keyWarningButtonText}>Принять новый ключ</Text>
          </TouchableOpacity>
        </View>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item, index }) => {
          const isMine = item.sender_id === myId;

          // Аватар собеседника — только у последнего сообщения серии, иначе он
          // повторялся бы у каждого пузыря подряд.
          const next = messages[index + 1];
          const showAvatar = !isMine && (!next || next.sender_id !== item.sender_id);

          const avatar = showAvatar ? (
            peerPhoto ? (
              <Image source={{ uri: peerPhoto }} style={styles.messageAvatar} />
            ) : (
              <View style={[styles.messageAvatar, styles.messageAvatarPlaceholder]}>
                <Text style={styles.messageAvatarLetter}>
                  {(peerName || otherName || '?').charAt(0).toUpperCase()}
                </Text>
              </View>
            )
          ) : null;

          const deleted = !!item.deleted_at;

          let bubble: React.ReactNode;
          if (item.image_path && !deleted) {
            const url = item.image_path ? decryptedImages[item.image_path] ?? imageUrls[item.image_path] : null;
            bubble = (
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
          } else {
            bubble = (
              <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                <Text
                  style={
                    deleted
                      ? styles.deletedText
                      : isMine
                        ? styles.bubbleTextMine
                        : styles.bubbleTextTheirs
                  }
                >
                  {/* content — колонка text, но после сбоя расшифровки или
                      неожиданного ответа сервера там может оказаться не
                      строка. <Text> с объектом роняет дерево React, и вся
                      страница становится пустой. */}
                  {deleted
                    ? 'Сообщение удалено'
                    : typeof item.content === 'string'
                      ? item.content
                      : ''}
                </Text>
              </View>
            );
          }

          return (
            <View style={[styles.messageRow, isMine && styles.messageRowMine]}>
              {!isMine && (avatar ?? <View style={styles.messageAvatarSpacer} />)}
              <TouchableOpacity
                activeOpacity={0.85}
                disabled={deleted}
                delayLongPress={350}
                onLongPress={() => handleMessageActions(item)}
              >
                {bubble}
              </TouchableOpacity>
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
  keyWarning: {
    margin: 10,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: 'rgba(255, 59, 48, 0.08)',
  },
  keyWarningTitle: { color: colors.danger, fontWeight: '700', fontSize: 14, marginBottom: 6 },
  keyWarningText: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  keyWarningButton: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 6 },
  keyWarningButtonText: { color: colors.accent, fontWeight: '600', fontSize: 14 },
  deletedText: { color: colors.textMuted, fontSize: 15, fontStyle: 'italic' },
  messageList: { padding: 14, flexGrow: 1 },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 8 },
  messageRowMine: { justifyContent: 'flex-end' },
  messageAvatar: { width: 30, height: 30, borderRadius: 15, marginRight: 8, backgroundColor: colors.border },
  messageAvatarPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  messageAvatarLetter: { color: colors.textMuted, fontSize: 13, fontWeight: '600' },
  messageAvatarSpacer: { width: 38 },
  headerAvatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.border },
  bubble: { maxWidth: '78%', borderRadius: 14, paddingVertical: 10, paddingHorizontal: 14 },
  imageBubble: { padding: 4 },
  bubbleMine: { backgroundColor: colors.accent },
  bubbleTheirs: { backgroundColor: colors.border },
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
