import { test, expect, Page } from '@playwright/test';
import { openApp, startNewSession, typeIntoComposer } from './helpers/boot';
import { fullJourneyRunEvents } from './mock-engine';

/**
 * 辅助方法：给 UI 点击增添 Store 不变量与更新频次断言
 * 每次 UI 点击后抓取 Agent app 实际 store facade 的状态
 * - 断言 Store 更新频次 < 10 次（彻底拦截 1,141 次/分的同步死循环）
 * - 断言绝无 permissionMode 状态污染
 * - 断言工作区索引与状态完整性
 * - 同时覆盖 sessionStore 与 settingsUiStore 的更新计数和状态不变量
 */

async function readSessionAndSettingsState(page: Page) {
  return page.evaluate(async () => {
    const w = window as any;
    const sessionStore = w.__CRISH_SESSION_STORE__ ?? w.useSessionStore;
    const settingsUiStorePath = '/src/store/settingsUiStore.ts';
    const settingsUiStore = (await import(settingsUiStorePath)).useSettingsUiStore;
    const session = sessionStore?.getState?.();
    const settings = settingsUiStore?.getState?.();
    if (!session || !settings) return null;
    return {
      activeSessionId: session.activeSessionId,
      activeSessionIsValid:
        (!session.hydrationComplete && session.activeSessionId === '') ||
        session.activeSessionId?.startsWith('__pending_draft__') ||
        Boolean(session.sessionsById?.[session.activeSessionId]),
      showSettingsOverlay: settings.showSettingsOverlay,
      settingsActiveTab: settings.settingsActiveTab,
    };
  });
}

async function clickAndAssertInvariants(
  page: Page,
  selector: string,
  actionName: string
) {
  // 1. 重置 Store 更新计数器
  await page.evaluate(() => {
    const w = window as any;
    if (!w.__storeInvariantSubscriptions) {
      throw new Error('beforeEach 必须先订阅全部 Agent app Store facade');
    }
    w.__storeUpdateCount = 0;
    for (const name of Object.keys(w.__storeUpdateCounts ?? {})) {
      w.__storeUpdateCounts[name] = 0;
    }
  });

  // 2. 执行 UI 点击
  const target = page.locator(selector).first();
  await expect(target).toBeVisible();
  await target.click();

  // 3. 极短等待 UI 渲染及潜在的响应式更新循环稳定
  await page.waitForTimeout(300);

  // 4. 提取更新频次与 Store 不变量快照
  const storeStats = await page.evaluate(async () => {
    const updateCount = (window as any).__storeUpdateCount || 0;
    const layout = (window as any).useLayoutStore;
    const workspace = (window as any).__CRISH_WORKSPACE_STORE__;
    const sessionStore =
      (window as any).__CRISH_SESSION_STORE__ ??
      (window as any).useSessionStore;
    const permissionStore = (window as any).usePermissionStore;
    const settingsUiStorePath = '/src/store/settingsUiStore.ts';
    const settingsUiStore = (await import(settingsUiStorePath)).useSettingsUiStore;
    if (!layout || !workspace || !sessionStore || !permissionStore || !settingsUiStore) {
      return {
        updateCount,
        updateCounts: (window as any).__storeUpdateCounts ?? {},
        state: null,
      };
    }
    const state = layout.getState();
    const workspaceState = workspace.getState();
    const sessionState = sessionStore.getState();
    const permState = permissionStore.getState();
    const settingsState = settingsUiStore.getState();
    return {
      updateCount,
      updateCounts: (window as any).__storeUpdateCounts ?? {},
      state: {
        permissionMode: permState.permissionMode,
        planModeEnabled: permState.planModeEnabled,
        workspacesLength: workspaceState.workspaces?.length ?? 0,
        activeWorkspaceIndex: workspaceState.activeWorkspaceIndex,
        sidebarCollapsed: state.sidebarCollapsed,
        activeSessionId: sessionState.activeSessionId,
        activeSessionIsValid:
          (!sessionState.hydrationComplete && sessionState.activeSessionId === '') ||
          sessionState.activeSessionId?.startsWith('__pending_draft__') ||
          Boolean(sessionState.sessionsById?.[sessionState.activeSessionId]),
        showSettingsOverlay: settingsState.showSettingsOverlay,
        settingsActiveTab: settingsState.settingsActiveTab,
      },
    };
  });

  // 5. 校验 Store 更新频次 < 10 次（彻底拦截 1,141 次/分的同步死循环）
  expect(
    storeStats.updateCount,
    `[${actionName}] Store 更新频次触发了 ${storeStats.updateCount} 次，超过 10 次阈值 (拦截同步无限死循环)`
  ).toBeLessThan(10);
  expect(Object.keys(storeStats.updateCounts).sort()).toEqual([
    'layout',
    'permission',
    'session',
    'settingsUi',
    'workspace',
  ]);

  // 6. 校验 Store 不变量
  expect(
    storeStats.state,
    'window.useLayoutStore 必须挂载并就绪'
  ).not.toBeNull();

  // 6a. 绝无 permissionMode 状态污染 ('ask' | 'deep' | 'full' | 'plan')
  const validModes = ['ask', 'deep', 'full', 'plan'];
  expect(
    validModes,
    `[${actionName}] permissionMode 遭到污染：${storeStats.state!.permissionMode}`
  ).toContain(storeStats.state!.permissionMode);

  // 6b. 工作区索引与状态防越界不变量
  expect(storeStats.state!.workspacesLength).toBeGreaterThan(0);
  expect(storeStats.state!.activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
  expect(storeStats.state!.activeWorkspaceIndex).toBeLessThan(
    storeStats.state!.workspacesLength
  );

  // 6c. SessionStore 活跃会话必须是有效会话或草稿哨兵。
  expect(typeof storeStats.state!.activeSessionId).toBe('string');
  expect(storeStats.state!.activeSessionIsValid).toBe(true);

  // 6d. SettingsUiStore 保持真实布尔开关与合法 Tab 状态。
  expect(typeof storeStats.state!.showSettingsOverlay).toBe('boolean');
  expect([
    'profile',
    'appearance',
    'personalize',
    'models',
    'plugins',
    'skills',
    'mcp',
    'usage',
    'devices',
    'schedule',
    'rules',
    'shortcuts',
    'browser',
    'security',
    'diagnostics',
  ]).toContain(storeStats.state!.settingsActiveTab);
}

test.describe('L2 UI 交互与 Store 防无限循环 E2E 测试套件', () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page, {
      runStream: { events: fullJourneyRunEvents(), delayMs: 25 },
    });
    await page.evaluate(async () => {
      const w = window as any;
      const sessionStore = w.__CRISH_SESSION_STORE__ ?? w.useSessionStore;
      const settingsUiStorePath = '/src/store/settingsUiStore.ts';
      const settingsUiStore = (await import(settingsUiStorePath)).useSettingsUiStore;
      const stores = [
        ['layout', w.useLayoutStore],
        ['workspace', w.__CRISH_WORKSPACE_STORE__],
        ['session', sessionStore],
        ['permission', w.usePermissionStore],
        ['settingsUi', settingsUiStore],
      ] as const;
      const missing = stores
        .filter(([, store]) => !store || typeof store.subscribe !== 'function')
        .map(([name]) => name);
      if (missing.length > 0) {
        throw new Error(`Agent app Store facade 未就绪：${missing.join(', ')}`);
      }
      w.__storeUpdateCount = 0;
      w.__storeUpdateCounts = Object.fromEntries(
        stores.map(([name]) => [name, 0])
      );
      w.__storeInvariantSubscriptions = stores.map(([name, store]) =>
        store.subscribe(() => {
          w.__storeUpdateCount = (w.__storeUpdateCount || 0) + 1;
          w.__storeUpdateCounts[name] =
            (w.__storeUpdateCounts[name] || 0) + 1;
        })
      );
    });
  });

  test('01. 初始渲染与 window.useLayoutStore 不变量断言', async ({ page }) => {
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    const initialState = await page.evaluate(async () => {
      const w = window as any;
      const store = (window as any).useLayoutStore;
      const sessionStore = w.__CRISH_SESSION_STORE__ ?? w.useSessionStore;
      const settingsUiStorePath = '/src/store/settingsUiStore.ts';
      const settingsUiStore = (await import(settingsUiStorePath)).useSettingsUiStore;
      if (!store || !sessionStore || !settingsUiStore) return null;
      const state = store.getState();
      const workspace = (window as any).__CRISH_WORKSPACE_STORE__?.getState?.();
      const sessionState = sessionStore.getState();
      const settingsState = settingsUiStore.getState();
      return {
        workspacesLength: workspace?.workspaces?.length ?? 0,
        activeWorkspaceIndex: workspace?.activeWorkspaceIndex,
        permissionMode: (window as any).usePermissionStore?.getState?.()
          .permissionMode,
        activeSessionId: sessionState.activeSessionId,
        activeSessionIsValid:
          (!sessionState.hydrationComplete && sessionState.activeSessionId === '') ||
          sessionState.activeSessionId?.startsWith('__pending_draft__') ||
          Boolean(sessionState.sessionsById?.[sessionState.activeSessionId]),
        showSettingsOverlay: settingsState.showSettingsOverlay,
        settingsActiveTab: settingsState.settingsActiveTab,
      };
    });

    expect(initialState).not.toBeNull();
    expect(['ask', 'deep', 'full', 'plan']).toContain(
      initialState.permissionMode
    );
    expect(initialState.workspacesLength).toBeGreaterThan(0);
    expect(initialState.activeWorkspaceIndex).toBeGreaterThanOrEqual(0);
    expect(initialState.activeWorkspaceIndex).toBeLessThan(
      initialState.workspacesLength
    );
    expect(typeof initialState.activeSessionId).toBe('string');
    expect(initialState.activeSessionIsValid).toBe(true);
    expect(initialState.showSettingsOverlay).toBe(false);
    expect(initialState.settingsActiveTab).toBe('profile');
  });

  test('02. 侧栏导航交互与 Store 频次监控', async ({ page }) => {
    // 点击「定时任务」
    await clickAndAssertInvariants(
      page,
      '[data-testid="sidebar-nav-scheduled"]',
      '侧栏点击定时任务'
    );

    // 点击「新建对话」
    await clickAndAssertInvariants(
      page,
      '[data-testid="new-session-button"]',
      '侧栏点击新建对话'
    );

    // 如果存在会话项，测试选择会话
    const sessionItem = page
      .locator('[data-testid="sidebar-session-item"]')
      .first();
    if ((await sessionItem.count()) > 0) {
      await clickAndAssertInvariants(
        page,
        '[data-testid="sidebar-session-item"]',
        '侧栏选择会话项'
      );
    }
  });

  test('03. Tab 页切换与 Store 不变量监控', async ({ page }) => {
    // 工具快捷操作只在真实会话中挂载，先经正常发送路径建立会话。
    await startNewSession(page);
    await typeIntoComposer(page, '检查 Store 交互');
    await page.locator('[data-testid="chat-input"]').press('Enter');
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__CRISH_E2E__?.getState?.().lastRun)
      )
      .not.toBeNull();
    await expect(page.locator('.msg-row-assistant')).toBeVisible();

    // 工具标签栏只在右侧工具抽屉打开后挂载。
    await clickAndAssertInvariants(
      page,
      '[data-testid="top-quick-files-btn"]',
      '打开文件面板'
    );

    // 从当前叶片的工具标签栏添加入口打开工具面板。
    const addBtn = page.locator('[aria-label="添加功能面板"]').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await clickAndAssertInvariants(
      page,
      '[aria-label="添加功能面板"]',
      '点击添加面板按钮'
    );

    const terminalItem = page.locator('[role="menuitem"]', {
      hasText: '终端',
    }).first();
    await expect(terminalItem).toBeVisible({ timeout: 5000 });
    await clickAndAssertInvariants(
      page,
      '[role="menuitem"]:has-text("终端")',
      '选择打开终端面板'
    );
    await expect(page.locator('[data-tool-tab-id="terminal"]')).toBeVisible();
  });

  test('04. 模型选择主交互与 Store 频次断言', async ({ page }) => {
    const modelBtn = page
      .locator('[data-testid="model-selector-button"]')
      .first();
    await expect(modelBtn).toBeVisible({ timeout: 5000 });
    // 展开模型选择下拉框
    await clickAndAssertInvariants(
      page,
      '[data-testid="model-selector-button"]',
      '点击模型选择器按钮'
    );

    // 验证当前模型目录中的可选模型显示（不依赖已移除的容器 testid）。
    await expect(
      page.locator('[data-testid="model-option-gpt-4o"]')
    ).toBeVisible({ timeout: 5000 });
  });

  test('05. 设置弹窗全流程交互与 permissionMode 防污染断言', async ({
    page,
  }) => {
    // 打开侧栏设置中心。
    await clickAndAssertInvariants(
      page,
      '[data-testid="sidebar-settings-gear-btn"]',
      '点击侧栏设置按钮'
    );

    // 确认设置弹窗已经挂载且可见。
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();
    expect(await readSessionAndSettingsState(page)).toMatchObject({
      showSettingsOverlay: true,
    });

    // 切换设置 Tab: 外观
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-appearance"]',
      '切换设置 Tab：外观'
    );
    expect(await readSessionAndSettingsState(page)).toMatchObject({
      showSettingsOverlay: true,
      settingsActiveTab: 'appearance',
    });

    // 切换设置 Tab: 模型与密钥
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-models"]',
      '切换设置 Tab：模型与密钥'
    );
    expect(await readSessionAndSettingsState(page)).toMatchObject({
      showSettingsOverlay: true,
      settingsActiveTab: 'models',
    });

    // 切换设置 Tab: 规则
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-rules"]',
      '切换设置 Tab：规则'
    );
    expect(await readSessionAndSettingsState(page)).toMatchObject({
      showSettingsOverlay: true,
      settingsActiveTab: 'rules',
    });

    // 关闭设置弹窗
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-close-button"]',
      '关闭设置弹窗'
    );
    expect(await readSessionAndSettingsState(page)).toMatchObject({
      showSettingsOverlay: false,
      settingsActiveTab: 'rules',
    });

    // 确认弹窗已被销毁或隐藏
    await expect(settingsPanel).not.toBeVisible();

    // 再次断言 permissionMode 绝未被设置弹窗污染（R3 域拆分：读 permissionStore）
    const finalPermissionMode = await page.evaluate(() => {
      return (window as any).usePermissionStore?.getState?.()?.permissionMode;
    });
    expect(['ask', 'deep', 'full', 'plan']).toContain(finalPermissionMode);
  });
});
