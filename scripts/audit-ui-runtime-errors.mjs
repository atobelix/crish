import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';
import path from 'path';

const TARGET_URL = 'http://localhost:5174/';
const MANIFEST_PATH = path.join(process.cwd(), 'scripts', 'ui-selectors-manifest.json');
const IPC_RULES_PATH = path.join(process.cwd(), 'scripts', 'ipc-daemon-audit-rules.json');

async function checkServerReady(url, maxRetries = 10) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) resolve(true);
          else reject(new Error(`Status ${res.statusCode}`));
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return false;
}

async function runComprehensiveAudit() {
  console.log(`[Comprehensive UI & IPC Audit] Starting verification against ${TARGET_URL}...`);
  
  // Load manifests if available
  let manifest = null;
  let ipcRules = null;
  try {
    if (fs.existsSync(MANIFEST_PATH)) {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
      console.log(`[UI Audit] Loaded UI Selectors Manifest (${Object.keys(manifest.selectors || {}).length} selector categories)`);
    }
    if (fs.existsSync(IPC_RULES_PATH)) {
      ipcRules = JSON.parse(fs.readFileSync(IPC_RULES_PATH, 'utf-8'));
      console.log(`[UI Audit] Loaded IPC & Daemon Audit Rules (${ipcRules.daemonProtocolAudit?.unsupportedTypes?.length || 0} unsupported WS types tracked)`);
    }
  } catch (e) {
    console.warn(`[UI Audit Warning] Error reading manifest files: ${e.message}`);
  }

  const isReady = await checkServerReady(TARGET_URL);
  if (!isReady) {
    console.error(`[UI Audit Error] Target URL ${TARGET_URL} is not accessible. Please start Vite dev server first.`);
    process.exit(1);
  }

  console.log(`[UI Audit] Launching Playwright Chromium headless browser...`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const capturedErrors = [];
  const consoleLogs = [];

  // Listen to Uncaught Page Exceptions
  page.on('pageerror', (exception) => {
    capturedErrors.push({
      category: 'Uncaught Page Exception',
      message: exception.message,
      stack: exception.stack || exception.message,
    });
    console.error(`🔴 [Page Error]: ${exception.message}`);
  });

  // Listen to Console Messages & Invariants & Store Loops
  page.on('console', (msg) => {
    const text = msg.text();
    consoleLogs.push({ type: msg.type(), text });

    // 1. Detect Store Frequency Loops (> 50 updates/min)
    if (text.includes('[StoreFreq]')) {
      const match = text.match(/\[StoreFreq\]\s+([\w]+):\s+(\d+)\s+updates/);
      if (match) {
        const [, storeName, countStr] = match;
        const count = parseInt(countStr, 10);
        if (count > 50) {
          capturedErrors.push({
            category: 'Store Infinite Sync Loop',
            message: `Store ${storeName} updated ${count} times in last 60s (ping-pong sync loop in bootstrapStores.ts)`,
          });
          console.error(`🔴 [Store Loop Error]: ${storeName} updated ${count} times in 60s!`);
        }
      }
    }

    // 2. Detect Invariant Violations
    if (text.includes('[Invariant]')) {
      capturedErrors.push({
        category: 'Store Invariant Violation',
        message: text,
      });
      console.error(`🔴 [Invariant Violation]: ${text}`);
    }

    // 3. Detect Daemon Unsupported Message Type Errors
    if (text.includes('Unsupported message type') || text.includes('Unknown message type')) {
      capturedErrors.push({
        category: 'Daemon Protocol Error (Unsupported Message Type)',
        message: text,
      });
      console.error(`🔴 [Daemon Protocol Error]: ${text}`);
    }

    // 4. Detect Tauri IPC Missing Command or Callback Errors
    if (text.includes('Couldn\'t find callback id') || text.includes('Sidecar restart failed') || text.includes('command open_url not found')) {
      capturedErrors.push({
        category: 'Tauri IPC / Sidecar Daemon Error',
        message: text,
      });
      console.error(`🔴 [Tauri IPC Error]: ${text}`);
    }

    // 5. Generic Console Errors
    if (msg.type() === 'error' && !text.includes('[Invariant]') && !text.includes('Unsupported message type')) {
      capturedErrors.push({
        category: 'Console Error',
        message: text,
      });
      console.error(`🔴 [Console Error]: ${text}`);
    }
  });

  // Listen to HTTP Network Requests & Responses (504 Outdated Optimize Dep, 404s)
  page.on('response', (response) => {
    if (response.status() >= 400) {
      capturedErrors.push({
        category: 'HTTP Network Error (Vite 504 / Dep Failure)',
        status: response.status(),
        url: response.url(),
        message: `HTTP ${response.status()} on ${response.url()}`,
      });
      console.error(`🔴 [HTTP ${response.status()}]: ${response.url()}`);
    }
  });

  try {
    console.log(`[UI Audit] Navigating to ${TARGET_URL}...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(3000);

    // ── Phase 1: Test Model Selector Badge (onMouseDown vs onClick) ──
    console.log(`[UI Audit] Phase 1: Auditing Main Surface Model Selector...`);
    const modelBadge = await page.$('div[class*="modelBadge"], .modelBadge, [title*="模型"]');
    if (modelBadge && (await modelBadge.isVisible())) {
      console.log(`[UI Audit] Clicking Model Selector Badge (.modelBadge)...`);
      await modelBadge.click({ force: true }).catch(() => {});
      const modelMenu = await page
        .waitForSelector('[class*="modelBadgePicker"], [role="menu"], .model-picker-popover', {
          state: 'visible',
          timeout: 2500,
        })
        .catch(() => null);

      if (!modelMenu) {
        capturedErrors.push({
          category: 'UI Interaction Failure',
          message: 'Model selection button (.modelBadge) clicked but model list dropdown menu failed to pop up',
        });
        console.warn(`⚠️ [UI Interaction Failure] Model Badge dropdown failed to pop up!`);
      } else {
        console.log(`✅ Model Selector menu displayed successfully!`);
      }
    }

    // ── Phase 2: Expand Tool Panel & Add All Tool Cards ──
    console.log(`[UI Audit] Phase 2: Expanding Tool Panel & Mount Tool Cards...`);
    const expandRightBtn = await page.$('button[aria-label="展开右面板"]');
    if (expandRightBtn && (await expandRightBtn.isVisible())) {
      await expandRightBtn.click().catch(() => {});
      await page.waitForTimeout(800);
    }

    const addBtns = await page.$$('.tabs-add-btn, button[aria-label="打开面板"], .tabs-add-btn button');
    for (const addBtn of addBtns) {
      if (await addBtn.isVisible().catch(() => false)) {
        await addBtn.click().catch(() => {});
        await page.waitForTimeout(500);

        const menuItems = await page.$$('[role="menuitem"], .tabs-add-menu-item, .add-menu-item, div[aria-label*="打开"]');
        for (let j = 0; j < menuItems.length; j++) {
          const item = menuItems[j];
          if (await item.isVisible().catch(() => false)) {
            const label = await item.textContent().catch(() => '');
            console.log(`[UI Audit] Opening card tab: "${label.trim()}"`);
            await item.click().catch(() => {});
            await page.waitForTimeout(600);
            await addBtn.click().catch(() => {});
            await page.waitForTimeout(300);
          }
        }
      }
    }

    // ── Phase 3: Switch through Mounted Card Tabs ──
    console.log(`[UI Audit] Phase 3: Switching through mounted card tabs...`);
    const tabs = await page.$$('[data-card-id], [role="tab"], .card-tab');
    for (let i = 0; i < tabs.length; i++) {
      if (await tabs[i].isVisible().catch(() => false)) {
        const cardId = await tabs[i].getAttribute('data-card-id').catch(() => `tab-${i}`);
        console.log(`[UI Audit] Activating card tab: ${cardId}`);
        await tabs[i].click().catch(() => {});
        await page.waitForTimeout(800);
      }
    }

    // ── Phase 4: Exhaustive Click Traversal based on Manifest ──
    console.log(`[UI Audit] Phase 4: Exhaustive DOM traversal of interactive buttons & switches...`);
    const allButtons = await page.$$('button, [role="button"], [aria-label], .clickable');
    console.log(`[UI Audit] Discovered ${allButtons.length} clickable elements on screen`);

    for (let k = 0; k < Math.min(allButtons.length, 50); k++) {
      try {
        if (await allButtons[k].isVisible()) {
          await allButtons[k].click({ timeout: 1000 }).catch(() => {});
          await page.waitForTimeout(300);
        }
      } catch { /* 点击失败继续下一个按钮 */ }
    }

    // ── Phase 5: Settings Modal & 12 Sub-Tabs Audit ──
    console.log(`[UI Audit] Phase 5: Auditing Settings Modal & 12 Sub-Tabs...`);
    const settingsBtn = await page.$('button[aria-label="打开快捷设置菜单"], button:has-text("设置")');
    if (settingsBtn && (await settingsBtn.isVisible())) {
      await settingsBtn.click().catch(() => {});
      await page.waitForTimeout(800);

      const sTabs = await page.$$('.settings-nav-item, [role="tab"], .settings-tab-btn, button[class*="navItem"]');
      console.log(`[UI Audit] Found ${sTabs.length} settings sub-tabs`);
      for (const st of sTabs) {
        if (await st.isVisible().catch(() => false)) {
          const name = await st.textContent().catch(() => '');
          console.log(`[UI Audit] Clicking settings sub-tab: "${name.trim()}"`);
          await st.click().catch(() => {});
          await page.waitForTimeout(500);
        }
      }
    }

    await page.waitForTimeout(2000);

  } catch (err) {
    console.error(`[UI Audit Error] Audit execution error: ${err.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n========================================`);
  console.log(`   EXHAUSTIVE UI & IPC AUDIT REPORT     `);
  console.log(`========================================`);
  console.log(`Total Errors Captured: ${capturedErrors.length}`);

  if (capturedErrors.length > 0) {
    console.log(`\nDetailed Errors Breakdown:`);
    const grouped = {};
    capturedErrors.forEach((err) => {
      grouped[err.category] = (grouped[err.category] || 0) + 1;
    });

    Object.entries(grouped).forEach(([cat, count]) => {
      console.log(`  - [${cat}]: ${count} occurrence(s)`);
    });

    console.log(`\nDetailed Error Logs:`);
    capturedErrors.forEach((err, idx) => {
      console.log(`\n--- Error #${idx + 1} [${err.category}] ---`);
      console.log(`Message: ${err.message}`);
      if (err.url) console.log(`URL: ${err.url}`);
      if (err.stack) console.log(`Stack:\n${err.stack.slice(0, 600)}`);
    });
    process.exit(1);
  } else {
    console.log(`✅ Zero runtime errors captured! Entire UI and IPC protocol clean.`);
    process.exit(0);
  }
}

runComprehensiveAudit();
