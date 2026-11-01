// 管线端口的原生实现：把 VadPort / RecognizerPort 落到 crish-asr 本地
// 模块的低层原语上（采样以 Float32 base64 过桥）。
import { getCrishAsrNative, type CrishAsrNativeModule } from 'crish-asr';
import type {
  RecognizerPort,
  SpeechSegmentLike,
  VadPort,
} from '@/domain/asr/simulatedStreamingPipeline';
import { base64ToFloat32, float32ToBase64 } from './base64';

export class NativeVadPort implements VadPort {
  private readonly native: CrishAsrNativeModule;

  constructor(native: CrishAsrNativeModule) {
    this.native = native;
  }

  acceptWaveform(samples: Float32Array): void {
    this.native.vadAccept(float32ToBase64(samples));
  }

  isSpeechDetected(): boolean {
    return this.native.vadIsSpeechDetected();
  }

  isEmpty(): boolean {
    return this.native.vadIsEmpty();
  }

  front(): SpeechSegmentLike {
    const segment = this.native.vadFront();
    if (!segment) throw new Error('VAD 片段队列为空');
    return {
      start: segment.start,
      samples: base64ToFloat32(segment.samplesB64),
    };
  }

  pop(): void {
    this.native.vadPop();
  }

  flush(): void {
    this.native.vadFlush();
  }

  reset(): void {
    this.native.vadReset();
  }
}

export class NativeRecognizerPort implements RecognizerPort {
  private readonly native: CrishAsrNativeModule;

  constructor(native: CrishAsrNativeModule) {
    this.native = native;
  }

  async decode(samples: Float32Array): Promise<string> {
    return this.native.decode(float32ToBase64(samples));
  }
}

/** 原生端口组装（原生模块缺失时返回 null，上层据此诚实降级） */
export function createNativePorts(): {
  vad: VadPort;
  recognizer: RecognizerPort;
} | null {
  const native = getCrishAsrNative();
  if (!native) return null;
  return {
    vad: new NativeVadPort(native),
    recognizer: new NativeRecognizerPort(native),
  };
}

export default createNativePorts;
