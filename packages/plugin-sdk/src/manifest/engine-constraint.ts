// packages/plugin-sdk/src/manifest/engine-constraint.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 15/16/17（engineVersion 语义版本范围）

/**
 * 语义版本范围字符串（禁令 15/16/17）。
 *
 * 形如 ">=0.2.0 <0.3.0" 或 "^0.2.0" 或 "~0.2.5"。
 *
 * 设计决策：SemVerRange 在本模块本地定义（非 shared-types），
 * 因 shared-types 当前未导出该类型，且禁令 13 要求 plugin-sdk 类型自洽。
 * 完整 semver 解析委托 shared-utils（Phase 2 增强），本模块仅做最小子集校验。
 */
export type SemVerRange = string;

/** 引擎版本约束（语义版本范围）。 */
export type PluginEngineConstraint = SemVerRange;

/** 合法 semver 正则（x.y.z + 可选 pre-release/build，最小子集）。 */
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** 合法 semver 范围操作符前缀（>, >=, <, <=, =, ~, ^）。 */
const RANGE_OPERATOR_RE = /^[\^~>=<]*\s*/;

/**
 * 校验一个版本号是否为合法 semver（x.y.z 格式）。
 */
export function isValidSemver(version: string): boolean {
  return SEMVER_RE.test(version.trim());
}

/**
 * 校验一个 semver 范围字符串是否结构合法。
 *
 * 支持的最小子集（禁令：MVP 不重复实现完整 semver 解析，委托 shared-utils Phase 2）：
 * - 单个版本："0.2.5"
 * - 比较运算符：">=0.2.0"、"<0.3.0"、">1.0.0"
 * - 空格分隔的 AND：">=0.2.0 <0.3.0"
 * - 范围简写："^0.2.0"、"~0.2.5"
 *
 * 空字符串视为非法（engineVersion 必填）。
 */
export function isValidSemverRange(range: string): boolean {
  const trimmed = range.trim();
  if (trimmed.length === 0) return false;
  // 逗号或空格分隔的多个子约束，每个去掉前缀运算符后须为合法 semver
  const parts = trimmed.split(/[\s,]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const bare = part.replace(RANGE_OPERATOR_RE, '');
    // "0.2.x" 或 "*" 等 wildcard 不在 MVP 子集内，视为非法
    return SEMVER_RE.test(bare);
  });
}

/**
 * 校验引擎版本兼容性（占位实现，禁令：完整 semver 解析推迟 Phase 2）。
 *
 * @param engineVersion 当前引擎版本（如 "0.2.5"）
 * @param constraint 约束范围（如 ">=0.2.0 <0.3.0"）
 * @returns MVP 阶段仅做结构校验通过即返回 true；实际 satisfies 比较委托 shared-utils Phase 2
 */
export function isEngineCompatible(
  engineVersion: string,
  constraint: PluginEngineConstraint,
): boolean {
  if (!isValidSemver(engineVersion) || !isValidSemverRange(constraint)) {
    return false;
  }
  // MVP 占位：结构合法即视为兼容。完整 semver satisfies 比较推迟 shared-utils 增强。
  return true;
}
