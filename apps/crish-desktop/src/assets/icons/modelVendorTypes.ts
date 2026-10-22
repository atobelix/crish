/** 模型厂商元数据契约（modelVendorCatalog 及各分组数据文件共用）。 */
export interface ModelVendorMeta {
  /** 标准厂商唯一标识（Canonical Key），如 'deepseek', 'openai' */
  id: string;
  /** 厂商官方规范名称（拉丁字母写法；无 nameKey 或翻译缺失时直接展示） */
  name: string;
  /**
   * 本地化展示名的 i18n 键（如 'settings.models.vendor.deepseek'）。
   * 名称在不同语言下写法不同（如中文品牌名）时提供，展示层优先 t(nameKey)。
   */
  nameKey?: string;
  /** 品牌官方代表底色（用于方形原彩底板） */
  brandColor: string;
  /** 品牌文字/前景对比色（默认为 #FFFFFF） */
  textColor: string;
  /** 厂商别名、常见模型前缀与关键字匹配集合 */
  matchers: string[];
  /** 分类标签，便于按需筛选或过滤 */
  category: 'foundation' | 'domestic' | 'multimodal' | 'platform' | 'infra';
  /** 方形原彩 SVG 内部图形矢量路径（viewBox="0 0 24 24" 内部） */
  svgInnerPath?: string;
}
