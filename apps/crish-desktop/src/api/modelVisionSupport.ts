/**
 * 模型视觉多模态判定（生产只信 live catalog `modalities.input`）
 *
 * - isModelVisionSupported / 入口守卫只走 modelAcceptsInput(providerId, modelId, 'image')
 * - providerId 缺失、store 未加载、找不到模型、modalities 缺省 → false
 * - 禁止正则猜视觉、禁止 capabilities.image、禁止无 provider 全局兜底
 * - 原生文件选择器不再对 accept 施加硬过滤，允许挂载图片/复杂文档，由提示条感知并预警
 */

import { useEffect, useState, type ChangeEvent } from 'react';
import { modelAcceptsInput } from './modelsCatalogLive';
import { modelsCatalogStore } from './modelsCatalogStore';
import { getActiveModelRef } from './modelsCatalogStore';
import { onUiEvent } from './uiEvents';
import { toast } from '../services/toast/ToastContext';

export const VISION_IMAGE_BLOCKED_TOAST = '当前模型不支持图片输入';

/**
 * 历史用于隐藏 file input 的 accept 列表（现已解耦，不再对原生选择器施加硬过滤）。
 * 保留导出以兼容存量引用。
 */
export const COMPOSER_NON_IMAGE_FILE_ACCEPT =
  '.txt,.md,.markdown,.json,.ts,.tsx,.js,.jsx,.css,.html,.py,.rs,.go,.java,.c,.cpp,.h,.yml,.yaml,.toml,.xml,.csv,.log,.sh,.ps1,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx';

const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const COMPLEX_DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?)$/i;

export function isModelVisionSupported(
  modelId: string,
  providerId?: string | null
): boolean {
  const pid = (providerId || '').trim();
  const mid = (modelId || '').trim();
  if (!pid || !mid) return false;
  return modelAcceptsInput(pid, mid, 'image');
}

export function activeModelAcceptsImage(): boolean {
  const ref = getActiveModelRef();
  return isModelVisionSupported(ref?.modelId ?? '', ref?.providerId);
}

/** catalog 已加载且当前模型不接受 image 时，才剥已挂图片（避免水合前误删） */
export function shouldStripImagesForActiveModel(): boolean {
  return (
    modelsCatalogStore.getState().loaded === true && !activeModelAcceptsImage()
  );
}

export function notifyImageIntakeBlocked(): void {
  toast.show(VISION_IMAGE_BLOCKED_TOAST);
}

export function isImageIntakeFile(file: File): boolean {
  return (
    (file.type || '').startsWith('image/') ||
    IMAGE_NAME_RE.test(file.name || '')
  );
}

export function isImageChatAttachment(a: {
  dataUrl?: string;
  imageMeta?: unknown;
  thumbnailUrl?: string;
  mime?: string;
  name?: string;
  path?: string;
}): boolean {
  if (a.dataUrl || a.imageMeta || a.thumbnailUrl) return true;
  if (typeof a.mime === 'string' && a.mime.startsWith('image/')) return true;
  return IMAGE_NAME_RE.test(a.name || '') || IMAGE_NAME_RE.test(a.path || '');
}

/**
 * 判断附件是否为复杂文档（PDF, Office 等）。
 */
export function isComplexDocChatAttachment(a: {
  mime?: string;
  name?: string;
  path?: string;
}): boolean {
  if (typeof a.mime === 'string') {
    const m = a.mime.toLowerCase();
    if (
      m.includes('pdf') ||
      m.includes('word') ||
      m.includes('excel') ||
      m.includes('powerpoint') ||
      m.includes('officedocument')
    ) {
      return true;
    }
  }
  return (
    COMPLEX_DOC_EXT_RE.test(a.name || '') ||
    COMPLEX_DOC_EXT_RE.test(a.path || '')
  );
}

export type AttachmentLike = {
  mime?: string;
  name?: string;
  path?: string;
  dataUrl?: string;
  imageMeta?: unknown;
  thumbnailUrl?: string;
};

/**
 * 检测附件列表中是否含有图片或复杂文档
 */
export function hasVisionOrDocumentAttachments(attachments: AttachmentLike[]): {
  hasImage: boolean;
  hasComplexDoc: boolean;
} {
  let hasImage = false;
  let hasComplexDoc = false;
  for (const a of attachments) {
    if (isImageChatAttachment(a)) {
      hasImage = true;
    }
    if (isComplexDocChatAttachment(a)) {
      hasComplexDoc = true;
    }
  }
  return { hasImage, hasComplexDoc };
}

export interface ModelVisionWarningInfo {
  hasWarning: boolean;
  warningText: string | null;
  unsupportedKinds: ('image' | 'complex_doc')[];
}

/**
 * 针对挂载的附件列表与当前（或指定）模型，计算视觉/多模态支持警告文案。
 * 若模型支持视觉或未挂载图片/复杂文档，返回 null；
 * 若模型不支持视觉且挂载了图片或复杂文档，返回明确的提示条警告文案。
 */
export function getModelVisionWarning(
  attachments: AttachmentLike[],
  modelId?: string | null,
  providerId?: string | null
): string | null {
  if (!attachments || attachments.length === 0) return null;

  const activeRef = getActiveModelRef();
  const targetModelId = modelId !== undefined ? modelId : activeRef?.modelId;
  const targetProviderId =
    providerId !== undefined ? providerId : activeRef?.providerId;

  if (isModelVisionSupported(targetModelId || '', targetProviderId)) {
    return null;
  }

  const { hasImage, hasComplexDoc } =
    hasVisionOrDocumentAttachments(attachments);

  if (hasImage && hasComplexDoc) {
    return '当前模型不支持多模态视觉与复杂文档解析，发送时可能无法理解附件内容';
  }
  if (hasImage) {
    return '当前模型不支持图片输入，请切换至支持视觉的多模态模型';
  }
  if (hasComplexDoc) {
    return '当前模型不支持复杂文档解析，请切换至支持文档/视觉的模型或转换为纯文本';
  }

  return null;
}

export function getModelVisionWarningInfo(
  attachments: AttachmentLike[],
  modelId?: string | null,
  providerId?: string | null
): ModelVisionWarningInfo {
  const warningText = getModelVisionWarning(attachments, modelId, providerId);
  const unsupportedKinds: ('image' | 'complex_doc')[] = [];
  if (warningText) {
    const { hasImage, hasComplexDoc } =
      hasVisionOrDocumentAttachments(attachments);
    if (hasImage) unsupportedKinds.push('image');
    if (hasComplexDoc) unsupportedKinds.push('complex_doc');
  }
  return {
    hasWarning: Boolean(warningText),
    warningText,
    unsupportedKinds,
  };
}

export type VisionWarningListener = (warning: string | null) => void;

const visionWarningListeners = new Set<VisionWarningListener>();

/**
 * 广播视觉警告文案事件（用于向输入框上方提示条或状态栏分发通知）
 */
export function notifyVisionWarning(warning: string | null): void {
  for (const listener of Array.from(visionWarningListeners)) {
    try {
      listener(warning);
    } catch {
      // 忽略单个监听器异常
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('crish-model-vision-warning', { detail: { warning } })
    );
  }
}

/**
 * 订阅视觉警告事件通知
 */
export function onVisionWarning(listener: VisionWarningListener): () => void {
  visionWarningListeners.add(listener);
  return () => {
    visionWarningListeners.delete(listener);
  };
}

/**
 * React Hook：响应式获取当前挂载附件在当前模型下的视觉警告文案
 */
export function useModelVisionWarning(
  attachments: AttachmentLike[]
): string | null {
  const [, setRev] = useState(0);
  useEffect(() => {
    const bump = () => setRev((n) => n + 1);
    const offModel = onUiEvent('model-changed', bump);
    const offCatalog = onUiEvent('models-catalog-changed', bump);
    return () => {
      offModel();
      offCatalog();
    };
  }, []);

  return getModelVisionWarning(attachments);
}

/**
 * 保护选文件列表（向后兼容保留纯函数）：
 * 若外部调用方仍需主动过滤非视觉文件，可调用此函数。
 */
export function guardComposerFileSelection(files: File[]): File[] {
  if (!files.length) return files;
  if (activeModelAcceptsImage()) return files;
  const kept = files.filter((f) => !isImageIntakeFile(f));
  if (kept.length !== files.length) notifyImageIntakeBlocked();
  return kept;
}

export function useActiveModelAcceptsImage(): boolean {
  const [, setRev] = useState(0);
  useEffect(() => {
    const bump = () => setRev((n) => n + 1);
    const offModel = onUiEvent('model-changed', bump);
    const offCatalog = onUiEvent('models-catalog-changed', bump);
    return () => {
      offModel();
      offCatalog();
    };
  }, []);
  return activeModelAcceptsImage();
}

/**
 * 隐藏 file input 的 props 生成器。
 * 规范：取消 COMPOSER_NON_IMAGE_FILE_ACCEPT 对原生文件选择器的硬过滤限制（不再强制排除图片），
 * 允许用户选择包含图片在内的任意文件，多模态不匹配时交由提示条感知并预警。
 */
export function useComposerHiddenFileInputProps(
  onFiles: (files: File[]) => void | Promise<void>
): {
  type: 'file';
  multiple: true;
  accept?: string;
  'aria-hidden': true;
  tabIndex: number;
  style: { display: 'none' };
  'data-image-intake': 'on' | 'off';
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
} {
  const acceptsImage = useActiveModelAcceptsImage();
  const props: {
    type: 'file';
    multiple: true;
    accept?: string;
    'aria-hidden': true;
    tabIndex: number;
    style: { display: 'none' };
    'data-image-intake': 'on' | 'off';
    onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  } = {
    type: 'file',
    multiple: true,
    'aria-hidden': true,
    tabIndex: -1,
    style: { display: 'none' },
    'data-image-intake': acceptsImage ? 'on' : 'off',
    onChange: (e) => {
      const raw = Array.from(e.target.files || []);
      e.target.value = '';
      if (!raw.length) return;
      void Promise.resolve(onFiles(raw));
    },
  };
  // 不再设置 props.accept = COMPOSER_NON_IMAGE_FILE_ACCEPT
  return props;
}
