/**
 * ModelBadgePickerMenu 列表投影：live 条目按供应商分组并按关键词过滤。
 * 配置真源只走 listLivePickerEntries / getLiveModel（禁止 LS profiles / meta）。
 */
import type { IndexedModelEntry } from '../../api/modelsCatalogTypes';
import { getLiveModel } from '../../api/modelsCatalogLive';

export type PickerModelRow = { id: string; name: string };

export type PickerProfileGroup = {
  profileId: string;
  profileName: string;
  models: PickerModelRow[];
};

function liveDisplayName(
  providerId: string,
  modelId: string,
  fallback?: string,
): string {
  const spec = getLiveModel(providerId, modelId);
  return spec?.displayName || spec?.id || fallback || modelId;
}

/**
 * 按 yaml 插入序分组。keyword 空 = 全量；否则匹配供应商展示名 / 模型 id / 展示名。
 * 命中供应商名时保留该供应商下全部已启用模型。
 */
export function groupLivePickerEntries(
  entries: IndexedModelEntry[],
  keyword: string,
): PickerProfileGroup[] {
  const kw = keyword.trim().toLowerCase();
  const groups: PickerProfileGroup[] = [];
  const index = new Map<string, PickerProfileGroup>();

  for (const entry of entries) {
    const profileName = entry.provider.displayName || entry.providerId;
    const name = liveDisplayName(
      entry.providerId,
      entry.model.id,
      entry.model.displayName,
    );
    if (kw) {
      const matchesProfile = profileName.toLowerCase().includes(kw);
      const matchesModel =
        entry.model.id.toLowerCase().includes(kw) ||
        name.toLowerCase().includes(kw);
      if (!matchesProfile && !matchesModel) continue;
    }

    let group = index.get(entry.providerId);
    if (!group) {
      group = { profileId: entry.providerId, profileName, models: [] };
      index.set(entry.providerId, group);
      groups.push(group);
    }
    group.models.push({ id: entry.model.id, name });
  }

  return groups;
}
