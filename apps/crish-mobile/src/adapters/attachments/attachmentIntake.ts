// G5b · 附件获取适配器：拍照 / 相册 / 文件三入口 + 选图即时处理
//
// 纪律（简报条目 1/4）：
// - 权限被拒 → denied 结果（诚实提示），绝不假装已选/静默吞掉；
// - 图片入选后即按桌面同口径处理：最长边 1600 + JPEG 质量递降，
//   目标原始 ≤500KB（domain/pure/attachments 的 IMAGE_TARGET_RAW_BYTES）；
//   压缩后 dataUrl 仍超单图硬上限（716800）→ tooLarge 当场拒绝，不入队；
// - 文本文件读取失败 / 过大 → 降为普通文件项（元数据行），不假装有正文。
//
// 生产实现走 expo-image-picker / expo-document-picker /
// expo-image-manipulator / expo-file-system/legacy；VM 经接口注入，
// 测试用假实现（仓内既有口径，见 asr/modelManager 的依赖面）。
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';

import {
  ATTACHMENT_DATA_URL_MAX_BYTES,
  IMAGE_TARGET_RAW_BYTES,
  TEXT_BODY_MAX_CHARS,
  type ComposerAttachment,
} from '../../domain/pure/attachments';

export type AttachmentPickOutcome =
  | { kind: 'picked'; attachment: ComposerAttachment }
  | { kind: 'cancelled' }
  | { kind: 'denied'; message: string }
  | { kind: 'tooLarge'; name: string; message: string }
  | { kind: 'failed'; message: string };

export interface AttachmentIntake {
  pickFromCamera(): Promise<AttachmentPickOutcome>;
  pickFromLibrary(): Promise<AttachmentPickOutcome>;
  pickFromFiles(): Promise<AttachmentPickOutcome>;
}

/** 图片最长边上限（与桌面 imageProcessing.ts 同值）。 */
const IMAGE_MAX_EDGE = 1600;
/** 文本文件读取上限：超过则按普通文件入队（正文截断在组装层 80000 字符）。 */
const TEXT_READ_MAX_BYTES = 2_000_000;
/** dataUrl 目标长度：原始 500KB 的 base64 展开 + 前缀余量。 */
const DATA_URL_TARGET_LENGTH = Math.ceil((IMAGE_TARGET_RAW_BYTES * 4) / 3) + 32;

let idCounter = 0;
function nextAttachmentId(): string {
  idCounter += 1;
  return `att-${Date.now()}-${idCounter}`;
}

function fallbackImageName(mime: string): string {
  const ext = mime.includes('png')
    ? 'png'
    : mime.includes('webp')
      ? 'webp'
      : 'jpg';
  return `图片-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
}

function mimeFromAsset(asset: ImagePicker.ImagePickerAsset): string {
  if (asset.mimeType) return asset.mimeType;
  const lower = asset.uri.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  if (lower.includes('.heic')) return 'image/heic';
  return 'image/jpeg';
}

/**
 * 选图即时处理：快路径（小图直读，保 PNG/GIF 原格式）→ 压缩阶梯
 * （边长 1600 + 质量 0.85/0.7/0.55/0.4 → 边长 1280/1024 再降）。
 * 返回达标的 dataUrl（优先 ≤ 目标长度，其次 ≤ 硬上限），全阶梯
 * 不达标返回 null（调用方按 tooLarge 拒绝该项）。
 */
async function processPickedImage(
  asset: ImagePicker.ImagePickerAsset
): Promise<{
  dataUrl: string;
  sizeBytes: number;
  mime: string;
  previewUri: string;
} | null> {
  const mime = mimeFromAsset(asset);
  const width = asset.width ?? 0;
  const height = asset.height ?? 0;
  const longestEdge = Math.max(width, height);
  let fileSize = asset.fileSize ?? null;
  if (fileSize == null) {
    try {
      const info = await FileSystem.getInfoAsync(asset.uri);
      if (info.exists && typeof info.size === 'number') fileSize = info.size;
    } catch {
      fileSize = null;
    }
  }
  // 快路径：体积与边长都达标时直读原图，不重编码（保真 + 省电）。
  if (
    fileSize != null &&
    fileSize <= IMAGE_TARGET_RAW_BYTES &&
    longestEdge <= IMAGE_MAX_EDGE
  ) {
    try {
      const base64 = await FileSystem.readAsStringAsync(asset.uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const dataUrl = `data:${mime};base64,${base64}`;
      if (dataUrl.length <= ATTACHMENT_DATA_URL_MAX_BYTES) {
        return { dataUrl, sizeBytes: fileSize, mime, previewUri: asset.uri };
      }
    } catch {
      // 直读失败 → 落入压缩阶梯
    }
  }
  // 压缩阶梯：先固定边长 1600 递降质量，再缩边长兜底。
  const ladder: { edge: number; quality: number }[] = [
    { edge: 1600, quality: 0.85 },
    { edge: 1600, quality: 0.7 },
    { edge: 1600, quality: 0.55 },
    { edge: 1600, quality: 0.4 },
    { edge: 1280, quality: 0.7 },
    { edge: 1280, quality: 0.55 },
    { edge: 1024, quality: 0.55 },
    { edge: 1024, quality: 0.4 },
  ];
  let hardLimitCandidate: { dataUrl: string; sizeBytes: number } | null = null;
  for (const step of ladder) {
    const actions: ImageManipulator.Action[] = [];
    if (longestEdge > step.edge) {
      actions.push(
        width >= height
          ? { resize: { width: step.edge } }
          : { resize: { height: step.edge } }
      );
    }
    let result: ImageManipulator.ImageResult;
    try {
      result = await ImageManipulator.manipulateAsync(asset.uri, actions, {
        compress: step.quality,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: true,
      });
    } catch {
      continue;
    }
    if (!result.base64) continue;
    const dataUrl = `data:image/jpeg;base64,${result.base64}`;
    const sizeBytes = Math.floor((result.base64.length * 3) / 4);
    if (dataUrl.length <= DATA_URL_TARGET_LENGTH) {
      return { dataUrl, sizeBytes, mime: 'image/jpeg', previewUri: result.uri };
    }
    if (
      dataUrl.length <= ATTACHMENT_DATA_URL_MAX_BYTES &&
      hardLimitCandidate === null
    ) {
      hardLimitCandidate = { dataUrl, sizeBytes };
    }
  }
  if (hardLimitCandidate) {
    return { ...hardLimitCandidate, mime: 'image/jpeg', previewUri: asset.uri };
  }
  return null;
}

async function imageOutcomeFromAsset(
  asset: ImagePicker.ImagePickerAsset
): Promise<AttachmentPickOutcome> {
  const name = asset.fileName ?? fallbackImageName(mimeFromAsset(asset));
  const processed = await processPickedImage(asset);
  if (!processed) {
    return {
      kind: 'tooLarge',
      name,
      message: `图片「${name}」压缩后仍超过单张上限，已跳过`,
    };
  }
  return {
    kind: 'picked',
    attachment: {
      id: nextAttachmentId(),
      name,
      kind: 'image',
      dataUrl: processed.dataUrl,
      sizeBytes: processed.sizeBytes,
      mime: processed.mime,
      previewUri: processed.previewUri,
    },
  };
}

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'log',
  'json',
  'yaml',
  'yml',
  'toml',
  'xml',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'css',
  'html',
  'htm',
  'sh',
  'sql',
  'conf',
  'properties',
]);

function isTextLikeDocument(
  name: string,
  mimeType: string | undefined
): boolean {
  if (mimeType) {
    if (mimeType.startsWith('text/')) return true;
    if (mimeType === 'application/json' || mimeType === 'application/xml')
      return true;
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TEXT_EXTENSIONS.has(ext);
}

async function documentOutcomeFromAsset(
  asset: DocumentPicker.DocumentPickerAsset
): Promise<AttachmentPickOutcome> {
  const base: ComposerAttachment = {
    id: nextAttachmentId(),
    name: asset.name,
    kind: 'file',
    sizeBytes: asset.size,
    mime: asset.mimeType,
  };
  if (!isTextLikeDocument(asset.name, asset.mimeType)) {
    return { kind: 'picked', attachment: base };
  }
  if (asset.size != null && asset.size > TEXT_READ_MAX_BYTES) {
    // 过大文本：不读正文，按普通文件入队（诚实降级，与读取失败同路）
    return { kind: 'picked', attachment: base };
  }
  try {
    const text = await FileSystem.readAsStringAsync(asset.uri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    return {
      kind: 'picked',
      attachment: {
        ...base,
        kind: 'text',
        text,
        textTruncated: text.length > TEXT_BODY_MAX_CHARS,
      },
    };
  } catch {
    // 读取失败 → 普通文件项（元数据行），不假装有正文
    return { kind: 'picked', attachment: base };
  }
}

export const expoAttachmentIntake: AttachmentIntake = {
  async pickFromCamera() {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return {
        kind: 'denied',
        message: '未获得相机权限，无法拍照。请在系统设置中允许相机访问后重试。',
      };
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return { kind: 'cancelled' };
    return imageOutcomeFromAsset(asset);
  },

  async pickFromLibrary() {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      return {
        kind: 'denied',
        message:
          '未获得相册权限，无法选择图片。请在系统设置中允许相册访问后重试。',
      };
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return { kind: 'cancelled' };
    return imageOutcomeFromAsset(asset);
  },

  async pickFromFiles() {
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
      multiple: false,
    });
    const asset = result.canceled ? undefined : result.assets[0];
    if (!asset) return { kind: 'cancelled' };
    return documentOutcomeFromAsset(asset);
  },
};
