/**
 * useModelProfilesState 的纯辅助函数（从主 hook 拆出，无 React 依赖）。
 *
 * - settingsObjectId：设置表单「编辑会话」对象 id（modelRefKey 的 JSON
 *   二元组形态，与编辑会话 open/commit 键同源，跨 profile 隔离，无分隔符碰撞）。
 * - modelSpecRevision：CT-01 对齐的模型配置 rev——对 ModelSpec 可编辑字段
 *   的稳定 JSON 签名（实现见 api/modelsDraftMap.modelSpecRevision）。
 *   来源是 store 节点，不是 getModelMeta。openConfigFor 时捕获为编辑会话
 *   baseRev；saveConfig 保存前重算比对——外部已变更（rev 不符）→ 拒绝陈旧
 *   覆盖（不静默 LWW）。
 * - pickSettingsSelectedId：设置页选中项必须落在统一树 provider 身份上；
 *   树里没有的旧 id（含旧档案存储遗留）一律丢弃，绝不按展示名改绑。
 */
import { modelRefKey } from '../../api/modelsCatalogTypes';

export { modelSpecRevision } from '../../api/modelsDraftMap';

export function settingsObjectId(profileId: string, model: string): string {
  return modelRefKey({ providerId: profileId, modelId: model });
}

/** 已选 → 会话记忆 → 树首行；三者都必须是树里真实存在的 provider 身份。 */
export function pickSettingsSelectedId(
  providers: readonly { id: string }[],
  selected: string | null | undefined,
  stored: string | null | undefined
): string {
  const ids = new Set(providers.map((provider) => provider.id));
  if (selected && ids.has(selected)) return selected;
  if (stored && ids.has(stored)) return stored;
  return providers[0]?.id ?? '';
}
