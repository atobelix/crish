// @vitest-environment node
/**
 * ACT-301：启动流编排扁平化静态检查。
 * 确保 entry-core.tsx / main.tsx 无级联 await import 瀑布；
 * bootstrap-orchestrator 与 store/minimalConfig 已物理删除。
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('ACT-301: 启动流编排扁平化静态检查', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  // 测试位于 apps/crish-desktop/src/__tests__/startup/ 或 tests/unit/startup/
  // 统一向上定位 crish-desktop/src
  const candidates = [
    path.resolve(here, '../../../src'),
    path.resolve(here, '../../src'),
    path.resolve(here, '../src'),
  ];
  let desktopSrc = '';
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'main.tsx'))) {
      desktopSrc = c;
      break;
    }
  }
  const mainTsxPath = path.join(desktopSrc, 'main.tsx');
  const entryCorePath = path.join(desktopSrc, 'entry-core.tsx');

  it('定位到 apps/crish-desktop/src', () => {
    expect(desktopSrc).not.toBe('');
    expect(fs.existsSync(mainTsxPath)).toBe(true);
    expect(fs.existsSync(entryCorePath)).toBe(true);
  });

  it('main.tsx 与 entry-core.tsx 中严禁存在过多串行 await import（瀑布回潮拦截）', () => {
    const mainContent = fs.readFileSync(mainTsxPath, 'utf-8');
    const entryContent = fs.readFileSync(entryCorePath, 'utf-8');
    const combined = mainContent + '\n' + entryContent;

    // 首屏关键路径（bootstrap 至 createRoot.render）不得出现 await import。
    // idle 交接 / DEV 门面 / rAF 后 JIT 通知中的动态 import 不计入「串行瀑布」，
    // 但仍设宽松上限防回潮：≤ 8（idle 分支 + DEV + JIT）。
    const awaitImports = combined.match(/await\s+import\(/g) || [];
    expect(
      awaitImports.length,
      `检测到过多 await import (${awaitImports.length} 处)，存在启动瀑布流回潮隐患！`
    ).toBeLessThanOrEqual(8);

    // main.tsx 必须是纯转发壳（无 await import）
    expect(mainContent).not.toMatch(/await\s+import\(/);
    expect(mainContent).toContain("import './entry-core'");
  });

  it('entry-core.tsx 使用 React 静态导入与单拍 createRoot', () => {
    const entryContent = fs.readFileSync(entryCorePath, 'utf-8');
    expect(entryContent).toMatch(/from ['"]react['"]/);
    expect(entryContent).toMatch(/from ['"]react-dom\/client['"]/);
    expect(entryContent).toMatch(/createRoot\s*\(/);
    expect(entryContent).toMatch(/StartupCoordinator/);
    // 首屏禁止顶层 @xterm 样式
    expect(entryContent).not.toContain('@xterm');
    // 兜底零 Emoji
    const emojiRe =
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{2764}]/u;
    expect(emojiRe.test(entryContent)).toBe(false);
    // 兜底禁止裸 hex 与旧式 rgba（源码级；var(--token) + hsl 回退）
    // 允许 hsl 内的数值，禁止 #RRGGBB 与 rgba(
    const bareHex = entryContent.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    // 过滤注释中的十六进制误报：仅扫描非注释行仍可能有 URL hash——
    // 对本文件源码，禁止出现颜色裸 hex
    expect(bareHex.length).toBe(0);
    expect(entryContent).not.toMatch(/rgba\s*\(/);
  });

  it('bootstrap-orchestrator.ts 必须已彻底物理删除', () => {
    const orchestratorPath = path.join(desktopSrc, 'bootstrap-orchestrator.ts');
    expect(
      fs.existsSync(orchestratorPath),
      'bootstrap-orchestrator.ts 仍存在，未履行物理删除！'
    ).toBe(false);
  });

  it('store/minimalConfig.ts 必须已彻底物理删除', () => {
    const minimalConfigPath = path.join(desktopSrc, 'store/minimalConfig.ts');
    expect(
      fs.existsSync(minimalConfigPath),
      'store/minimalConfig.ts 仍存在，未履行物理删除！'
    ).toBe(false);
  });

  it('bootstrap-core 不得冷启调用 Worker 池创建', () => {
    const corePath = path.join(desktopSrc, 'bootstrap-core.ts');
    const core = fs.readFileSync(corePath, 'utf-8');
    // 仅检查调用面：禁止 workers 模块导入与冷启创建调用
    expect(core).not.toMatch(/from\s+['"]\.\/workers/);
    expect(core).not.toMatch(/\binitMinimalPool\s*\(/);
    expect(core).not.toMatch(/loadMinimalConfig\s*\(/);
    expect(core).not.toMatch(/initOAuthTokenScheduler\s*\(/);
  });

  it('builtinViewFactories 保留 10 个内置视图槽位', () => {
    const factoriesPath = path.join(desktopSrc, 'builtinViewFactories.tsx');
    expect(fs.existsSync(factoriesPath)).toBe(true);
    const src = fs.readFileSync(factoriesPath, 'utf-8');
    for (const key of [
      'chat',
      'terminal',
      'preview',
      'overview',
      'files',
      'diff',
      'runtime',
      'agent',
      'flow-dag',
      'file-viewer',
    ]) {
      // 键以属性名或引号键出现
      const re = new RegExp(`(['"])?${key}(['"])?\\s*:\\s*\\(\\)\\s*=>`);
      expect(re.test(src), `缺少内置视图工厂槽位: ${key}`).toBe(true);
    }
  });
});
