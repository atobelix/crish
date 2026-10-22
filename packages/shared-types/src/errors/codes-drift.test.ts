// packages/shared-types/src/errors/codes-drift.test.ts
// F8-02 / F8-42：错误码共享码表一致性护栏（TS ↔ Rust 双向漂移测试）
//
// 背景（docs/organization/audit/F8-shared-generated-audit.md）：
// - F8-02：tool.write_path_conflict（写路径互斥冲突，I4-M3 高频路径）在
//   agent-tools 作为局部码产生，但未注册进 TS CrishErrorCode 联合类型、
//   也未进 Rust codes 模块与 CRISH_ERROR_REGISTRY——前端 getErrorInfo 回退
//   common.unknown、toErrorPayload 降级，丢失动作建议；
// - F8-42：错误码清单无 TS↔Rust 双向漂移测试（事件有 registry_drift.rs，
//   错误码没有），漏码因此能存活。
//
// 本测试两件事：
// 1. 断言 tool.write_path_conflict 已注册（元信息不回退 common.unknown）；
// 2. 断言 TS CRISH_ERROR_REGISTRY 与 Rust error 模块（crates/conex-types/src/error/，
//    codes 常量集在 error/codes.rs）码集合双向相等
//    ——改任一侧不同步（新增码 / 改名 / 删码）立即红。

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CrishError } from './classes';
import { isCrishErrorCode } from './codes';
import type { CrishErrorCode } from './codes';
import { CRISH_ERROR_REGISTRY, getErrorInfo } from './info';

/// 仓库根（本文件位于 packages/shared-types/src/errors/，上溯四层）
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/// Rust 侧 error 模块目录（原单文件 error.rs 已按职责拆为 error/ 目录，
/// codes 常量集位于 error/codes.rs）
const RUST_ERROR_MODULE_DIR = REPO_ROOT + 'crates/conex-types/src/error/';

/// 递归列出 error 模块目录下全部 .rs 文件（按路径排序，结果稳定）。
/// 扫描整个目录而非只读 codes.rs：与拆分前「整份 error.rs 全文扫描」的
/// 覆盖面等价，码常量即使落在 error/ 下其他文件也不会漏提。
function rustErrorModuleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = dir + entry.name;
    if (entry.isDirectory()) {
      files.push(...rustErrorModuleFiles(full + '/'));
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      files.push(full);
    }
  }
  return files.sort();
}

/// 解析 Rust 侧 error 模块（error/ 目录全部 .rs）的全部码常量
/// （模式：`pub const NAME: &str = "域名.段名";`，码表常量全符合；
///  支持三段码：R13/B3 起 tool.browser.* 为三段点分码——两段正则曾静默漏提）
function rustCodesFromErrorRs(): string[] {
  const src = rustErrorModuleFiles(RUST_ERROR_MODULE_DIR)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  const re =
    /pub const [A-Z][A-Z0-9_]*: &str = "([a-z][a-z0-9_]*(\.[a-z_]+)+)";/g;
  const codes: string[] = [];
  for (const m of src.matchAll(re)) {
    if (m[1] !== undefined) codes.push(m[1]);
  }
  return codes;
}

describe('F8-02：tool.write_path_conflict 注册（TS 侧）', () => {
  it('形态校验通过（两段式小写点分码，isCrishErrorCode）', () => {
    expect(isCrishErrorCode('tool.write_path_conflict')).toBe(true);
  });

  it('getErrorInfo 返回该码元信息而非回退 common.unknown', () => {
    const info = getErrorInfo('tool.write_path_conflict' as CrishErrorCode);
    expect(info.code).toBe('tool.write_path_conflict');
    expect(info.code).not.toBe('common.unknown');
    // 互斥冲突为设计内正常路径：Permanent / 不可重试（确定拒绝，等占用者释放）
    expect(info.category).toBe('permanent');
    expect(info.retryable).toBe(false);
    expect(info.public).toBe(true);
    expect(info.action).not.toBe('action.common.report_bug');
  });

  it('CrishError 以该码构造时派生注册表元信息（action 不再降级）', () => {
    const err = new CrishError(
      '写路径互斥冲突：目标已被占用',
      'tool.write_path_conflict' as CrishErrorCode,
      'permanent',
      false
    );
    expect(err.code).toBe('tool.write_path_conflict');
    expect(err.action).not.toBe('action.common.report_bug');
  });
});

describe('F8-42：TS↔Rust 错误码清单双向漂移', () => {
  const tsCodes = Object.keys(CRISH_ERROR_REGISTRY).sort();
  const rustCodes = rustCodesFromErrorRs().sort();

  it('TS 注册表与 Rust codes 模块码集合双向相等（新增/改名/删码任一侧不同步即红）', () => {
    expect(tsCodes).toEqual(rustCodes);
  });

  it('每条码均为合法小写点分形态（两段或三段）且无重复', () => {
    expect(new Set(tsCodes).size).toBe(tsCodes.length);
    for (const c of tsCodes) {
      expect(isCrishErrorCode(c)).toBe(true);
    }
  });

  it('R13/B3：tool.browser.* 9 码已进 Rust codes 模块与 TS 注册表（三段码提取核对）', () => {
    for (const code of [
      'tool.browser.not_ready',
      'tool.browser.gate_blocked',
      'tool.browser.capability_disabled',
      'tool.browser.stale_snapshot',
      'tool.browser.node_gone',
      'tool.browser.cancelled',
      'tool.browser.eval_forbidden',
      'tool.browser.tab_limit_exceeded',
      'tool.browser.unwired',
    ]) {
      expect(rustCodes).toContain(code);
      expect(tsCodes).toContain(code);
      expect(getErrorInfo(code as CrishErrorCode).code).toBe(code);
    }
  });

  it('S5：tool.computer.* 8 码 + tool.session.exclusive + subagent.not_found 已进 Rust codes 模块与 TS 注册表', () => {
    for (const code of [
      'tool.computer.invalid_params',
      'tool.computer.coords_out_of_bounds',
      'tool.computer.elevated_window',
      'tool.computer.not_enabled',
      'tool.computer.not_ready',
      'tool.computer.cancelled',
      'tool.computer.capability_unavailable',
      'tool.computer.unwired',
      'tool.session.exclusive',
      'subagent.not_found',
    ]) {
      expect(rustCodes).toContain(code);
      expect(tsCodes).toContain(code);
      expect(getErrorInfo(code as CrishErrorCode).code).toBe(code);
    }
  });

  it('agent-tools 写路径互斥码已进 Rust codes 模块与 TS 注册表（F8-02 根治）', () => {
    expect(rustCodes).toContain('tool.write_path_conflict');
    expect(tsCodes).toContain('tool.write_path_conflict');
  });
});
