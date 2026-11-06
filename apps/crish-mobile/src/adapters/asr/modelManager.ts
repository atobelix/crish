// 离线 ASR 模型管理器：首次使用按需下载 + 完整性校验 + 本地落盘。
//
// 决策（用户规范 2026-11-01）：SenseVoice 模型实测 239,233,841 字节
// （≈228MiB），严禁塞进 APK/assets；改为首次触发语音时按需下载到
// 应用文档目录，逐文件以固定 SHA-256 校验（哈希自官方 GitHub 发布包
// 提取并与 HF 镜像的 LFS 元数据交叉核对一致）。下载源只是传输通道，
// 内容可信度由固定哈希保证，与来源无关。
// 状态机对 UI 诚实：缺失 / 下载中（带进度）/ 校验中 / 就绪 / 失败可重试，
// 不伪装「已就绪」。
//
// 平行实现标注（2026-11-06 端侧模型波收口裁决）：本机 GGUF 模型管理
// 器（src/adapters/onDevice/onDeviceModelManager.ts）按本文件的接口
// 形状平行实现（多模型目录 + 断点续传 + 空间预检），经评估不抽共享
// 基类（理由见彼处文件头），维持双实现并互相标注。两处下载/校验语
// 义如需变更，须同步评估对方；纯函数 toNativeFilePath / formatBytes
// 由彼处直接导入本模块复用，无第二份。
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as FileSystem from 'expo-file-system/legacy';
import { getCrishAsrNative } from 'crish-asr';
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
  `https://hf-mirror.com/${HF_REPO}/resolve/main/${name}`,
  `https://huggingface.co/${HF_REPO}/resolve/main/${name}`,
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

/** 交给原生引擎的模型路径组：全部为真实文件系统路径（见 toNativeFilePath） */
export interface AsrModelPaths {
  dir: string;
  modelPath: string;
  tokensPath: string;
  vadModelPath: string;
}

/**
 * 存储层路径 → 原生引擎路径：expo-file-system 的文档目录是 file:// URI，
 * FileSystem 存储 API 两种形态都吃；但原生引擎（sherpa-onnx）只认真实
 * 文件系统路径——file:///data/... 在其配置 Validate 里直接被判为
 * 「不存在」，引擎必然创建失败（2026-11-03 真机 logcat 实证，此即
 * 「语音引擎启动失败」的根因）。paths() 是唯一把路径交给原生的出口，
 * 故在此统一剥 scheme；存储操作继续走 deps.dir 的 URI 形态（pathOf），
 * 两条通道互不影响。
 */
export function toNativeFilePath(uriOrPath: string): string {
  return uriOrPath.startsWith('file://')
    ? uriOrPath.slice('file://'.length)
    : uriOrPath;
}

/** 格式化字节尺寸（如 "45.2 MB" 或 "308 KB"） */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  const kb = bytes / 1024;
  return `${kb.toFixed(0)} KB`;
}

export interface AsrModelProgress {
  /** 当前正在下载/校验的文件名 */
  fileName: string;
  /** 当前文件序号（1-based，如 1） */
  fileIndex: number;
  /** 总文件数（如 3） */
  totalFiles: number;
  /** 当前文件已接收字节数 */
  receivedBytes: number;
  /** 当前文件期望总字节数 */
  totalBytes: number;
  /** 全部文件合计总体进度 0..1 */
  overallFraction: number;
  /** 格式化好的进度文案，如 "45.2 MB / 228.2 MB (20%)" */
  progressText?: string;
  /** 瞬时下载速率 (bytes/s，可选) */
  speedBytesPerSec?: number;
}

export type AsrModelState =
  | { kind: 'missing' }
  | ({ kind: 'downloading' } & AsrModelProgress)
  | {
      kind: 'verifying';
      fileName: string;
      fileIndex: number;
      totalFiles: number;
      overallFraction: number;
    }
  | { kind: 'ready'; paths: AsrModelPaths }
  | { kind: 'error'; message: string; canRetry: boolean };

/** 存储/下载依赖面（生产实现走 expo-file-system/legacy，测试注入假实现） */
export interface ModelStoreDeps {
  dir: string;
  ensureDir(): Promise<void>;
  fileSize(path: string): Promise<number | null>;
  /** 原生加速 SHA-256 校验接口（可选；返回 64 位小写十六进制字符串，失败/不可用返回 null） */
  computeSha256?(path: string): Promise<string | null>;
  readChunk?(
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
    const dir = toNativeFilePath(this.deps.dir);
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

  /**
   * 删除本地模型（设置页管理入口）：三件模型 + 校验标记 + 残留的
   * .part 半成品一并清除，释放约 229MiB；删除后 check() 回到
   * missing，下次使用语音时重新走下载门。文件本不存在时幂等无碍
   * （生产 remove 为 idempotent 删除）。
   */
  async removeAll(): Promise<void> {
    for (const spec of this.specs) {
      await this.deps.remove(this.pathOf(spec.name));
      await this.deps.remove(this.pathOf(`${spec.name}.part`));
    }
    await this.deps.remove(this.pathOf(MARKER_NAME));
  }

  /** 高效校验单个文件：尺寸预检 + 原生硬件加速哈希（降级 pure JS 分块）比对 */
  async verifyFile(
    spec: AsrModelFileSpec,
    targetPath?: string
  ): Promise<boolean> {
    const path = targetPath ?? this.pathOf(spec.name);
    const size = await this.deps.fileSize(path);
    if (size !== spec.size) return false;
    let computedHash: string | null = null;
    if (this.deps.computeSha256) {
      try {
        computedHash = await this.deps.computeSha256(path);
      } catch {
        computedHash = null;
      }
    }
    if (!computedHash && this.deps.readChunk) {
      const hasher = sha256.create();
      let position = 0;
      while (position < size) {
        const length = Math.min(HASH_CHUNK_BYTES, size - position);
        const chunk = await this.deps.readChunk(path, position, length);
        if (chunk.length === 0) return false;
        hasher.update(chunk);
        position += chunk.length;
      }
      computedHash = bytesToHex(hasher.digest());
    }
    return computedHash === spec.sha256;
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
      const verified = await this.readMarker();
      for (let idx = 0; idx < this.specs.length; idx++) {
        const spec = this.specs[idx]!;
        const fileIndex = idx + 1;
        const path = this.pathOf(spec.name);
        const size = await this.deps.fileSize(path);

        // 若已在案且大小吻合且通过校验，直接复用
        if (size === spec.size && verified[spec.name] === spec.sha256) {
          completedBytes += spec.size;
          continue;
        }

        // 若文件已存在且大小吻合，尝试进行快速哈希比对自愈
        if (size === spec.size) {
          onState({
            kind: 'verifying',
            fileName: spec.name,
            fileIndex,
            totalFiles: this.specs.length,
            overallFraction: totalBytes > 0 ? completedBytes / totalBytes : 0,
          });
          if (await this.verifyFile(spec)) {
            verified[spec.name] = spec.sha256;
            await this.deps.writeTextFile(
              this.pathOf(MARKER_NAME),
              JSON.stringify(verified)
            );
            completedBytes += spec.size;
            continue;
          }
          // 注意：非破坏性策略，哈希不匹配不执行惩罚性 remove(path)，保留既有文件供后续下载覆盖
        }

        // 下载并原子完成校验，保证损坏件不进入正式路径
        await this.downloadOneAndVerify(
          spec,
          fileIndex,
          (received) => {
            const overall =
              totalBytes > 0 ? (completedBytes + received) / totalBytes : 0;
            const pct = Math.round(overall * 100);
            const receivedFmt = formatBytes(received);
            const totalFmt = formatBytes(spec.size);
            onState({
              kind: 'downloading',
              fileName: spec.name,
              fileIndex,
              totalFiles: this.specs.length,
              receivedBytes: received,
              totalBytes: spec.size,
              overallFraction: overall,
              progressText: `${receivedFmt} / ${totalFmt} (${pct}%)`,
            });
          },
          () => {
            onState({
              kind: 'verifying',
              fileName: spec.name,
              fileIndex,
              totalFiles: this.specs.length,
              overallFraction:
                totalBytes > 0 ? (completedBytes + spec.size) / totalBytes : 0,
            });
          }
        );

        verified[spec.name] = spec.sha256;
        // 增量持久化：校验通过即刻写盘，断电不丢失
        await this.deps.writeTextFile(
          this.pathOf(MARKER_NAME),
          JSON.stringify(verified)
        );
        completedBytes += spec.size;
      }

      const ready: AsrModelState = { kind: 'ready', paths: this.paths() };
      onState(ready);
      return ready;
    } catch (error) {
      const failure: AsrModelState = {
        kind: 'error',
        message: error instanceof Error ? error.message : '模型下载失败',
        canRetry: true,
      };
      onState(failure);
      return failure;
    }
  }

  private async downloadOneAndVerify(
    spec: AsrModelFileSpec,
    fileIndex: number,
    onProgress: (receivedBytes: number) => void,
    onVerifying?: () => void
  ): Promise<void> {
    const partPath = this.pathOf(spec.name + '.part');
    let lastError: unknown = null;
    for (const url of spec.urls) {
      try {
        await this.deps.downloadToFile(url, partPath, (received) => {
          onProgress(received);
        });
        const size = await this.deps.fileSize(partPath);
        if (size !== spec.size) {
          throw new Error(
            `模型文件大小不符：${spec.name}（期望 ${spec.size}，实际 ${size ?? '未知'}）`
          );
        }
        onVerifying?.();
        // 在 .part 阶段就地进行原生高速校验
        const valid = await this.verifyFile(spec, partPath);
        if (!valid) {
          throw new Error(`模型文件哈希校验不匹配：${spec.name}`);
        }
        // 校验百分百通过，才原子替换正式文件
        await this.deps.move(partPath, this.pathOf(spec.name));
        return;
      } catch (error) {
        lastError = error;
        // 非破坏性保护：绝不惩罚性删除既有正式文件，保留 .part 或错误现场供排查
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
    async computeSha256(path) {
      const native = getCrishAsrNative();
      if (native?.fileSha256) {
        try {
          return await native.fileSha256(toNativeFilePath(path));
        } catch {
          return null;
        }
      }
      return null;
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
