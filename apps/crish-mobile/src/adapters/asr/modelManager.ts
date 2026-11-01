// 离线 ASR 模型管理器：首次使用按需下载 + 完整性校验 + 本地落盘。
//
// 决策（用户规范 2026-11-01）：SenseVoice 模型实测 239,233,841 字节
// （≈228MiB），严禁塞进 APK/assets；改为首次触发语音时按需下载到
// 应用文档目录，逐文件以固定 SHA-256 校验（哈希自官方 GitHub 发布包
// 提取并与 HF 镜像的 LFS 元数据交叉核对一致）。下载源只是传输通道，
// 内容可信度由固定哈希保证，与来源无关。
// 状态机对 UI 诚实：缺失 / 下载中（带进度）/ 校验中 / 就绪 / 失败可重试，
// 不伪装「已就绪」。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as FileSystem from 'expo-file-system/legacy';
import { base64ToBytes } from './base64';

export interface AsrModelFileSpec {
  name: string;
  /** 期望字节数（快速校验 + 进度分母） */
  size: number;
  /** 期望 SHA-256（权威校验，下载完成后必查） */
  sha256: string;
  /** 下载源（按序尝试，任一成功即可；内容由 sha256 兜底） */
  urls: readonly string[];
}

const HF_REPO =
  'chris-cao/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17';
const hfUrls = (name: string): readonly string[] => [
  `https://huggingface.co/${HF_REPO}/resolve/main/${name}`,
  `https://hf-mirror.com/${HF_REPO}/resolve/main/${name}`,
];

/** 模型文件清单（大小与哈希均已与官方发布物核对，见批次报告） */
export const ASR_MODEL_FILES: readonly AsrModelFileSpec[] = [
  {
    name: 'model.int8.onnx',
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    urls: hfUrls('model.int8.onnx'),
  },
  {
    name: 'tokens.txt',
    size: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    urls: hfUrls('tokens.txt'),
  },
  {
    name: 'silero_vad.onnx',
    size: 643854,
    sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
    urls: [
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    ],
  },
];

/** 全部模型总字节数（≈229MiB，下载提示文案用） */
export const ASR_MODEL_TOTAL_BYTES = ASR_MODEL_FILES.reduce(
  (sum, f) => sum + f.size,
  0
);

export interface AsrModelPaths {
  dir: string;
  modelPath: string;
  tokensPath: string;
  vadModelPath: string;
}

export type AsrModelState =
  | { kind: 'missing' }
  | {
      kind: 'downloading';
      fileName: string;
      receivedBytes: number;
      totalBytes: number;
      /** 全部文件合计进度 0..1 */
      overallFraction: number;
    }
  | { kind: 'verifying'; fileName: string }
  | { kind: 'ready'; paths: AsrModelPaths }
  | { kind: 'error'; message: string };

/** 存储/下载依赖面（生产实现走 expo-file-system/legacy，测试注入假实现） */
export interface ModelStoreDeps {
  dir: string;
  ensureDir(): Promise<void>;
  fileSize(path: string): Promise<number | null>;
  readChunk(
    path: string,
    position: number,
    length: number
  ): Promise<Uint8Array>;
  writeTextFile(path: string, content: string): Promise<void>;
  readTextFile(path: string): Promise<string | null>;
  remove(path: string): Promise<void>;
  move(from: string, to: string): Promise<void>;
  downloadToFile(
    url: string,
    destPath: string,
    onProgress: (receivedBytes: number, totalBytes: number) => void
  ): Promise<void>;
}

const MARKER_NAME = 'verified.json';
const HASH_CHUNK_BYTES = 2 * 1024 * 1024;

export class AsrModelManager {
  private readonly deps: ModelStoreDeps;
  private readonly specs: readonly AsrModelFileSpec[];
  /** 在途下载去重：并发调用共享同一轮下载，避免重复拉取 229MiB */
  private inflight: Promise<AsrModelState> | null = null;

  constructor(
    deps: ModelStoreDeps,
    specs: readonly AsrModelFileSpec[] = ASR_MODEL_FILES
  ) {
    this.deps = deps;
    this.specs = specs;
  }

  paths(): AsrModelPaths {
    const dir = this.deps.dir;
    return {
      dir,
      modelPath: dir + 'model.int8.onnx',
      tokensPath: dir + 'tokens.txt',
      vadModelPath: dir + 'silero_vad.onnx',
    };
  }

  private pathOf(name: string): string {
    return this.deps.dir + name;
  }

  /**
   * 快速就绪检查：三件文件齐全 + 尺寸精确 + 校验标记在案 → ready。
   * （哈希在下载完成时已全量验证并记录标记；此处只做廉价核对，
   * 避免每次启动都读 228MiB 算哈希。）
   */
  async check(): Promise<AsrModelState> {
    try {
      await this.deps.ensureDir();
      const marker = await this.readMarker();
      for (const spec of this.specs) {
        const size = await this.deps.fileSize(this.pathOf(spec.name));
        if (size !== spec.size) return { kind: 'missing' };
        if (marker[spec.name] !== spec.sha256) return { kind: 'missing' };
      }
      return { kind: 'ready', paths: this.paths() };
    } catch {
      return { kind: 'missing' };
    }
  }

  /** 全量 SHA-256 校验单个文件（分块读，避免大文件整读入内存） */
  async verifyFile(spec: AsrModelFileSpec): Promise<boolean> {
    const path = this.pathOf(spec.name);
    const size = await this.deps.fileSize(path);
    if (size !== spec.size) return false;
    const hash = sha256.create();
    let position = 0;
    while (position < size) {
      const length = Math.min(HASH_CHUNK_BYTES, size - position);
      const chunk = await this.deps.readChunk(path, position, length);
      if (chunk.length === 0) return false;
      hash.update(chunk);
      position += chunk.length;
    }
    return bytesToHex(hash.digest()) === spec.sha256;
  }

  /**
   * 确保模型就绪：缺失/损坏文件逐个下载（多源回退）并校验，
   * 全程通过 onState 回报诚实状态。成功返回 ready，失败返回 error。
   */
  async ensureReady(
    onState: (state: AsrModelState) => void
  ): Promise<AsrModelState> {
    if (this.inflight) return this.inflight;
    this.inflight = this.ensureReadyInternal(onState).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async ensureReadyInternal(
    onState: (state: AsrModelState) => void
  ): Promise<AsrModelState> {
    const totalBytes = this.specs.reduce((sum, f) => sum + f.size, 0);
    let completedBytes = 0;
    try {
      await this.deps.ensureDir();
      const verified: Record<string, string> = {};
      for (const spec of this.specs) {
        const path = this.pathOf(spec.name);
        const size = await this.deps.fileSize(path);
        if (size === spec.size) {
          onState({ kind: 'verifying', fileName: spec.name });
          if (await this.verifyFile(spec)) {
            verified[spec.name] = spec.sha256;
            completedBytes += spec.size;
            continue;
          }
          await this.deps.remove(path); // 损坏文件不留
        }
        await this.downloadOne(spec, (received) => {
          onState({
            kind: 'downloading',
            fileName: spec.name,
            receivedBytes: received,
            totalBytes: spec.size,
            overallFraction:
              totalBytes > 0 ? (completedBytes + received) / totalBytes : 0,
          });
        });
        onState({ kind: 'verifying', fileName: spec.name });
        if (!(await this.verifyFile(spec))) {
          await this.deps.remove(path);
          throw new Error(`模型文件校验失败：${spec.name}`);
        }
        verified[spec.name] = spec.sha256;
        completedBytes += spec.size;
      }
      await this.deps.writeTextFile(
        this.pathOf(MARKER_NAME),
        JSON.stringify(verified)
      );
      const ready: AsrModelState = { kind: 'ready', paths: this.paths() };
      onState(ready);
      return ready;
    } catch (error) {
      const failure: AsrModelState = {
        kind: 'error',
        message: error instanceof Error ? error.message : '模型下载失败',
      };
      onState(failure);
      return failure;
    }
  }

  private async downloadOne(
    spec: AsrModelFileSpec,
    onProgress: (receivedBytes: number) => void
  ): Promise<void> {
    const partPath = this.pathOf(spec.name + '.part');
    let lastError: unknown = null;
    for (const url of spec.urls) {
      try {
        await this.deps.remove(partPath);
        await this.deps.downloadToFile(url, partPath, (received) => {
          onProgress(received);
        });
        const size = await this.deps.fileSize(partPath);
        if (size !== spec.size) {
          throw new Error(
            `模型文件大小不符：${spec.name}（期望 ${spec.size}，实际 ${size ?? '未知'}）`
          );
        }
        await this.deps.move(partPath, this.pathOf(spec.name));
        return;
      } catch (error) {
        lastError = error;
        await this.deps.remove(partPath).catch(() => undefined);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`模型下载失败：${spec.name}`);
  }

  private async readMarker(): Promise<Record<string, string>> {
    try {
      const raw = await this.deps.readTextFile(this.pathOf(MARKER_NAME));
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }
}

/** 生产依赖实现（expo-file-system/legacy：可断点感知进度回调） */
export function createExpoModelStoreDeps(): ModelStoreDeps {
  const dir = (FileSystem.documentDirectory ?? '') + 'crish-asr-models/';
  return {
    dir,
    async ensureDir() {
      const info = await FileSystem.getInfoAsync(dir);
      if (!info.exists) {
        await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      }
    },
    async fileSize(path) {
      const info = await FileSystem.getInfoAsync(path);
      return info.exists && 'size' in info ? info.size : null;
    },
    async readChunk(path, position, length) {
      const base64 = await FileSystem.readAsStringAsync(path, {
        encoding: FileSystem.EncodingType.Base64,
        position,
        length,
      });
      return base64ToBytes(base64);
    },
    async writeTextFile(path, content) {
      await FileSystem.writeAsStringAsync(path, content);
    },
    async readTextFile(path) {
      const info = await FileSystem.getInfoAsync(path);
      if (!info.exists) return null;
      return FileSystem.readAsStringAsync(path);
    },
    async remove(path) {
      await FileSystem.deleteAsync(path, { idempotent: true });
    },
    async move(from, to) {
      await FileSystem.moveAsync({ from, to });
    },
    async downloadToFile(url, destPath, onProgress) {
      const task = FileSystem.createDownloadResumable(
        url,
        destPath,
        {},
        (progress) => {
          onProgress(
            progress.totalBytesWritten,
            progress.totalBytesExpectedToWrite
          );
        }
      );
      const result = await task.downloadAsync();
      if (!result || result.status !== 200) {
        throw new Error(
          `下载失败（HTTP ${result ? result.status : '无响应'}）：${url}`
        );
      }
    },
  };
}

/**
 * 全局单例（惰性）：UI 与服务层共用同一管理器。
 * 惰性初始化避免模块导入期触碰原生文件系统（jest / Web 环境安全）。
 */
let singleton: AsrModelManager | null = null;
export function asrModelManager(): AsrModelManager {
  if (!singleton) {
    singleton = new AsrModelManager(createExpoModelStoreDeps());
  }
  return singleton;
}

export default asrModelManager;
