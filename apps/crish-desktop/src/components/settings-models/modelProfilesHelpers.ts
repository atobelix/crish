/**
 * useModelProfilesState 的纯辅助函数（从主 hook 拆出，无 React 依赖）。
 *
 * - settingsObjectId：设置表单「编辑会话」对象 id（profileId::model，与
 *   modelCatalog metaKey 同形，跨 profile 隔离，避免 model id 裸串撞车）。
 * - modelSpecRevision：CT-01 对齐的模型配置 rev——对 ModelSpec 可编辑字段
 *   的稳定 JSON 签名（实现见 api/modelsDraftMap.modelSpecRevision）。
 *   来源是 store 节点，不是 getModelMeta。openConfigFor 时捕获为编辑会话
 *   baseRev；saveConfig 保存前重算比对——外部已变更（rev 不符）→ 拒绝陈旧
 *   覆盖（不静默 LWW）。
 * - foldSettingsProfiles / pickSettingsSelectedId：设置列表与 picker 同一
 *   展示名折叠；已选 id 被同名胜者吃掉时改绑胜者。
 */
import {
  findProfileByDisplayName,
  foldProfilesByDisplayName,
  profileDisplayLabel,
  type ProviderProfile,
} from '../../api/providerProfiles';

export { modelSpecRevision } from '../../api/modelsDraftMap';

export function settingsObjectId(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

/** 设置页服务商列表：同展示名只留一行（含停用）。与 picker 共用 fold。 */
export function foldSettingsProfiles(
  profiles: readonly ProviderProfile[] | null | undefined
): ProviderProfile[] {
  return foldProfilesByDisplayName(profiles);
}

/** preferred 在折叠结果中则原样；否则绑同展示名胜者；都没有则 ''。 */
export function resolveSettingsSelectedId(
  folded: readonly ProviderProfile[],
  raw: readonly ProviderProfile[],
  preferred: string | null | undefined
): string {
  if (!preferred) return '';
  if (folded.some((p) => p.id === preferred)) return preferred;
  const hidden = raw.find((p) => p.id === preferred);
  if (!hidden) return '';
  return findProfileByDisplayName(folded, profileDisplayLabel(hidden))?.id ?? '';
}

/** 已选 session → 活动 profile → 折叠表首行。 */
export function pickSettingsSelectedId(
  folded: readonly ProviderProfile[],
  raw: readonly ProviderProfile[],
  stored: string | null | undefined,
  active: string | null | undefined
): string {
  return (
    resolveSettingsSelectedId(folded, raw, stored) ||
    resolveSettingsSelectedId(folded, raw, active) ||
    folded[0]?.id ||
    ''
  );
}
