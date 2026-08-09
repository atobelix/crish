/* 样式检查截图脚本：连 5175 截取关键界面到 scratch/ui-shots/ */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';
const OUT = 'scratch/ui-shots';

async function main() {
  const fs = await import('node:fs');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      console.log(`[console.${m.type()}]`, m.text().slice(0, 200));
    }
  });
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console.log('goto fail:', String(e).slice(0, 200)));
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/01-home.png`, fullPage: false });

  // 打开设置
  const settingsBtn = page.getByRole('button', { name: /设置|快捷设置/ }).first();
  if (await settingsBtn.isVisible().catch(() => false)) {
    await settingsBtn.click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/02-settings.png` });
    await page.keyboard.press('Escape');
  }

  // 新建对话
  const newChat = page.getByRole('button', { name: /新对话|新建对话/ }).first();
  if (await newChat.isVisible().catch(() => false)) {
    await newChat.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${OUT}/03-newchat.png` });
  }

  // 检查计算样式关键节点
  const styleAudit = await page.evaluate(() => {
    const out = {};
    const probes = [
      ['body', document.body],
      ['main workspace', document.querySelector('main')],
      ['sidebar', document.querySelector('nav')],
      ['composer', document.querySelector('[class*=composer], textarea, [contenteditable=true]')],
      ['chat card', document.querySelector('[class*=chatCard], [class*=chat-card]')],
    ];
    for (const [name, el] of probes) {
      if (!el) { out[name] = 'NOT FOUND'; continue; }
      const cs = getComputedStyle(el);
      out[name] = `bg=${cs.backgroundColor} color=${cs.color} font=${cs.fontFamily.split(',')[0]} size=${cs.fontSize} radius=${cs.borderRadius} border=${cs.borderColor}`;
    }
    // CSS 变量
    const root = getComputedStyle(document.documentElement);
    const vars = {};
    for (const key of ['--bg', '--bg-primary', '--text', '--text-primary', '--accent', '--border', '--radius', '--radius-md', '--surface']) {
      vars[key] = root.getPropertyValue(key).trim() || '<unset>';
    }
    return { probes: out, cssVars: vars, darkScheme: matchMedia('(prefers-color-scheme: dark)').matches };
  });
  console.log('STYLE_AUDIT', JSON.stringify(styleAudit, null, 2));

  await browser.close();
  console.log('DONE shots in', OUT);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
