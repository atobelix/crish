/** 设置表单共用规范草稿契约，避免另建一份窄化类型。 */
import type { ModelConfigDraft } from '../../api/modelsDraftMap';

export type ConfigDraft = ModelConfigDraft;
export interface AddModelDraft extends Partial<ModelConfigDraft> {
  modelId: string;
  displayName: string;
  contextWindow: string;
  /**
   * 价格是否为「用户显式声明」。
   *
   * 用户裁决：模型字典只做参考，实际以用户配置为准。字典/探针预估价只作
   * 界面提示，不得当作用户声明落树，因此 `pricing` 单独存在不足以证明用户
   * 声明过价格——必须由用户显式编辑价格的动作把它置为 `true`。
   * 缺省（`undefined`）按未声明处理，`addDraftToModelInput` 默认丢弃 `pricing`。
   */
  pricingExplicit?: boolean;
}

/** 新建表单只有用户输入，能力和价格不能凭空预置。 */
export function emptyAddDraft(): AddModelDraft {
  return { modelId: '', displayName: '', contextWindow: '' };
}
