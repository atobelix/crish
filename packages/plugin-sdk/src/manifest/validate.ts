// packages/plugin-sdk/src/manifest/validate.ts
// 约束来源：ROUND-08-plugin-sdk.md 禁令 15/16/17（能力清单）+ 禁令 18（信任模型）
// 迁移自 agent-runtime/src/plugin-registry.ts 的 normalizeManifest / assertNonEmpty /
// normalizeRequiredString 等可复用校验逻辑（纯函数化：返回错误清单，不抛错、不变异）。

import type { PluginManifest, HookEventName } from './manifest';
import { HOOK_EVENT_NAMES } from './manifest';
import type {
  PluginOrigin,
  PluginPermission,
  PluginTrustLevel,
} from './permissions';
import {
  PLUGIN_ORIGINS,
  PLUGIN_PERMISSIONS,
  PLUGIN_TRUST_LEVELS,
} from './permissions';
import { isValidSemver, isValidSemverRange } from './engine-constraint';

/** manifest 校验结果。 */
export interface ManifestValidationResult {
  readonly valid: boolean;
  readonly errors: readonly ManifestValidationError[];
}

/** manifest 校验错误项。 */
export interface ManifestValidationError {
  readonly field: string;
  readonly message: string;
  readonly code:
    | 'missing-required-field'
    | 'invalid-semver'
    | 'empty-capability-list'
    | 'invalid-trust-level'
    | 'invalid-permission'
    | 'invalid-origin'
    | 'invalid-hook-event'
    | 'invalid-engine-version'
    | 'full-trust-forbidden-origin';
}

/** 校验规则：
 * 1. id/name/version/entrypoints.main 必填且为非空字符串
 * 2. version 须为合法 semver（x.y.z 格式）
 * 3. trustLevel 须为 'restricted' | 'full'（禁令 18，禁止 sandboxed）
 * 4. permissions 须为合法 PluginPermission 枚举值（禁令 18 合并规则）
 * 5. declaredHooks 中的事件名须为合法 HookEventName（14 事件联合）
 * 6. declaredTools / declaredMcpServers 项须为非空字符串
 * 7. engineVersion 须为合法 semver range（禁令 15/16/17）
 * 8. origin（若填充）须为合法 PluginOrigin
 * 9. full 级别仅允许 user-dir origin（防仓库投毒，禁令 18）
 *    —— origin 为空时跳过（discoverer 填充前允许缺失）
 *
 * 能力清单允许为空（插件可纯 observe 不注册任何能力）。
 */
export function validateManifest(
  manifest: PluginManifest,
): ManifestValidationResult {
  const errors: ManifestValidationError[] = [];

  // 规则 1：必填字段非空（迁移自 plugin-registry.ts assertNonEmpty / normalizeRequiredString）
  if (!isNonEmptyString(manifest.id)) {
    errors.push({
      field: 'id',
      message: 'id is required and must be a non-empty string',
      code: 'missing-required-field',
    });
  }
  if (!isNonEmptyString(manifest.name)) {
    errors.push({
      field: 'name',
      message: 'name is required and must be a non-empty string',
      code: 'missing-required-field',
    });
  }
  if (!isNonEmptyString(manifest.version)) {
    errors.push({
      field: 'version',
      message: 'version is required and must be a non-empty string',
      code: 'missing-required-field',
    });
  }
  if (!isNonEmptyString(manifest.entrypoints?.main)) {
    errors.push({
      field: 'entrypoints.main',
      message: 'entrypoints.main is required and must be a non-empty string',
      code: 'missing-required-field',
    });
  }
  if (!isNonEmptyString(manifest.engineVersion)) {
    errors.push({
      field: 'engineVersion',
      message: 'engineVersion is required and must be a non-empty string',
      code: 'missing-required-field',
    });
  }

  // 规则 2：version 须为合法 semver
  if (isNonEmptyString(manifest.version) && !isValidSemver(manifest.version)) {
    errors.push({
      field: 'version',
      message: `version must be a valid semver (x.y.z), got: ${manifest.version}`,
      code: 'invalid-semver',
    });
  }

  // 规则 3：trustLevel 枚举校验（禁令 18）
  if (!isTrustLevel(manifest.trustLevel)) {
    errors.push({
      field: 'trustLevel',
      message: `trustLevel must be 'restricted' or 'full', got: ${String(manifest.trustLevel)}`,
      code: 'invalid-trust-level',
    });
  }

  // 规则 4：permissions 枚举校验（禁令 18 合并规则）
  for (const perm of manifest.permissions ?? []) {
    if (!isPermission(perm)) {
      errors.push({
        field: 'permissions',
        message: `invalid permission value: ${String(perm)}`,
        code: 'invalid-permission',
      });
    }
  }

  // 规则 5：declaredHooks 须为合法 HookEventName
  for (const hook of manifest.declaredHooks ?? []) {
    if (!isHookEventName(hook)) {
      errors.push({
        field: 'declaredHooks',
        message: `invalid hook event name: ${String(hook)} (must be one of ${HOOK_EVENT_NAMES.join(', ')})`,
        code: 'invalid-hook-event',
      });
    }
  }

  // 规则 6：declaredTools / declaredMcpServers 项须为非空字符串
  for (const tool of manifest.declaredTools ?? []) {
    if (!isNonEmptyString(tool)) {
      errors.push({
        field: 'declaredTools',
        message: 'declaredTools entries must be non-empty strings',
        code: 'empty-capability-list',
      });
    }
  }
  for (const mcp of manifest.declaredMcpServers ?? []) {
    if (!isNonEmptyString(mcp)) {
      errors.push({
        field: 'declaredMcpServers',
        message: 'declaredMcpServers entries must be non-empty strings',
        code: 'empty-capability-list',
      });
    }
  }

  // 规则 7：engineVersion 须为合法 semver range
  if (
    isNonEmptyString(manifest.engineVersion) &&
    !isValidSemverRange(manifest.engineVersion)
  ) {
    errors.push({
      field: 'engineVersion',
      message: `engineVersion must be a valid semver range (e.g. ">=0.2.0 <0.3.0"), got: ${manifest.engineVersion}`,
      code: 'invalid-engine-version',
    });
  }

  // 规则 8：origin 枚举校验（若填充）
  if (manifest.origin !== undefined && !isOrigin(manifest.origin)) {
    errors.push({
      field: 'origin',
      message: `origin must be 'user-dir' or 'project-dir', got: ${String(manifest.origin)}`,
      code: 'invalid-origin',
    });
  }

  // 规则 9：full 级别仅允许 user-dir（防仓库投毒，禁令 18）
  if (
    manifest.trustLevel === 'full' &&
    manifest.origin === 'project-dir'
  ) {
    errors.push({
      field: 'trustLevel',
      message:
        'full trust level is not allowed for project-dir origin (use restricted to prevent repo poisoning)',
      code: 'full-trust-forbidden-origin',
    });
  }

  return { valid: errors.length === 0, errors };
}

// ─── 内部纯校验工具（迁移自 plugin-registry.ts assertNonEmpty / isNonEmptyString）──

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPermission(value: unknown): value is PluginPermission {
  return (
    typeof value === 'string' &&
    (PLUGIN_PERMISSIONS as readonly string[]).includes(value)
  );
}

function isTrustLevel(value: unknown): value is PluginTrustLevel {
  return (
    typeof value === 'string' &&
    (PLUGIN_TRUST_LEVELS as readonly string[]).includes(value)
  );
}

function isOrigin(value: unknown): value is PluginOrigin {
  return (
    typeof value === 'string' &&
    (PLUGIN_ORIGINS as readonly string[]).includes(value)
  );
}

function isHookEventName(value: unknown): value is HookEventName {
  return (
    typeof value === 'string' &&
    (HOOK_EVENT_NAMES as readonly string[]).includes(value)
  );
}
