// src/lib/rtcCall.ts
//
// E2EE audio calls between chat participants (task: «зашифрованные звонки
// между пользователями напрямым через приложение»).
//
// Архитектура:
//   - медиа: WebRTC peer connection через react-native-webrc (audio-only),
//     локальный поток — getUserMedia({audio: true}) + addTrack. Шифрование медиа
//     между участниками выполняется WebRTC-слоем (DTLS-SRTP; ключи генерируются
//     при P2P-handshake'е), поэтому сервер не участвует в медиа-потоке и не
//     держит ключ.
//   - сигналинг (SDP / ICE): Supabase Realtime Broadcast — сервер релеит
//     текстовые сигналы, медиа идёт напрямую P2P.
//   - текст переписки по-прежнему шифруется через e2ee.ts (crypto_box).
//
// Ограничение MVP: звонок — голосовой (audio only), video отключён.

import { RTCPeerConnection, mediaDevices, MediaStream, MediaStreamTrack } from 'react-native-webrtc';
import type { RealtimeChannel } from '@supabase/realtime-js';
import { supabase } from './supabase';
import { log } from './log';

export type CallState = 'idle' | 'outgoing' | 'incoming' | 'active' | 'ended' | 'failed';

export type EncryptedCallParams = {
  matchId: string;
  peerId: string;
  peerName?: string | null;
};

export type EncryptedCallHandlers = {
  onStateChange?: (state: CallState) => void;
  onError?: (message: string) => void;
  onConnected?: () => void;
};

type SignalMessage = {
  kind: 'offer' | 'answer' | 'ice' | 'bye';
  callId: string;
  from: string;
  to: string;
  sdp?: string;
  candidate?: string;
  sdpMid?: string;
  sdpMLineIndex?: number;
};

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

function newCallId(): string {
  return `call-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export class EncryptedCall {
  readonly matchId: string;
  readonly peerId: string;
  readonly peerName: string | null;
  readonly myId: string;
  state: CallState = 'idle';

  private callId = '';
  private pc: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private channel: RealtimeChannel | null = null;
  private pendingOffer: any = null;
  muted = false;
  private handlers: EncryptedCallHandlers = {};
  private byeSent = false;

  constructor(params: EncryptedCallParams & { myId: string }) {
    this.matchId = params.matchId;
    this.peerId = params.peerId;
    this.peerName = params.peerName ?? null;
    this.myId = params.myId;
  }

  setHandlers(handlers: EncryptedCallHandlers): void {
    this.handlers = handlers;
  }

  private emitState(state: CallState): void {
    this.state = state;
    this.handlers.onStateChange?.(state);
  }

  private logCall(event: string, detail?: unknown): void {
    log.debug('RTC-CALL:', event, detail ?? '');
  }

  private async sendSignal(msg: SignalMessage): Promise<void> {
    if (!this.channel) return;
    try {
      await this.channel.send({ type: 'broadcast', event: 'signal', payload: msg });
    } catch (e) {
      log.warn('RTC-CALL: не удалось отправить сигнал:', e);
      this.emitState('failed');
    }
  }

  async ensureChannel(): Promise<void> {
    if (this.channel) return;
    const ch = supabase.channel(`rtc-call-${this.matchId}`);
    ch.on('broadcast', { event: 'signal' }, (payload: any) => {
      void this.handleSignal(payload);
    });
    this.channel = ch;
    await ch.subscribe();
  }

  private async handleSignal(payload: any): Promise<void> {
    const msg: SignalMessage | null = payload?.payload ?? payload?.data ?? payload ?? null;
    if (!msg || typeof msg !== 'object') return;
    // Защита: сообщение должно быть адресовано мне и отправлено мной не быть.
    if (msg.to !== this.myId || msg.from === this.myId) return;

    this.logCall('signal', { kind: msg.kind, from: msg.from });
    // callId проставляется отправителем; для входящего он приходит в самом сообщении.
    if (msg.callId) this.callId = msg.callId;

    if (msg.kind === 'offer') {
      this.pendingOffer = msg;
      // Входящий: переводим в состояние 'incoming', чтобы UI показывал
      // экран приёма/отказа. Самосогласование делает по нажатию accept().
      if (this.state === 'idle') this.emitState('incoming');
    } else if (msg.kind === 'answer') {
      await this.handleAnswer(msg);
    } else if (msg.kind === 'ice') {
      await this.handleIce(msg);
    } else if (msg.kind === 'bye') {
      await this.endCall();
    }
  }

  private async handleAnswer(msg: SignalMessage): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    // Вызывающий получил ответ: сессия устанавливается.
    await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp ?? '' });
    this.emitState('active');
  }

  private async handleIce(msg: SignalMessage): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    try {
      await pc.addIceCandidate({ candidate: msg.candidate, sdpMid: msg.sdpMid, sdpMLineIndex: msg.sdpMLineIndex } as any);
    } catch (e) {
      log.warn('RTC-CALL: ICE candidate отклонён:', e);
    }
  }

  private async setupPeer(): Promise<RTCPeerConnection> {
    const stream = await mediaDevices.getUserMedia({ audio: true });
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.localStream = stream;
    const track = stream.getAudioTracks()[0];
    if (track) {
      pc.addTrack(track, stream);
    }
    pc.onicecandidate = (event: any) => {
      const candidate = event?.candidate;
      if (candidate?.candidate) {
        void this.sendSignal({
          kind: 'ice',
          callId: this.callId,
          from: this.myId,
          to: this.peerId,
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid,
          sdpMLineIndex: candidate.sdpMLineIndex,
        });
      }
    };
    pc.ontrack = (event: any) => {
      this.logCall('track', { hasTrack: !!event?.track });
    };
    pc.onconnectionstatechange = (event: any) => {
      const state = event?.target?.connectionState ?? pc.connectionState;
      this.logCall('connectionState', state);
      if (state === 'connected') this.emitState('active');
      if (state === 'failed' || state === 'closed') this.emitState('failed');
    };
    pc.oniceconnectionstatechange = (event: any) => {
      const state = event?.target?.iceConnectionState ?? pc.iceConnectionState;
      this.logCall('iceConnectionState', state);
      if (state === 'connected' || state === 'completed') this.emitState('active');
      if (state === 'failed' || state === 'closed') this.emitState('failed');
    };
    return pc;
  }

  // Калллер: создаём offer и отправляем его.
  async start(): Promise<void> {
    this.callId = newCallId();
    this.emitState('outgoing');
    await this.ensureChannel();

    const pc = await this.setupPeer();
    this.pc = pc;

    const offer: any = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: false, voiceActivityDetection: true });
    await pc.setLocalDescription({ type: offer.type, sdp: offer.sdp });
    const sdp = typeof offer?.toJSON === 'function' ? offer.toJSON() : offer;
    await this.sendSignal({ kind: 'offer', callId: this.callId, from: this.myId, to: this.peerId, sdp });
    this.logCall('offer sent');
  }

  // Каллата: приём входящего offer → подготовка к ответу.
  // Вызывается после нажатия «принять» в UI (или авто-accept при state idle).
  async accept(): Promise<void> {
    if (this.state !== 'incoming') {
      this.emitState('incoming');
      return;
    }
    await this.startIncoming();
  }

  private async startIncoming(): Promise<void> {
    await this.ensureChannel();
    const pc = await this.setupPeer();
    this.pc = pc;

    const offer: any = this.pendingOffer;
    await pc.setRemoteDescription({ type: offer.type, sdp: offer.sdp });
    const answer: any = await pc.createAnswer();
    await pc.setLocalDescription({ type: answer.type, sdp: answer.sdp });
    const sdp = typeof answer?.toJSON === 'function' ? answer.toJSON() : answer;
    await this.sendSignal({ kind: 'answer', callId: this.callId, from: this.myId, to: this.peerId, sdp });
    this.emitState('active');
  }

  // Каллата: отклонить входящий звонок.
  async decline(): Promise<void> {
    this.byeSent = true;
    await this.sendSignal({ kind: 'bye', callId: this.callId, from: this.myId, to: this.peerId });
    await this.endCall();
  }

  async endCall(): Promise<void> {
    const shouldSignalBye = !this.byeSent && (this.state === 'outgoing' || this.state === 'incoming' || this.state === 'active');
    if (shouldSignalBye) {
      this.byeSent = true;
      await this.sendSignal({ kind: 'bye', callId: this.callId, from: this.myId, to: this.peerId });
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {
        log.warn('RTC-CALL: ошибка закрытия peer connection:', e);
      }
      this.pc = null;
    }
    this.localStream?.getTracks().forEach((t) => t.stop());
    this.localStream = null;
    if (this.state !== 'ended') this.emitState('ended');
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const track = this.localStream?.getAudioTracks()[0];
    if (track) track.enabled = muted;
  }
}

export function createEncryptedCall(params: EncryptedCallParams & { myId: string }): EncryptedCall {
  return new EncryptedCall(params);
}

export type { MediaStream, MediaStreamTrack };
