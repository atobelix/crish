/** 设置表单共用规范草稿契约，避免另建一份窄化类型。 */
import type { ModelConfigDraft } from '../../api/modelsDraftMap';

export type ConfigDraft = ModelConfigDraft;
export interface AddModelDraft extends Partial<ModelConfigDraft> {
  modelId: string;
  displayName: string;
  contextWindow: string;
}

/** 新建表单只有用户输入，能力和价格不能凭空预置。 */
export function emptyAddDraft(): AddModelDraft {
  return { modelId: '', displayName: '', contextWindow: '' };
}
