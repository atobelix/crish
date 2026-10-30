import { getActiveModelRef } from './modelsCatalogStore';
import { listLivePickerEntries, providerHasKey } from './modelsCatalogLive';

/**
 * 返回模型选择器实际会展示的条目。
 *
 * 共用 live 启用状态与凭据可用性过滤（密钥权威源 = 树 credentialStates），
 * 避免发送前引导和选择器列表口径漂移。
 */
export function listAvailableModelPickerEntries() {
  return listLivePickerEntries().filter(({ providerId }) =>
    providerHasKey(providerId)
  );
}

/** 判断是否应在对话内要求选择已有模型。 */
export function shouldPickModelInChat(): boolean {
  return (
    listAvailableModelPickerEntries().length > 0 && getActiveModelRef() == null
  );
}

/** 模型设置缺少默认项但已有可用模型时，转到对话模型选择器。 */
export function routeModelPickerPreflight(
  domain: string | null | undefined,
  callbacks: {
    setPickerInlineError: (message: string) => void;
    onOpenModelPicker?: () => void;
  }
): boolean {
  if (domain !== 'S2' || !shouldPickModelInChat()) return false;
  callbacks.setPickerInlineError('请先选择要使用的模型');
  callbacks.onOpenModelPicker?.();
  return true;
}
