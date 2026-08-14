/* global window, document, getComputedStyle */
/* 样式退化数据审计：采集关键 UI 元素计算样式 + 布局异常信号（无图片依赖） */
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5175';

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleWarns = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') consoleWarns.push(`[${m.type()}] ${m.text().slice(0, 180)}`);
  });
  page.on('pageerror', (e) => consoleWarns.push(`[pageerror] ${String(e).slice(0, 200)}`));

  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => console.log('goto fail:', String(e).slice(0, 200)));
  await page.waitForTimeout(3500);

  const audit = await page.evaluate(() => {
    const results = [];
    const cssVars = {};
    const root = getComputedStyle(document.documentElement);
    for (const v of root) {
      if (v.startsWith('--')) {
        const val = root.getPropertyValue(v).trim();
        if (val && val !== 'initial') cssVars[v] = val;
      }
    }

    // 采样关键元素（按语义与常见类名探测）
    const probes = {
      'button-primary': 'button[class*=primary]',
      'button-default': 'button:not([class*=primary])',
      'input-text': 'input[type=text], input:not([type])',
      'textarea': 'textarea',
      'sidebar-nav': 'nav, aside, [class*=sidebar]',
      'tab': '[role=tab], [class*=tab]',
      'toast': '[class*=toast]',
      'banner': '[class*=banner], [class*=notice]',
      'msg-user': '[class*=user][class*=message], [class*=bubble]',
      'composer': '[contenteditable=true], [class*=composer]',
    };
    for (const [name, sel] of Object.entries(probes)) {
      const el = document.querySelector(sel);
      if (!el) { results.push({ name, found: false }); continue; }
      const cs = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      results.push({
        name, found: true,
        tag: el.tagName,
        rect: `${Math.round(rect.width)}x${Math.round(rect.height)}@${Math.round(rect.x)},${Math.round(rect.y)}`,
        bg: cs.backgroundColor, color: cs.color,
        border: `${cs.borderWidth} ${cs.borderStyle} ${cs.borderColor}`,
        radius: cs.borderRadius, shadow: cs.boxShadow.slice(0, 60),
        font: `${cs.fontSize} ${cs.fontFamily.split(',')[0]}`,
        padding: cs.padding, gap: cs.gap,
        class: (el.className || '').toString().slice(0, 80),
      });
    }

    // 布局异常信号
    const anomalies = [];
    const all = document.querySelectorAll('*');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 0) {
        if (r.right > window.innerWidth + 4 || r.left < -4) {
          const cls = (el.className || '').toString();
          if (cls && !cls.includes('cursor') && r.width < 4000) {
            anomalies.push(`overflow-right=${Math.round(r.right - window.innerWidth)}px <${el.tagName} class="${cls.slice(0, 60)}">`);
          }
        }
        if (r.height === 0 && el.children.length > 0 && getComputedStyle(el).display !== 'none') {
          // 有内容但高度 0 的可能塌陷
        }
      }
    }
    // 重叠检测（toast 遮挡输入区）
    const textarea = document.querySelector('textarea, [contenteditable=true]');
    if (textarea) {
      const tr = textarea.getBoundingClientRect();
      const toasts = document.querySelectorAll('[class*=toast]');
      for (const t of toasts) {
        const sr = t.getBoundingClientRect();
        if (sr.width > 0 && !(sr.right < tr.left || sr.left > tr.right || sr.bottom < tr.top || sr.top > tr.bottom)) {
          anomalies.push(`toast-overlaps-input: toast@${Math.round(sr.y)},${Math.round(sr.width)}x${Math.round(sr.height)} input@${Math.round(tr.y)}`);
        }
      }
    }
    // 颜色对比度粗检（正文文本）
    const textEl = document.querySelector('p, span, div');
    if (textEl) {
      const cs = getComputedStyle(textEl);
      anomalies.push(`sample-text color=${cs.color} bg=${cs.backgroundColor}`);
    }

    return { cssVars: Object.entries(cssVars).slice(0, 60), probes: results, anomalies: anomalies.slice(0, 20) };
  });

  console.log('STYLE_AUDIT2 ' + JSON.stringify(audit, null, 1).replace(/\n/g, '\n'));
  console.log('CONSOLE_WARNS:');
  for (const w of consoleWarns) console.log('  ' + w);
  await browser.close();
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });
