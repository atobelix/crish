/**
 * 权限模式显示文案（渲染层）：按 api/permissionModes 元数据中的 i18n 键
 * （以模式 id 索引）经全局翻译器解析。文案真源只在双语字典
 * （settings.security.mode*），API 层不持有任何显示字符串。
 */
import { t } from './useI18n';
import {
  permissionModeMeta,
  type PermissionMode,
} from '../api/permissionModes';

export function permissionModeLabel(mode: PermissionMode | unknown): string {
  return t(permissionModeMeta(mode).labelKey);
}

export function permissionModeShortLabel(
  mode: PermissionMode | unknown
): string {
  return t(permissionModeMeta(mode).shortLabelKey);
}

export function permissionModeDescription(
  mode: PermissionMode | unknown
): string {
  return t(permissionModeMeta(mode).descriptionKey);
}
