import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { readEntryChainSource } from '../../../test-utils/entryChainSources';

describe('Runtime Background & Workspace Zero-Flash SSOT Test Suite', () => {
  const readCss = (relPath: string) => {
    const fullPath = path.resolve(__dirname, '../../../', relPath);
    return fs.readFileSync(fullPath, 'utf-8');
  };

  it('FLASH-01: RuntimePanel 根容器必须使用 var(--bg-card) 且 .row 透明化', () => {
    const css = readCss('components/workspace/RuntimePanel.module.css');
    
    // 根容器必须是纯白卡底，禁止使用外壳灰 --bg-primary
    expect(css).toMatch(/\.panel\s*\{[^}]*background:\s*var\(--bg-card/);
    expect(css).not.toMatch(/\.panel\s*\{[^}]*background:\s*var\(--bg-primary\)/);

    // .row 默认必须为透明底，禁止堆叠 --bg-secondary
    expect(css).toMatch(/\.row\s*\{[^}]*background:\s*transparent;/);
    expect(css).not.toMatch(/\.row\s*\{[^}]*background:\s*var\(--bg-secondary\);/);
  });

  it('FLASH-02: AgentCard 根容器必须使用 var(--bg-card)', () => {
    const css = readCss('components/agent-card/AgentCard.module.css');
    
    expect(css).toMatch(/\.agentCard\s*\{[^}]*background:\s*var\(--bg-card/);
    expect(css).toMatch(/\.agentCardLaunch\s*\{[^}]*background:\s*var\(--bg-card/);
    expect(css).not.toMatch(/background:\s*var\(--shell-inset-bg,\s*var\(--bg-primary\)\)/);
  });

  it('FLASH-03: BinaryTreeWorkspace .emptyState 必须使用 var(--bg-card) 消除切换跳灰', () => {
    const css = readCss('components/binary-tree/BinaryTreeWorkspace.module.css');
    
    // 必须为纯白卡底，严禁使用 #eaecee 或 --bg-secondary
    expect(css).toMatch(/\.emptyState\s*\{[^}]*background:\s*var\(--bg-card/);
    expect(css).not.toMatch(/\.emptyState\s*\{[^}]*background:\s*var\(--bg-secondary\)/);
  });

  it('FLASH-04: FilesCard / TabStrip / PreviewCard 次级容器不得出现残留 --bg-primary 灰带', () => {
    const filesCss = readCss('components/files/FilesCard.module.css');
    expect(filesCss).toMatch(/\.filesContextBar\s*\{[^}]*background:\s*var\(--bg-card/);

    const tabStripCss = readCss('components/binary-tree/LeafToolTabStrip.module.css');
    expect(tabStripCss).toMatch(/\.toolbar\s*\{[^}]*background:\s*var\(--bg-card/);
    expect(tabStripCss).toMatch(/\.launcherHubWrapper\s*\{[^}]*background:\s*var\(--bg-card/);

    const previewCss = readCss('components/workspace/PreviewCard.module.css');
    expect(previewCss).toMatch(/\.histPanel\s*\{[^}]*background:\s*var\(--bg-card/);
  });

  it('FLASH-05: 入口链包含常用工具视图 Chunk 的闲时预热逻辑', () => {
    // ACT-301 单拍装配后，main.tsx 收敛为纯转发器（`import './entry-core'`），
    // 真实装配（含闲时预热表）全在 entry-core.tsx。故必须扫整条入口链
    // （唯一读取口径见 test-utils/entryChainSources.ts），只读 main.tsx 会得空源码。
    const mainTsx = fs.readFileSync(
      path.resolve(__dirname, '../../../main.tsx'),
      'utf-8'
    );
    // main.tsx 仍是物理唯一入口，且不得自留装配逻辑
    expect(mainTsx).toContain("import './entry-core'");
    expect(mainTsx).not.toContain('createRoot');

    const entryChain = readEntryChainSource();
    expect(entryChain).toContain("import('./components/diff/DiffCard')");
    expect(entryChain).toContain("import('./components/files/FilesCard')");
    expect(entryChain).toContain("import('./components/overview/OverviewCard')");
    expect(entryChain).toContain("import('./components/workspace/PreviewCard')");
    expect(entryChain).toContain("import('./components/workspace/RuntimePanel')");
    // 闲时预热通道存在：项目统一调度器 staggeredIdleQueue（entry-core.tsx:269/301），
    // 禁止 rIC timeout 整批强刷（CUT-03），由 maxWaitMs 兜底防饿死
    expect(entryChain).toContain('staggeredIdleQueue');
    expect(entryChain).toContain('maxWaitMs');
  });
});
