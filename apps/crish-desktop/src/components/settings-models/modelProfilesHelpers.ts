/**
 * useModelProfilesState 的纯辅助函数（从主 hook 拆出，无 React 依赖）。
 *
 * - settingsObjectId：设置表单「编辑会话」对象 id（profileId::model，与
 *   modelCatalog metaKey 同形，跨 profile 隔离，避免 model id 裸串撞车）。
 * - modelMetaRevision：CT-01 对齐的模型配置 rev——可编辑字段
 *   （displayName/contextLength/caps）的稳定序列化签名。openConfigFor 时
 *   捕获为编辑会话 baseRev；saveConfig 保存前重算比对——外部已变更（rev
 *   不符）→ 拒绝陈旧覆盖（不静默 LWW）。
 */
import { getModelMeta } from '../../api/modelCatalog';

export function settingsObjectId(profileId: string, model: string): string {
  return `${profileId}::${model}`;
}

export function modelMetaRevision(profileId: string, model: string): string {
  const meta = getModelMeta(profileId, model);
  return JSON.stringify([
    meta.displayName ?? '',
    meta.contextLength ?? null,
    meta.capabilities?.tools ?? false,
    meta.capabilities?.vision ?? false,
    meta.capabilities?.reasoning ?? false,
  ]);
}
