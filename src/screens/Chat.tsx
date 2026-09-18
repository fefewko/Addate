// src/screens/Chat.tsx
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  Image,
  Modal,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
  ActionSheetIOS,
} from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { supabase } from '../lib/supabase';
import { uploadChatImage, getSignedChatImageUrls } from '../lib/chatImages';

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
  const navigation = useNavigation<any>();
  const route = useRoute<any>();
  const { matchId, otherUserId, otherName, otherAge } = route.params;
  const insets = useSafeAreaInsets();

  const [messages, setMessages] = useState<Message[]>([]);
  const [imageUrls, setImageUrls] = useState<Record<string, string>>({});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [myId, setMyId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [reportVisible, setReportVisible] = useState(false);
  const [reportCategory, setReportCategory] = useState<string | null>(null);
  const [reportDescription, setReportDescription] = useState('');
  const [reportPhoto, setReportPhoto] = useState<{ uri: string; name: string; type: string } | null>(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const listRef = useRef<FlatList>(null);

  useEffect(() => {
    const title = otherAge ? `${otherName || 'Чат'}, ${otherAge}` : otherName || 'Чат';
    navigation.setOptions({ title });
  }, [navigation, otherName, otherAge]);

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

    const loaded = data || [];
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
        async (payload) => {
          const newMessage = payload.new as Message;
          setMessages((prev) => [...prev, newMessage]);
          if (newMessage.image_path) {
            const urls = await getSignedChatImageUrls([newMessage.image_path]);
            setImageUrls((prev) => ({ ...prev, ...urls }));
          }
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

  async function handlePickImage() {
    if (!myId || uploadingImage) return;

    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Нужен доступ', 'Разрешите доступ к галерее, чтобы отправить фото.');
      return;
    }

    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.6,
    });

    if (result.canceled || !result.assets?.[0]?.uri) return;

    setUploadingImage(true);
    try {
      const path = await uploadChatImage(matchId, result.assets[0].uri);
      const { error } = await supabase.from('messages').insert({
        match_id: matchId,
        sender_id: myId,
        image_path: path,
      });
      if (error) throw new Error(error.message);
    } catch (e: any) {
      Alert.alert('Ошибка', 'Не удалось отправить фото: ' + e.message);
    }
    setUploadingImage(false);
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

  function handleReport() { setReportVisible(true); }

  async function pickReportPhoto() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) { Alert.alert('Нужен доступ', 'Разрешите доступ к галерее, чтобы прикрепить фото к жалобе.'); return; }
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.7 });
    if (result.canceled || !result.assets?.[0]?.uri) return;
    const asset = result.assets[0];
    setReportPhoto({ uri: asset.uri, name: asset.fileName || ('report-' + Date.now() + '.jpg'), type: asset.mimeType || 'image/jpeg' });
  }

  async function submitReport() {
    if (!myId || !reportCategory || reportSubmitting) return;
    setReportSubmitting(true);
    try {
      const { data: report, error } = await supabase.from('reports').insert({
        reporter_id: myId, reported_id: otherUserId, category: reportCategory,
        description: reportDescription.trim() || null,
      }).select('id').single();
      if (error || !report) throw new Error(error?.message || 'Не удалось создать жалобу.');
      if (reportPhoto) {
        const ext = reportPhoto.name.split('.').pop()?.toLowerCase() || 'jpg';
        const path = myId + '/' + report.id + '/evidence-' + Date.now() + '.' + ext;
        const response = await fetch(reportPhoto.uri);
        const blob = await response.blob();
        const { error: uploadError } = await supabase.storage.from('report-images').upload(path, blob, { contentType: reportPhoto.type, upsert: false });
        if (uploadError) throw new Error(uploadError.message);
        const { error: attachmentError } = await supabase.from('report_attachments').insert({ report_id: report.id, storage_path: path });
        if (attachmentError) throw new Error(attachmentError.message);
      }
      setReportVisible(false); setReportCategory(null); setReportDescription(''); setReportPhoto(null);
      Alert.alert('Спасибо', 'Жалоба отправлена на рассмотрение модератору.');
    } catch (e: any) { Alert.alert('Ошибка', 'Не удалось отправить жалобу: ' + e.message); }
    finally { setReportSubmitting(false); }
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
        <TouchableOpacity onPress={handleBlock} style={styles.headerButton}>
          <Text style={[styles.headerButtonText, styles.blockText]}>Заблокировать</Text>
        </TouchableOpacity>
      </View>

      <Modal visible={reportVisible} animationType="slide" transparent onRequestClose={() => !reportSubmitting && setReportVisible(false)}>
        <View style={styles.reportOverlay}><View style={styles.reportSheet}>
          <Text style={styles.reportTitle}>Пожаловаться</Text>
          <Text style={styles.reportHint}>Выберите причину</Text>
          {REPORT_CATEGORIES.map((item) => (
            <TouchableOpacity key={item.value} style={styles.reportOption} onPress={() => setReportCategory(item.value)}>
              <View style={[styles.radio, reportCategory === item.value && styles.radioSelected]} /><Text style={styles.reportOptionText}>{item.label}</Text>
            </TouchableOpacity>
          ))}
          <TextInput style={styles.reportDescription} placeholder="Опишите, что сделал пользователь (необязательно)" placeholderTextColor="#8a8a8e" value={reportDescription} onChangeText={setReportDescription} multiline maxLength={2000} />
          <TouchableOpacity style={styles.reportPhotoButton} onPress={pickReportPhoto} disabled={reportSubmitting}>
            <Ionicons name="image-outline" size={22} color="#f0f0f0" /><Text style={styles.reportPhotoText}>{reportPhoto ? 'Фото прикреплено ✓' : 'Прикрепить фото'}</Text>
          </TouchableOpacity>
          {reportPhoto && <Image source={{ uri: reportPhoto.uri }} style={styles.reportPhotoPreview} />}
          <TouchableOpacity style={[styles.reportSubmit, (!reportCategory || reportSubmitting) && styles.sendButtonDisabled]} onPress={submitReport} disabled={!reportCategory || reportSubmitting}>
            {reportSubmitting ? <ActivityIndicator color="#fff" /> : <Text style={styles.reportSubmitText}>Отправить жалобу</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.reportCancel} onPress={() => setReportVisible(false)} disabled={reportSubmitting}><Text style={styles.reportCancelText}>Отмена</Text></TouchableOpacity>
        </View></View>
      </Modal>

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messageList}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        renderItem={({ item }) => {
          const isMine = item.sender_id === myId;

          if (item.image_path) {
            const url = imageUrls[item.image_path];
            return (
              <View style={[styles.bubble, styles.imageBubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                {url ? (
                  <TouchableOpacity onPress={() => setPreviewUrl(url)}>
                    <Image source={{ uri: url }} style={styles.chatImage} />
                  </TouchableOpacity>
                ) : (
                  <View style={[styles.chatImage, styles.chatImageLoading]}>
                    <ActivityIndicator color="#fff" />
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
            <ActivityIndicator color="#8a8a8e" size="small" />
          ) : (
            <Ionicons name="image-outline" size={24} color="#8a8a8e" />
          )}
        </TouchableOpacity>
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

      <Modal visible={!!previewUrl} transparent animationType="fade" onRequestClose={() => setPreviewUrl(null)}>
        <View style={styles.previewOverlay}>
          <TouchableOpacity style={styles.previewClose} onPress={() => setPreviewUrl(null)}>
            <Ionicons name="close" size={30} color="#fff" />
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
  imageBubble: { padding: 4 },
  bubbleMine: { backgroundColor: '#3b82f6', alignSelf: 'flex-end' },
  bubbleTheirs: { backgroundColor: '#2a2a2a', alignSelf: 'flex-start' },
  bubbleTextMine: { color: '#fff', fontSize: 15 },
  bubbleTextTheirs: { color: '#f0f0f0', fontSize: 15 },
  chatImage: { width: 200, height: 200, borderRadius: 10, backgroundColor: '#1c1c1e' },
  chatImageLoading: { alignItems: 'center', justifyContent: 'center' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: '#2a2a2a',
  },
  attachButton: { padding: 8, marginRight: 4, marginBottom: 2 },
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
  reportOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' },
  reportSheet: { backgroundColor: '#121212', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '90%' },
  reportTitle: { fontSize: 20, fontWeight: '700', color: '#f0f0f0', marginBottom: 16 },
  reportHint: { fontSize: 14, color: '#a0a0a5', marginBottom: 10 },
  reportOption: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 }, reportOptionText: { color: '#f0f0f0', fontSize: 15 },
  reportDescription: { minHeight: 90, maxHeight: 150, backgroundColor: '#1c1c1e', color: '#f0f0f0', borderWidth: 1, borderColor: '#2a2a2a', borderRadius: 10, padding: 12, textAlignVertical: 'top', marginTop: 8 },
  reportPhotoButton: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, gap: 8 }, reportPhotoText: { color: '#f0f0f0', fontSize: 15 }, reportPhotoPreview: { width: 90, height: 90, borderRadius: 8, marginBottom: 10 },
  reportSubmit: { backgroundColor: '#ef4444', borderRadius: 10, padding: 15, alignItems: 'center', marginTop: 6 }, reportSubmitText: { color: '#fff', fontWeight: '600', fontSize: 15 }, reportCancel: { padding: 14, alignItems: 'center' }, reportCancelText: { color: '#a0a0a5', fontSize: 14 },
});
