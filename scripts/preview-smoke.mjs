/* global document */
/* R2-4 C2 preview 冒烟：vite preview + 抽样 lazy 点渲染断言（无 console error） */
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';

const PORT = 4173;
const BASE = `http://localhost:${PORT}`;

async function main() {
  // 启动 vite preview（后台）
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: 'apps/crish-desktop',
    stdio: 'ignore',
    shell: true,
  });
  await new Promise((r) => setTimeout(r, 3000));

  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text().slice(0, 120)}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${String(e).slice(0, 120)}`));

  // 抽样 lazy 点：主页面 + 设置面板（内部懒加载各 tab）
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => errors.push(`goto: ${e}`));
  await page.waitForTimeout(2500);

  // 打开设置（触发 SettingsPanel lazy chunk）
  const settingsBtn = page.getByRole('button', { name: /快捷设置|设置/ }).first();
  if (await settingsBtn.isVisible().catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(2000);
  }

  const result = {
    baseLoaded: await page.evaluate(() => document.querySelector('#root')?.children.length ?? 0),
    errors,
  };
  console.log('PREVIEW_SMOKE ' + JSON.stringify(result));

  await browser.close();
  preview.kill();
  if (errors.length > 0) process.exit(1);
  console.log('PREVIEW SMOKE PASS');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
