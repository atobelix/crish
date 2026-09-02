/**
 * 统一 Prompt SSOT 集中库 —— 强类型契约与协议定义。
 *
 * 领域模型分水岭（详见 docs/prompt-injection-pipeline/01-统一Prompt集中库与模板详案.md）：
 * - 静态系统基座（L0 core + L1 environment）：会话内逐字节不可变，命中大模型前缀缓存；
 * - 动态模式与动作模板（L2 mode）：按需渲染为结构化文本载荷（卡片注入 / 前缀文本），
 *   严禁回拼进 System Prompt；
 * - 强类型插值模板（PromptTemplate<TParams>）：声明式泛型参数 + 双语字典 + 纯函数渲染。
 *
 * 本文件全部为类型契约（type-only），零运行时逻辑。
 */

/**
 * 提示词层级划分（严格对齐 L0 ~ L5）。
 * 当前集中库实现 L0/L1/L2；rules/skills/dynamic 为后续维度（03/04）预留。
 */
export type PromptLayer =
  | 'core' // L0：核心系统基座（不可变）
  | 'environment' // L1：宿主与工作区上下文（不可变）
  | 'mode' // L2：模式助手与动作模板（用于生成可见卡片 / 前缀文本）
  | 'rules' // L3：规则与约束规范（预留）
  | 'skills' // L4：技能与能力指南（预留）
  | 'dynamic'; // L5：动态状态与历史总结（预留）

/** 语言支持 */
export type PromptLocale = 'zh-CN' | 'en-US';

/** 响应风格层级（wire 值 = 设置系统 responseStyle 枚举字面量） */
export type ResponseStyleLevel = 'minimal' | 'low' | 'medium' | 'high';

/** 提示词元数据 */
export interface PromptMetadata<TParams = Record<string, any>> {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly layer: PromptLayer;
  readonly version: string;
  readonly defaultLocale: PromptLocale;
  readonly tags: readonly string[];
  /** 默认缺省参数（渲染时与实参合并；hostEnvironment 等禁止固化运行时实参） */
  readonly defaultParams?: Partial<TParams>;
}

/** 模板渲染上下文 */
export interface RenderContext {
  locale?: PromptLocale;
}

/** 强类型 Prompt 模板实例接口 */
export interface PromptTemplate<TParams = Record<string, any>> {
  readonly meta: PromptMetadata<TParams>;
  readonly templates: Record<PromptLocale, string>;
  /** 编译渲染方法：缺参安全回退（空串 + 控制台告警），纯函数不抛异常 */
  render(params: TParams, ctx?: RenderContext): string;
}
