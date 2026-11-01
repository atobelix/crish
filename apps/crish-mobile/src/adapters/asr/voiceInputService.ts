// 语音输入服务（单例）：引擎生命周期 + 采集会话 + 管线装配。
// - 引擎（228MiB 模型加载）只创建一次并跨会话复用，模型路径变化才重建；
// - 每次按住说话新建一条管线（VAD 状态经 reset 干净起步），把原生帧
//   （Int16 base64）换算为规范 Float32 喂入，并回吐平滑后的波形电平；
// - stop() 停采集后驱动管线 flush 收尾，保证最后半句的 final 先落袋
//   再返回；cancel() 直接复位管线丢弃本句。
import { PermissionsAndroid, Platform } from 'react-native';
import { getCrishAsrNative } from 'crish-asr';
import {
  SimulatedStreamingPipeline,
  type AsrResultEvent,
} from '@/domain/asr/simulatedStreamingPipeline';
import { waveformLevelOf } from '@/domain/asr/voiceInputMachine';
import { base64ToInt16, int16ToFloat32 } from './base64';
import type { AsrModelPaths } from './modelManager';
import { NativeRecognizerPort, NativeVadPort } from './nativeAsrPorts';

export type VoiceStartOutcome =
  | 'started'
  | 'unavailable'
  | 'permission-denied'
  | 'capture-failed'
  | 'engine-failed';

export interface VoiceSessionHandlers {
  onResult: (event: AsrResultEvent) => void;
  onLevel: (level: number) => void;
  onError: (message: string) => void;
}

interface Subscription {
  remove(): void;
}

class VoiceInputService {
  private engineReady = false;
  private engineDir: string | null = null;
  private pipeline: SimulatedStreamingPipeline | null = null;
  private chunkSubscription: Subscription | null = null;
  private errorSubscription: Subscription | null = null;
  private active = false;
  private smoothedLevel = 0;

  /** 本机是否具备离线语音能力（Android + 原生模块在场） */
  isAvailable(): boolean {
    return Platform.OS === 'android' && getCrishAsrNative() !== null;
  }

  /** 麦克风权限（系统弹窗，结果如实返回） */
  async requestPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    const result = await PermissionsAndroid.request(
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      {
        title: '麦克风权限',
        message: '语音输入需要使用麦克风，将你的语音在本机离线识别为文字。',
        buttonPositive: '允许',
        buttonNegative: '拒绝',
      }
    );
    return result === PermissionsAndroid.RESULTS.GRANTED;
  }

  async start(
    paths: AsrModelPaths,
    handlers: VoiceSessionHandlers
  ): Promise<VoiceStartOutcome> {
    const native = getCrishAsrNative();
    if (!native || Platform.OS !== 'android') return 'unavailable';
    if (this.active) return 'started';
    if (!(await this.requestPermission())) return 'permission-denied';
    try {
      if (!this.engineReady || this.engineDir !== paths.dir) {
        await native.createEngine(
          paths.modelPath,
          paths.tokensPath,
          paths.vadModelPath
        );
        this.engineReady = true;
        this.engineDir = paths.dir;
      }
    } catch {
      return 'engine-failed';
    }

    const pipeline = new SimulatedStreamingPipeline({
      vad: new NativeVadPort(native),
      recognizer: new NativeRecognizerPort(native),
      onResult: handlers.onResult,
      onError: () => handlers.onError('识别过程出错'),
    });
    this.pipeline = pipeline;
    this.smoothedLevel = 0;
    pipeline.start();

    this.chunkSubscription = native.addListener('onAudioChunk', (event) => {
      const samples = int16ToFloat32(base64ToInt16(event.data));
      this.smoothedLevel =
        this.smoothedLevel * 0.6 + waveformLevelOf(samples) * 0.4;
      handlers.onLevel(this.smoothedLevel);
      pipeline.accept(samples);
    });
    this.errorSubscription = native.addListener('onCaptureError', (event) => {
      handlers.onError(event.message);
    });

    let captureOk = false;
    try {
      captureOk = await native.startCapture();
    } catch {
      captureOk = false;
    }
    if (!captureOk) {
      this.teardownSession();
      return 'capture-failed';
    }
    this.active = true;
    return 'started';
  }

  /** 正常收尾：停采集 → 管线 flush 并等最后一条 final 落袋 */
  async stop(): Promise<void> {
    const native = getCrishAsrNative();
    if (!native) return;
    native.stopCapture();
    const pipeline = this.pipeline;
    this.teardownSession();
    if (pipeline) await pipeline.stop();
    this.active = false;
  }

  /** 取消：停采集 + 管线复位，本句不产出任何结果 */
  cancel(): void {
    const native = getCrishAsrNative();
    if (!native) return;
    native.stopCapture();
    const pipeline = this.pipeline;
    this.teardownSession();
    pipeline?.reset();
    this.active = false;
  }

  /** 释放引擎（页面销毁/登出时；常态跨会话复用不调用） */
  async release(): Promise<void> {
    this.cancel();
    const native = getCrishAsrNative();
    if (native && this.engineReady) {
      await native.destroyEngine();
      this.engineReady = false;
      this.engineDir = null;
    }
  }

  private teardownSession(): void {
    this.chunkSubscription?.remove();
    this.chunkSubscription = null;
    this.errorSubscription?.remove();
    this.errorSubscription = null;
    this.pipeline = null;
  }
}

export const voiceInputService = new VoiceInputService();

export default voiceInputService;
