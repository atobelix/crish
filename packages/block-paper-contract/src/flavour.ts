/**
 * FlavourRegistration 类型草稿（F0）。
 *
 * 对齐：`docs/block-workspace-architecture/plans/specs/register-flavour-roadmap.md`
 *
 * 路线图：F0 接口草稿 → F1 RS schema 扩展 + Unknown 占位 → F2 View 轨 → F3 分发/TrustGate。
 * 不变量：第三方块不得永久锁死在「只能装饰内置 flavour」。
 *
 * 本文件仅类型 + 函数签名草稿，不接线注册表实现。
 */

import type { FlavourId } from './block-id';

export type { FlavourId };

/**
 * Flavour 属性 schema 草稿。
 * W0 不锁校验引擎（zod / JSON Schema / RS 校验二选一在 F1 落地）；
 * 此处仅约束注册时必须携带可序列化描述。
 */
export type FlavourSchema = {
  /**
   * 属性字段描述（JSON Schema 子集或等价对象）。
   * 实现波再钉死校验器，禁止各插件私自第二套 props 形状。
   */
  props?: Record<string, unknown>;
  /** 是否允许作为叶子持有文本 */
  hasText?: boolean;
  /** 允许的子 flavour id；省略 = 宿主默认策略 */
  children?: FlavourId[];
  /** 人类可读显示名（slash / 调试） */
  displayName?: string;
};

/**
 * Slash 菜单贡献项（扩展 contribute point：slash）。
 * 动作载荷在 F2 前允许 unknown，禁止直接写 SQLite。
 */
export type SlashContribution = {
  id: string;
  title: string;
  description?: string;
  group?: string;
  /** 触发后的动作描述；最终须落为 Intent / Op，不得旁路写盘 */
  action?: Record<string, unknown>;
};

/**
 * 块 View 贡献（扩展 contribute point：blockView）。
 * 渲染仍走 View 轨；写权威仍走 Op → RS。
 */
export type BlockViewContribution = {
  /**
   * 组件注册键（包内 tag / 动态 import key）。
   * W0 不绑 React/Lit 具体类型，避免契约依赖 UI 栈。
   */
  component: string;
  /** 是否参与虚拟化窗口挂载；默认 true */
  virtualizable?: boolean;
};

/**
 * FlavourRegistration 注册载荷（id + schema + 可选 View/slash 贡献）。
 */
export type FlavourRegistration = {
  /** flavour / kind 唯一 id */
  id: FlavourId;
  /** 属性与结构约束 */
  schema: FlavourSchema;
  /** 可选自定义块视图 */
  blockView?: BlockViewContribution;
  /** 可选 slash 项（单项或多项） */
  slash?: SlashContribution | SlashContribution[];
};

/**
 * 注销函数（若注册成功返回）。
 * F0 草稿：允许实现返回 void（不可注销）或 disposer。
 */
export type UnregisterFlavour = () => void;

/**
 * Flavour 注册函数签名草稿。
 *
 * @param registration 完整注册载荷（id + schema 必填）
 * @returns 可选注销器；F1 注册表落地后语义钉死
 */
export type RegisterFlavour = (
  registration: FlavourRegistration
) => void | UnregisterFlavour;

/**
 * 类型级辅助：校验某值可赋给 FlavourRegistration（供测试 / 插件侧使用）。
 * 运行时为恒等函数，无副作用。
 */
export function asFlavourRegistration(
  registration: FlavourRegistration
): FlavourRegistration {
  return registration;
}
