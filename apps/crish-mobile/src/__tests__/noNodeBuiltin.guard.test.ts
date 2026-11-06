// node 内置模块 / 动态执行门禁（2026-11-05 B1 崩溃链防回潮，战役
// findings/04 B1：`req('node:vm') || req('vm')` 在 Hermes 生产 bundle
// 直接 `Requiring unknown module` FATAL 杀进程；`new Function + eval`
// 兜底在 JS 线程同步执行用户代码，无超时/内存护栏 = ANR/杀进程通道）。
// 现行契约（2026-11-05 T6 收敛后口径，取代「探测点各限一处」的旧
// 口径——收敛删除了工具与模块内的整套 Node vm 回退实现，探测点
// 清零，比限一处更严）：
// - 原生 QuickJS 沙箱（crish-js-sandbox 模块）是端侧脚本执行唯一
//   实现真源；工具只经包名消费模块，不自带任何执行/探测实现；
// - 工具与模块的代码行中 `node:vm` 字面量零出现，旧探测实现
//   （resolveNodeVm / resolveNodeVmModule / runFallbackSandbox）
//   零回潮；模块原生缺失时返回结构化 runtime_unavailable；
// - `new Function(` / 裸 `eval(` 在工具与运行时域绝对禁止；
// - metro.config.js 必须存在（bundle 解析契约）。
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/** 仓库内 crish-mobile 根（src/__tests__ 上跳两级） */
const MOBILE_ROOT = join(__dirname, '..', '..');

/** 只看代码行（整行注释剔除），与 noShadow / roundButton 守卫同口径 */
function codeOf(relFromMobile: string): string {
  return readFileSync(join(MOBILE_ROOT, relFromMobile), 'utf8')
    .split(/\r?\n/)
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

describe('noNodeBuiltin 门禁：端侧脚本域禁 Node 内置试探与动态执行', () => {
  it('runJsSandboxTool：node:vm 零出现，只经 crish-js-sandbox 模块消费原生沙箱', () => {
    const code = codeOf('src/adapters/tools/runJsSandboxTool.ts');
    // 收敛后口径：不再有任何 Node vm 探测/回退代码行
    expect(code).not.toMatch(/node:vm/);
    expect(code).not.toContain('resolveNodeVm');
    expect(code).not.toContain("req('node:vm') || req('vm')");
    // 唯一实现真源 = crish-js-sandbox 模块（包名消费）
    expect(code).toContain("from 'crish-js-sandbox'");
    // 动态执行绝对禁止
    expect(code).not.toContain('new Function(');
    expect(code).not.toMatch(/\beval\(/);
  });

  it('modules/crish-js-sandbox：node:vm 零出现，原生缺失诚实降级 runtime_unavailable', () => {
    const code = codeOf('modules/crish-js-sandbox/index.ts');
    // 回退全家（探测 + fallback 执行）已随收敛物理删除，不许回潮
    expect(code).not.toMatch(/node:vm/);
    expect(code).not.toContain('resolveNodeVmModule');
    expect(code).not.toContain('runFallbackSandbox');
    // 原生桥探测名与 Kotlin 注册名对齐；缺失即结构化降级
    expect(code).toContain("requireOptionalNativeModule('CrishJsSandbox')");
    expect(code).toContain("'runtime_unavailable'");
  });

  it('metro.config.js 存在（bundle 解析契约面）', () => {
    expect(existsSync(join(MOBILE_ROOT, 'metro.config.js'))).toBe(true);
  });
});
