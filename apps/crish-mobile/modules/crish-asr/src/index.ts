// crish-asr 本地模块的 TS 门面：惰性加载原生模块，非 Android / 原生缺失
// （jest、Web、未 prebuild 的环境）时返回 null，由上层诚实降级为不可用，
// 绝不在导入期触碰原生导致崩溃。
import { requireNativeModule, type EventSubscription } from 'expo-modules-core';

/** VAD 片段载荷：start 为全流采样偏移，samplesB64 为 Float32 LE base64 */
export interface VadSegmentPayload {
  start: number;
  samplesB64: string;
}

/** 麦克风帧事件：data 为 Int16 LE base64（16kHz 单声道） */
export interface AudioChunkEvent {
  data: string;
}

export interface CaptureErrorEvent {
  message: string;
}

export interface CrishAsrNativeModule {
  /** 对本地文件计算 SHA-256 哈希字符串（全原生 IO + 硬件加速，毫秒级返回） */
  fileSha256(filePath: string): Promise<string>;
  /** 以本地模型文件创建识别器 + VAD（参数为规范锁定值，见 Kotlin 侧） */
  createEngine(
    modelPath: string,
    tokensPath: string,
    vadModelPath: string
  ): Promise<void>;
  /** 释放识别器 / VAD / 采集句柄 */
  destroyEngine(): Promise<void>;
  vadAccept(samplesB64: string): void;
  vadIsSpeechDetected(): boolean;
  vadIsEmpty(): boolean;
  vadFront(): VadSegmentPayload | null;
  vadPop(): void;
  vadFlush(): void;
  vadReset(): void;
  /** 对一段 Float32 采样做离线解码，返回识别文本 */
  decode(samplesB64: string): Promise<string>;
  /** 开始麦克风采集（帧经 onAudioChunk 事件推送）；false = 采集不可用 */
  startCapture(): Promise<boolean>;
  stopCapture(): void;
  addListener(
    eventName: 'onAudioChunk',
    listener: (event: AudioChunkEvent) => void
  ): EventSubscription;
  addListener(
    eventName: 'onCaptureError',
    listener: (event: CaptureErrorEvent) => void
  ): EventSubscription;
}

let cached: CrishAsrNativeModule | null | undefined;

export function getCrishAsrNative(): CrishAsrNativeModule | null {
  if (cached !== undefined) return cached;
  try {
    cached = requireNativeModule<CrishAsrNativeModule>('CrishAsr');
  } catch {
    cached = null;
  }
  return cached;
}

export function isCrishAsrAvailable(): boolean {
  return getCrishAsrNative() !== null;
}

/**
 * 原生文件 SHA-256 计算契约转发：全原生 IO + 硬件加速，毫秒级返回 64 位小写十六进制字符串。
 * 原生模块不可用时抛出异常。
 */
export async function fileSha256(filePath: string): Promise<string> {
  const native = getCrishAsrNative();
  if (!native?.fileSha256) {
    throw new Error('原生 CrishAsr.fileSha256 模块不可用');
  }
  return native.fileSha256(filePath);
}

export default getCrishAsrNative;
