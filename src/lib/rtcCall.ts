// src/lib/rtcCall.ts
//
// E2EE audio calls between chat participants (task: «зашифрованные звонки
// между пользователями напрямую через приложение»).
//
// Архитектура:
//   - медиа: WebRTC peer connection через react-native-webrtc (audio-only),
//     локальный поток — getUserMedia({audio: true}) + addTrack. Шифрование медиа
//     между участниками выполняет WebRTC-слой (DTLS-SRTP; ключи генерируются
//     при P2P-handshake'е), поэтому сервер не участвует в медиа-потоке и не
//     держит ключ.
//   - сигналинг (SDP / ICE): Supabase Realtime Broadcast — сервер релеит
//     текстовые сигналы, медиа идёт напрямую P2P.
//   - текст переписки по-прежнему шифруется через e2ee.ts (crypto_box).
//
// Почему сигналинг двухканальный:
//   Broadcast в Supabase не хранит историю: сообщение получают только те, кто
//   уже подписан на канал. Раньше вызываемый подписывался на rtc-call-<matchId>
//   только после открытия CallScreen, но открыть его было некому — входящий
//   вызов нигде не всплывал, и offer терялся. Теперь:
//     1. вызывающий подписывается на rtc-call-<callId> и отправляет invite в
//        rtc-invite-<peerId> (на этот канал вызываемый подписан глобально);
//     2. вызываемый открывает CallScreen, подписывается на rtc-call-<callId>
//        и отвечает ready;
//     3. только после ready вызывающий шлёт offer.
//   Так offer не может прийти раньше подписки.
//
// Ограничение MVP: звонок — голосовой (audio only), video отключён.

import { Platform, PermissionsAndroid } from 'react-native';
import { RTCPeerConnection, mediaDevices, MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type { RealtimeChannel } from '@supabase/realtime-js';
import { supabase } from './supabase';
import { errorMessage, log } from './log';

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active' | 'ended' | 'failed';

export type EncryptedCallParams = {
  matchId: string;
  peerId: string;
  peerName?: string | null;
  // callId известен вызываемому из invite. У вызывающего он генерируется
  // в start(); передавать его сюда не обязательно.
  callId?: string;
};

export type EncryptedCallHandlers = {
  onStateChange?: (state: CallState) => void;
  onError?: (message: string) => void;
  onConnected?: () => void;
  // Строка диагностики для экрана звонка. В релизной сборке log.debug
  // отключён, поэтому без этого канала причину сбоя на устройстве не видно.
  onLog?: (line: string) => void;
};

type SignalKind = 'invite' | 'ready' | 'offer' | 'answer' | 'ice' | 'bye';

type SignalMessage = {
  kind: SignalKind;
  callId: string;
  matchId?: string;
  from: string;
  to: string;
  fromName?: string | null;
  // Всегда строка SDP. Объект RTCSessionDescription тоже принимаем при разборе:
  // раньше здесь уходил offer.toJSON(), а читался как строка.
  sdp?: string | RTCSessionDescriptionLike;
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
};

type RTCSessionDescriptionLike = {
  type?: string;
  sdp?: string;
};

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Сколько ждём, пока вызываемый откроет экран и подтвердит готовность.
const READY_TIMEOUT_MS = 25_000;
const SUBSCRIBE_TIMEOUT_MS = 12_000;
const LOG_LIMIT = 120;

function newCallId(): string {
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Приводим SDP к строке. Старые версии приложения отправляли объект
// RTCSessionDescription ({type, sdp}); новые — строку. Обе формы должны
// читаться одинаково, иначе setRemoteDescription получает мусор.
function sdpText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const sdp = (value as RTCSessionDescriptionLike).sdp;
    if (typeof sdp === 'string') return sdp;
  }
  return '';
}

function sdpSummary(sdp: string): string {
  if (!sdp) return 'пустой SDP';
  const hasAudio = /(^|\r?\n)m=audio /.test(sdp);
  const hasVideo = /(^|\r?\n)m=video /.test(sdp);
  return `${sdp.length} байт, audio=${hasAudio ? 'да' : 'нет'}, video=${hasVideo ? 'да' : 'нет'}`;
}

function shortId(id: string): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function nowStamp(): string {
  const d = new Date();
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export class EncryptedCall {
  readonly matchId: string;
  readonly peerId: string;
  readonly peerName: string | null;
  readonly myId: string;
  state: CallState = 'idle';

  private callId: string;
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private callChannel: RealtimeChannel | null = null;
  private inviteChannel: RealtimeChannel | null = null;
  private pendingOffer: SignalMessage | null = null;
  private pendingCandidates: any[] = [];
  private remoteDescriptionSet = false;
  private readyResolve: (() => void) | null = null;
  private readyPromise: Promise<void> | null = null;
  private connectedNotified = false;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastCandidatePair = '';
  private audioSeen = false;
  muted = false;
  private handlers: EncryptedCallHandlers = {};
  private byeSent = false;
  private ending = false;
  private logs: string[] = [];

  constructor(params: EncryptedCallParams & { myId: string }) {
    this.matchId = params.matchId;
    this.peerId = params.peerId;
    this.peerName = params.peerName ?? null;
    this.myId = params.myId;
    this.callId = params.callId ?? '';
  }

  setHandlers(handlers: EncryptedCallHandlers): void {
    this.handlers = handlers;
  }

  getCallId(): string {
    return this.callId;
  }

  private emitState(state: CallState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private logLine(event: string, detail?: unknown): void {
    let suffix = '';
    if (detail !== undefined) {
      if (typeof detail === 'string') {
        suffix = ` ${detail}`;
      } else {
        try {
          suffix = ` ${JSON.stringify(detail)}`;
        } catch {
          suffix = ` ${String(detail)}`;
        }
      }
    }
    const line = `${nowStamp()} ${event}${suffix}`;
    this.logs.push(line);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
    log.debug('RTC-CALL:', line);
    this.handlers.onLog?.(line);
  }

  private fail(message: string): void {
    if (this.ending || this.state === 'ended') return;
    this.logLine('ОШИБКА:', message);
    this.handlers.onError?.(message);
    this.emitState('failed');
  }

  private async sendSignal(msg: SignalMessage): Promise<boolean> {
    if (!this.callChannel) {
      this.logLine('сигнал не отправлен: нет канала', msg.kind);
      return false;
    }
    try {
      const result: any = await this.callChannel.send({
        type: 'broadcast',
        event: 'signal',
        payload: msg,
      });
      if (result && result !== 'ok' && result !== true) {
        this.logLine('сигнал отправлен с ответом', { kind: msg.kind, result: String(result) });
      }
      return true;
    } catch (e) {
      this.logLine('не удалось отправить сигнал', { kind: msg.kind, error: errorMessage(e) });
      return false;
    }
  }

  private async subscribeChannel(channel: RealtimeChannel, label: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean, status: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.logLine(`${label}: ${status}`);
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false, 'таймаут подписки'), SUBSCRIBE_TIMEOUT_MS);
      try {
        channel.subscribe((status: string) => {
          if (status === 'SUBSCRIBED') finish(true, 'подписан');
          else if (status === 'CHANNEL_ERROR') finish(false, 'ошибка канала');
          else if (status === 'TIMED_OUT') finish(false, 'таймаут');
          else if (status === 'CLOSED') finish(false, 'закрыт');
          else this.logLine(`${label}: статус`, status);
        });
      } catch (e) {
        finish(false, `исключение: ${errorMessage(e)}`);
      }
    });
  }

  // Подписка на канал конкретного звонка. Публичная: вызываемый должен
  // подписаться и подтвердить готовность до того, как вызывающий отправит offer.
  async ensureChannel(): Promise<boolean> {
    if (this.callChannel) return true;
    if (!this.callId) {
      this.logLine('ensureChannel: callId ещё не известен');
      return false;
    }
    const name = `rtc-call-${this.callId}`;
    const channel = supabase.channel(name, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: 'signal' }, (payload: any) => {
      void this.handleSignal(payload);
    });
    this.callChannel = channel;
    const ok = await this.subscribeChannel(channel, `канал ${shortId(name)}`);
    if (!ok) {
      this.fail('Не удалось подключиться к каналу сигналинга. Проверьте интернет.');
      return false;
    }
    return true;
  }

  // Вызываемый: подтверждаем вызывающему, что канал готов и можно слать offer.
  async notifyReady(): Promise<void> {
    this.logLine('готовность отправлена');
    await this.sendSignal({
      kind: 'ready',
      callId: this.callId,
      matchId: this.matchId,
      from: this.myId,
      to: this.peerId,
    });
  }

  private async handleSignal(payload: any): Promise<void> {
    const msg: SignalMessage | null = payload?.payload ?? payload?.data ?? payload ?? null;
    if (!msg || typeof msg !== 'object') return;
    if (msg.to !== this.myId || msg.from === this.myId) return;

    // Сигналы чужого/старого звонка игнорируем: канал привязан к callId,
    // но лишняя защита не мешает.
    if (this.callId && msg.callId && msg.callId !== this.callId) {
      this.logLine('чужой сигнал проигнорирован', { kind: msg.kind, callId: shortId(msg.callId) });
      return;
    }
    if (!this.callId && msg.callId) this.callId = msg.callId;

    this.logLine('принят сигнал', { kind: msg.kind, from: shortId(msg.from) });

    if (msg.kind === 'ready') {
      this.readyResolve?.();
      this.readyResolve = null;
    } else if (msg.kind === 'offer') {
      this.pendingOffer = msg;
      if (this.state === 'idle' || this.state === 'outgoing') this.emitState('incoming');
    } else if (msg.kind === 'answer') {
      await this.handleAnswer(msg);
    } else if (msg.kind === 'ice') {
      await this.handleIce(msg);
    } else if (msg.kind === 'bye') {
      this.byeSent = true;
      this.logLine('собеседник завершил звонок');
      await this.endCall();
    }
  }

  private async handleAnswer(msg: SignalMessage): Promise<void> {
    const pc = this.pc;
    if (!pc) {
      this.logLine('answer получен без peer connection');
      return;
    }
    const sdp = sdpText(msg.sdp);
    if (!sdp) {
      this.logLine('answer без SDP');
      return;
    }
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      this.remoteDescriptionSet = true;
      this.logLine('remote answer установлен', sdpSummary(sdp));
      await this.flushPendingCandidates();
    } catch (e) {
      this.fail('Не удалось применить ответ собеседника: ' + errorMessage(e));
    }
  }

  private async handleIce(msg: SignalMessage): Promise<void> {
    if (!msg.candidate) return;
    const init = {
      candidate: msg.candidate,
      sdpMid: msg.sdpMid ?? null,
      sdpMLineIndex: msg.sdpMLineIndex ?? 0,
    };

    // Кандидаты приходят сразу после создания offer, часто раньше, чем
    // вызываемый нажал «принять» и установил remote description. Без очереди
    // addIceCandidate падает, и соединение не собирается.
    if (!this.pc || !this.remoteDescriptionSet) {
      this.pendingCandidates.push(init);
      this.logLine('ICE в очередь', `${init.candidate.slice(0, 24)}… (всего ${this.pendingCandidates.length})`);
      return;
    }
    try {
      await this.pc.addIceCandidate(init as any);
      this.logLine('ICE добавлен', `${init.candidate.slice(0, 24)}…`);
    } catch (e) {
      this.logLine('ICE отклонён', errorMessage(e));
    }
  }

  private async flushPendingCandidates(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    if (queued.length) this.logLine('разбираю очередь ICE', queued.length);
    for (const init of queued) {
      try {
        await pc.addIceCandidate(init);
      } catch (e) {
        this.logLine('ICE из очереди отклонён', errorMessage(e));
      }
    }
  }

  private async ensureMicrophonePermission(): Promise<void> {
    if (Platform.OS !== 'android') return;
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
    this.logLine('разрешение на микрофон', result);
    if (result !== PermissionsAndroid.RESULTS.GRANTED) {
      throw new Error('Нет разрешения на микрофон. Разрешите его в настройках приложения.');
    }
  }

  private async setupPeer(): Promise<RTCPeerConnection> {
    await this.ensureMicrophonePermission();

    this.logLine('запрашиваю микрофон');
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.localStream = stream;
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Микрофон не вернул аудиодорожку.');
    this.logLine('микрофон получен', { tracks: stream.getTracks().length, label: track.label || '—' });
    pc.addTrack(track, stream);

    pc.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (!candidate?.candidate) {
        this.logLine('ICE: сбор кандидатов завершён');
        return;
      }
      void this.sendSignal({
        kind: 'ice',
        callId: this.callId,
        from: this.myId,
        to: this.peerId,
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid ?? null,
        sdpMLineIndex: candidate.sdpMLineIndex ?? 0,
      });
    };
    pc.onicecandidateerror = (event: any) => {
      this.logLine('ICE: ошибка кандидата', {
        code: event?.errorCode,
        text: event?.errorText,
        url: event?.url,
      });
    };
    pc.onicegatheringstatechange = () => {
      this.logLine('ICE gathering', pc.iceGatheringState);
    };
    pc.onsignalingstatechange = () => {
      this.logLine('signaling', pc.signalingState);
    };
    pc.ontrack = (event: any) => {
      const streamFromEvent = event?.streams?.[0];
      this.remoteStream = streamFromEvent ?? null;
      this.logLine('получена удалённая дорожка', {
        kind: event?.track?.kind ?? '—',
        stream: !!streamFromEvent,
      });
      if (this.state !== 'ended' && this.state !== 'failed') {
        // Аудио на Android/iOS воспроизводится самим WebRTC-модулем;
        // RTCView для audio-only не нужен.
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.logLine('connectionState', state);
      if (this.ending || this.state === 'ended') return;
      if (state === 'connected') this.onPeerConnected();
      if (state === 'failed' || state === 'closed') {
        this.fail('Соединение с собеседником прервано (' + state + ').');
      }
    };
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      this.logLine('iceConnectionState', state);
      if (this.ending || this.state === 'ended') return;
      if (state === 'connected' || state === 'completed') this.onPeerConnected();
      if (state === 'failed') {
        this.fail('Не удалось установить прямое соединение (ICE failed).');
      }
    };

    this.startStatsPolling();
    return pc;
  }

  private onPeerConnected(): void {
    if (this.connectedNotified || this.ending) return;
    this.connectedNotified = true;
    this.logLine('СОЕДИНЕНИЕ УСТАНОВЛЕНО');
    this.emitState('active');
    this.handlers.onConnected?.();
  }

  private startStatsPolling(): void {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(() => {
      void this.pollStats();
    }, 3000);
  }

  private stopStatsPolling(): void {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async pollStats(): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      const report: any = await pc.getStats();
      const byId: Record<string, any> = {};
      let pair: any = null;
      let inbound: any = null;
      report?.forEach?.((stat: any) => {
        byId[stat.id] = stat;
        if (stat.type === 'candidate-pair' && (stat.selected || stat.state === 'succeeded')) {
          pair = stat;
        }
        if (stat.type === 'inbound-rtp' && (stat.kind === 'audio' || stat.mediaType === 'audio')) {
          inbound = stat;
        }
      });

      if (pair) {
        const local = byId[pair.localCandidateId];
        const remote = byId[pair.remoteCandidateId];
        const summary = `${local?.candidateType ?? '?'} → ${remote?.candidateType ?? '?'} (${pair.state ?? '?'})`;
        if (summary !== this.lastCandidatePair) {
          this.lastCandidatePair = summary;
          this.logLine('stats: пара кандидатов', summary);
        }
      }

      if (inbound && !this.audioSeen && (inbound.bytesReceived ?? 0) > 0) {
        this.audioSeen = true;
        this.logLine('stats: входящее аудио пошло', {
          bytes: inbound.bytesReceived,
          packets: inbound.packetsReceived,
        });
      }
    } catch (e) {
      this.logLine('stats: ошибка', errorMessage(e));
    }
  }

  private async getMyDisplayName(): Promise<string | null> {
    try {
      const { data } = await supabase.rpc('my_profile').maybeSingle();
      const name = (data as { display_name?: string | null } | null)?.display_name;
      return name ?? null;
    } catch {
      return null;
    }
  }

  private async sendInvite(): Promise<void> {
    const name = `rtc-invite-${this.peerId}`;
    const channel = supabase.channel(name, { config: { broadcast: { self: false } } });
    this.inviteChannel = channel;
    const ok = await this.subscribeChannel(channel, `канал приглашения ${shortId(name)}`);
    if (!ok) {
      this.logLine('не удалось подписаться на канал приглашения');
      return;
    }
    const fromName = await this.getMyDisplayName();
    try {
      await channel.send({
        type: 'broadcast',
        event: 'invite',
        payload: {
          kind: 'invite',
          callId: this.callId,
          matchId: this.matchId,
          from: this.myId,
          to: this.peerId,
          fromName,
        },
      });
      this.logLine('приглашение отправлено', { peer: shortId(this.peerId), fromName: fromName ?? '—' });
    } catch (e) {
      this.logLine('приглашение не отправлено', errorMessage(e));
    }
  }

  private waitForReady(): Promise<boolean> {
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.readyResolve = null;
        resolve(false);
      }, READY_TIMEOUT_MS);
      void this.readyPromise!.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // Вызывающий: генерируем callId, подписываемся, приглашаем, ждём ready,
  // только затем создаём offer.
  async start(): Promise<void> {
    if (this.state !== 'idle') return;
    if (!this.peerId) throw new Error('Не указан собеседник для звонка.');
    this.callId = newCallId();
    this.emitState('outgoing');
    this.logLine('звонок начат', {
      callId: shortId(this.callId),
      matchId: shortId(this.matchId),
      peer: shortId(this.peerId),
    });

    if (!(await this.ensureChannel())) return;

    const ready = this.waitForReady();
    await this.sendInvite();
    const isReady = await ready;
    if (!isReady) {
      this.fail('Собеседник не ответил. Убедитесь, что приложение открыто у обоих и есть интернет.');
      return;
    }
    this.logLine('собеседник готов, отправляю offer');

    const pc = await this.setupPeer();
    this.pc = pc;

    try {
      const offer: any = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: false,
        voiceActivityDetection: true,
      });
      await pc.setLocalDescription({ type: offer.type, sdp: offer.sdp });
      const sdp = sdpText(offer.sdp);
      this.logLine('local offer установлен', sdpSummary(sdp));
      await this.sendSignal({
        kind: 'offer',
        callId: this.callId,
        matchId: this.matchId,
        from: this.myId,
        to: this.peerId,
        sdp,
      });
      this.logLine('offer отправлен');
    } catch (e) {
      this.fail('Не удалось создать предложение соединения: ' + errorMessage(e));
    }
  }

  // Вызываемый: приём входящего offer → подготовка к ответу.
  // Вызывается после нажатия «принять» в UI (кнопка в CallScreen).
  async accept(): Promise<void> {
    if (this.state !== 'incoming') {
      this.logLine('accept: нет входящего предложения', this.state);
      return;
    }
    this.emitState('connecting');
    await this.startIncoming();
  }

  private async startIncoming(): Promise<void> {
    if (!(await this.ensureChannel())) return;

    const offer = this.pendingOffer;
    const offerSdp = sdpText(offer?.sdp);
    if (!offer || !offerSdp) {
      this.fail('Входящий звонок пришёл без корректного описания соединения.');
      return;
    }

    const pc = await this.setupPeer();
    this.pc = pc;

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
      this.remoteDescriptionSet = true;
      this.logLine('remote offer установлен', sdpSummary(offerSdp));
      await this.flushPendingCandidates();

      const answer: any = await pc.createAnswer();
      await pc.setLocalDescription({ type: answer.type, sdp: answer.sdp });
      const answerSdp = sdpText(answer.sdp);
      this.logLine('local answer установлен', sdpSummary(answerSdp));
      await this.sendSignal({
        kind: 'answer',
        callId: this.callId,
        matchId: this.matchId,
        from: this.myId,
        to: this.peerId,
        sdp: answerSdp,
      });
      this.logLine('answer отправлен');
      this.emitState('connecting');
    } catch (e) {
      this.fail('Не удалось принять звонок: ' + errorMessage(e));
    }
  }

  // Вызываемый: отклонить входящий звонок.
  async decline(): Promise<void> {
    if (!this.byeSent) {
      this.byeSent = true;
      await this.sendSignal({ kind: 'bye', callId: this.callId, from: this.myId, to: this.peerId });
    }
    await this.endCall();
  }

  async endCall(): Promise<void> {
    this.ending = true;
    const shouldSignalBye =
      !this.byeSent && (this.state === 'outgoing' || this.state === 'incoming' || this.state === 'connecting' || this.state === 'active');
    if (shouldSignalBye) {
      this.byeSent = true;
      await this.sendSignal({ kind: 'bye', callId: this.callId, from: this.myId, to: this.peerId });
    }
    this.stopStatsPolling();

    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {
        log.warn('RTC-CALL: ошибка закрытия peer connection:', e);
      }
      this.pc = null;
    }
    this.remoteDescriptionSet = false;
    this.pendingCandidates = [];
    this.remoteStream = null;

    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;

    if (this.inviteChannel) {
      const channel = this.inviteChannel;
      this.inviteChannel = null;
      void supabase.removeChannel(channel);
    }
    if (this.callChannel) {
      const channel = this.callChannel;
      this.callChannel = null;
      void supabase.removeChannel(channel);
    }

    this.logLine('звонок завершён');
    if (this.state !== 'ended') this.emitState('ended');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const track = this.localStream?.getAudioTracks()[0];
    if (track) {
      // enabled = true — микрофон передаёт звук; mute должен выключать дорожку.
      track.enabled = !muted;
    }
    this.logLine(muted ? 'микрофон выключен' : 'микрофон включён');
  }
}

export function createEncryptedCall(params: EncryptedCallParams & { myId: string }): EncryptedCall {
  return new EncryptedCall(params);
}

export type { MediaStream, MediaStreamTrack };
