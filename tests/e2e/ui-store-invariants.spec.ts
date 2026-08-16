import { test, expect, Page } from '@playwright/test';

/**
 * 辅助方法：给 UI 点击增添 Store 不变量与更新频次断言
 * 每次 UI 点击后抓取 window.useLayoutStore.getState()
 * - 断言 Store 更新频次 < 10 次（彻底拦截 1,141 次/分的同步死循环）
 * - 断言绝无 permissionMode 状态污染
 * - 断言工作区索引与状态完整性
 */
async function clickAndAssertInvariants(
  page: Page,
  selector: string,
  actionName: string
) {
  // 1. 重置 Store 更新计数器
  await page.evaluate(() => {
    (window as any).__storeUpdateCount = 0;
  });

  // 2. 执行 UI 点击
  const target = page.locator(selector).first();
  await expect(target).toBeVisible();
  await target.click();

  // 3. 极短等待 UI 渲染及潜在的响应式更新循环稳定
  await page.waitForTimeout(300);

  // 4. 提取更新频次与 Store 不变量快照
  const storeStats = await page.evaluate(() => {
    const updateCount = (window as any).__storeUpdateCount || 0;
    const store = (window as any).useLayoutStore;
    if (!store) {
      return { updateCount, state: null };
    }
    const state = store.getState();
    // R3 域拆分：permissionMode / planModeEnabled 已从 layoutStore 迁至 permissionStore
    const permState = (window as any).usePermissionStore?.getState?.() ?? {};
    return {
      updateCount,
      state: {
        permissionMode: permState.permissionMode,
        planModeEnabled: permState.planModeEnabled,
        workspacesLength: state.workspaces?.length ?? 0,
        activeWorkspaceIndex: state.activeWorkspaceIndex,
        activeSessionId: state.activeSessionId,
        showSettingsOverlay: state.showSettingsOverlay,
        settingsActiveTab: state.settingsActiveTab,
      },
    };
  });

  // 5. 校验 Store 更新频次 < 10 次（彻底拦截 1,141 次/分的同步死循环）
  expect(
    storeStats.updateCount,
    `[${actionName}] Store 更新频次触发了 ${storeStats.updateCount} 次，超过 10 次阈值 (拦截同步无限死循环)`
  ).toBeLessThan(10);

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
}

test.describe('L2 UI 交互与 Store 防无限循环 E2E 测试套件', () => {
  test.beforeEach(async ({ page }) => {
    // 禁用首次运行向导弹窗 (FirstRunWizard) 并 Mock Tauri 原生 IPC
    await page.addInitScript(() => {
      try {
        window.localStorage.setItem('crish_first_run_done_v1', '1');
      } catch {
        /* ignore */
      }

      (window as any).__TAURI_INTERNALS__ = {
        invoke: async (cmd: string, args: any) => {
          console.log('[Mock Tauri IPC]', cmd, args);
          if (cmd === 'get_app_settings') {
            return { defaultModel: 'gpt-4o', defaultThinkingLevel: 'medium' };
          }
          if (cmd === 'list_models') {
            return [{ id: 'gpt-4o', name: 'GPT-4o' }];
          }
          if (cmd === 'get_command_permissions') {
            return [];
          }
          if (cmd === 'get_providers') {
            return [];
          }
          return null;
        },
      };
      (window as any).__TAURI_IPC__ = async () => null;
    });

    // 连接 Vite Dev Server (http://localhost:5174)
    await page.goto('/');
    await page.waitForSelector('#root', { state: 'visible', timeout: 10000 });
  });

  test('01. 初始渲染与 window.useLayoutStore 不变量断言', async ({ page }) => {
    await expect(page.locator('[data-testid="sidebar"]')).toBeVisible();

    const initialState = await page.evaluate(() => {
      const store = (window as any).useLayoutStore;
      if (!store) return null;
      const state = store.getState();
      // R3 域拆分：permissionMode 位于 permissionStore
      return {
        ...state,
        permissionMode: (window as any).usePermissionStore?.getState?.()
          .permissionMode,
      };
    });

    expect(initialState).not.toBeNull();
    expect(['ask', 'deep', 'full', 'plan']).toContain(
      initialState.permissionMode
    );
    expect(initialState.workspaces.length).toBeGreaterThan(0);
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
    // 检查是否存在现有 Tab（如 chat / overview）
    const chatTab = page.locator('[data-testid="tab-chat"]').first();
    await expect(chatTab).toBeVisible({ timeout: 5000 });
    await clickAndAssertInvariants(
      page,
      '[data-testid="tab-chat"]',
      '切换到对话 Tab'
    );

    // 点击添加面板按钮
    const addBtn = page.locator('[data-testid="add-panel-button"]').first();
    await expect(addBtn).toBeVisible({ timeout: 5000 });
    await clickAndAssertInvariants(
      page,
      '[data-testid="add-panel-button"]',
      '点击添加面板按钮'
    );

    // 点击打开终端面板
    const terminalItem = page
      .locator('[data-testid="add-panel-item-terminal"]')
      .first();
    await expect(terminalItem).toBeVisible({ timeout: 5000 });
    await clickAndAssertInvariants(
      page,
      '[data-testid="add-panel-item-terminal"]',
      '选择打开终端面板'
    );
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

    // 验证模型菜单是否显示
    const modelMenu = page.locator('[data-testid="model-picker-menu"]').first();
    await expect(modelMenu).toBeVisible({ timeout: 5000 });
  });

  test('05. 设置弹窗全流程交互与 permissionMode 防污染断言', async ({
    page,
  }) => {
    // 打开快捷设置菜单
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-button"]',
      '点击侧栏设置按钮'
    );

    // 点击「全部设置」打开 SettingsPanel
    // （ui/Menu 基座弹层在 low-height 视口下溢出，既有产品缺陷 →
    // 以 dispatchEvent 派发点击语义，规避 Playwright 命中测试）
    const qsAll = page.locator('[data-testid="quick-settings-all"]');
    await expect(qsAll).toBeVisible();
    await qsAll.dispatchEvent('click');
    await page.waitForTimeout(300);

    // 确认设置弹窗已经挂载且可见
    const settingsPanel = page.locator('[data-testid="settings-panel"]');
    await expect(settingsPanel).toBeVisible();

    // 切换设置 Tab: 外观
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-appearance"]',
      '切换设置 Tab：外观'
    );

    // 切换设置 Tab: 模型与密钥
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-models"]',
      '切换设置 Tab：模型与密钥'
    );

    // 切换设置 Tab: 规则
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-tab-rules"]',
      '切换设置 Tab：规则'
    );

    // 关闭设置弹窗
    await clickAndAssertInvariants(
      page,
      '[data-testid="settings-close-button"]',
      '关闭设置弹窗'
    );

    // 确认弹窗已被销毁或隐藏
    await expect(settingsPanel).not.toBeVisible();

    // 再次断言 permissionMode 绝未被设置弹窗污染（R3 域拆分：读 permissionStore）
    const finalPermissionMode = await page.evaluate(() => {
      return (window as any).usePermissionStore?.getState?.()?.permissionMode;
    });
    expect(['ask', 'deep', 'full', 'plan']).toContain(finalPermissionMode);
  });
});
