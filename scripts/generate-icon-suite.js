const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_DIR = path.join('C:', 'Software', 'conex', 'assets', 'iconLib', 'app-icons');
const SVG_DIR = path.join(BASE_DIR, 'svg');
const PNG_DIR = path.join(BASE_DIR, 'png');
const PUBLIC_DIR = path.join('C:', 'Software', 'conex', 'apps', 'crish-desktop', 'public');

// 确保目录存在
[BASE_DIR, SVG_DIR, PNG_DIR, PUBLIC_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// SVG 图标全集内容 (优化版黄金比例：线条加厚 stroke-width=26，绿点直径 32px [r=16] 稍微粗于 26px 线条)
const SVG_DEFINITIONS = {
    'app-icon-dark-classic': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-grad" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#131316"/>
      <stop offset="100%" stop-color="#08080a"/>
    </linearGradient>
    <filter id="soft-goo" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
      <feColorMatrix in="blur" mode="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 18 -8" result="goo" />
      <feComposite in="SourceGraphic" in2="goo" operator="atop" />
    </filter>
    <filter id="glow-dynamic" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="0.8" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect width="200" height="200" rx="50" fill="url(#bg-grad)" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" filter="url(#glow-dynamic)" />
  <g filter="url(#soft-goo)" fill="none" stroke="#F4F4F5" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-grey-green': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-grad-grey" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#27272A"/>
      <stop offset="100%" stop-color="#18181B"/>
    </linearGradient>
    <filter id="soft-goo-grey" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
      <feColorMatrix in="blur" mode="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 18 -8" result="goo" />
      <feComposite in="SourceGraphic" in2="goo" operator="atop" />
    </filter>
    <filter id="glow-grey" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="0.8" result="blur" />
      <feMerge>
        <feMergeNode in="blur" />
        <feMergeNode in="SourceGraphic" />
      </feMerge>
    </filter>
  </defs>
  <rect width="200" height="200" rx="50" fill="url(#bg-grad-grey)" stroke="rgba(255,255,255,0.08)" stroke-width="2" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" filter="url(#glow-grey)" />
  <g filter="url(#soft-goo-grey)" fill="none" stroke="#F4F4F5" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-light-day': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg-grad-light" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#F4F4F5"/>
    </linearGradient>
    <filter id="soft-goo-light" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2.5" result="blur" />
      <feColorMatrix in="blur" mode="matrix" values="
          1 0 0 0 0
          0 1 0 0 0
          0 0 1 0 0
          0 0 0 18 -8" result="goo" />
      <feComposite in="SourceGraphic" in2="goo" operator="atop" />
    </filter>
  </defs>
  <rect width="200" height="200" rx="50" fill="url(#bg-grad-light)" stroke="#E4E4E7" stroke-width="2" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" />
  <g filter="url(#soft-goo-light)" fill="none" stroke="#18181B" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-white-black-green': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="50" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="2" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" />
  <g fill="none" stroke="#09090B" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-black-white-green': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="50" fill="#09090B" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#10B981" />
  <g fill="none" stroke="#FFFFFF" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-mono-white': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="50" fill="#09090B" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#FFFFFF" />
  <g fill="none" stroke="#FFFFFF" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-mono-black': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <rect width="200" height="200" rx="50" fill="#FFFFFF" stroke="#E4E4E7" stroke-width="2" />
  <ellipse cx="100" cy="35" rx="16" ry="16" fill="#000000" />
  <g fill="none" stroke="#000000" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 118 L 28 118" />
    <path d="M 100 118 L 172 118" />
    <path d="M 100 118 L 58 42" />
    <path d="M 100 118 L 142 42" />
    <path d="M 100 118 L 80 170" />
    <path d="M 100 118 L 120 170" />
  </g>
</svg>`,

    'app-icon-favicon-16': `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
  <ellipse cx="100" cy="34" rx="22" ry="22" fill="#10B981" />
  <g fill="none" stroke="#F4F4F5" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 100 120 L 20 120" />
    <path d="M 100 120 L 180 120" />
    <path d="M 100 120 L 52 34" />
    <path d="M 100 120 L 148 34" />
    <path d="M 100 120 L 76 178" />
    <path d="M 100 120 L 124 178" />
  </g>
</svg>`
};

const SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];

async function main() {
    console.log('🚀 开始生成线条加厚 (stroke-width=26) 且绿点稍微更粗 (直径32px > 26px) 的全套图标库...');

    // 1. 写入所有 SVG 文件
    for (const [name, content] of Object.entries(SVG_DEFINITIONS)) {
        const filePath = path.join(SVG_DIR, `${name}.svg`);
        fs.writeFileSync(filePath, content, 'utf8');
        console.log(`[SVG Saved] ${name}.svg`);
    }

    // 2. 导出常驻黑底彩图至软件 desktop public 目录
    fs.writeFileSync(path.join(PUBLIC_DIR, 'app-icon.svg'), SVG_DEFINITIONS['app-icon-dark-classic'], 'utf8');
    fs.writeFileSync(path.join(PUBLIC_DIR, 'favicon.svg'), SVG_DEFINITIONS['app-icon-favicon-16'], 'utf8');
    console.log(`[Desktop Assets] favicon.svg & app-icon.svg updated in ${PUBLIC_DIR}`);

    // 3. 使用 Playwright 渲染高质量多尺寸 PNG 图片
    const browser = await chromium.launch();
    const page = await browser.newPage();

    for (const [themeName, svgContent] of Object.entries(SVG_DEFINITIONS)) {
        const themeSubDir = path.join(PNG_DIR, themeName.replace('app-icon-', ''));
        if (!fs.existsSync(themeSubDir)) fs.mkdirSync(themeSubDir, { recursive: true });

        const html = `<!DOCTYPE html><html><head><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden;}svg{width:100%;height:100%;display:block;}</style></head><body>${svgContent}</body></html>`;
        await page.setContent(html);

        for (const size of SIZES) {
            await page.setViewportSize({ width: size, height: size });
            const pngPath = path.join(themeSubDir, `icon-${size}x${size}.png`);
            await page.screenshot({ path: pngPath, omitBackground: true });
            
            if (themeName === 'app-icon-dark-classic' && size === 512) {
                fs.copyFileSync(pngPath, path.join(PUBLIC_DIR, 'icon.png'));
                fs.copyFileSync(pngPath, path.join(PUBLIC_DIR, 'icon-512x512.png'));
            }
            if (themeName === 'app-icon-dark-classic' && size === 256) {
                fs.copyFileSync(pngPath, path.join(PUBLIC_DIR, 'icon-256x256.png'));
            }
        }
        console.log(`[PNG Exported] ${themeName} (${SIZES.length} sizes: 16px ~ 1024px)`);
    }

    await browser.close();

    // 4. 生成图标库 Index 说明文档
    const indexMarkdown = `# Arton 官方图标资产库 (App Icon Asset Suite) - 优化版

本文档归档 Arton 图标系统的完整矢量 SVG 与高清像素 PNG 资源文件。

## 1. 常驻主图标 (Default Desktop App Icon)
- **外观**：暗黑渐变底座 + 纯白六笔加粗星芒 (stroke-width=26) + 翡翠绿核心点 (\`r=16\`, 直径 32px > 线条粗细 26px)
- **SVG 主文件**：[app-icon-dark-classic.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-dark-classic.svg)
- **桌面应用同款**：[app-icon.svg](file:///C:/Software/conex/apps/crish-desktop/public/app-icon.svg) & [icon.png](file:///C:/Software/conex/apps/crish-desktop/public/icon.png)

---

## 2. 图标主题变体 (Major Theme Modes)

| 主题名称 | 矢量 SVG 文件 | PNG 尺寸套件 |
| :--- | :--- | :--- |
| **1. 经典黑夜 (Dark Classic)** | [app-icon-dark-classic.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-dark-classic.svg) | \`png/dark-classic/icon-[size].png\` (16px ~ 1024px) |
| **2. 高级灰底绿点 (Grey Green)** | [app-icon-grey-green.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-grey-green.svg) | \`png/grey-green/icon-[size].png\` (16px ~ 1024px) |
| **3. 明亮白天 (Light Day)** | [app-icon-light-day.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-light-day.svg) | \`png/light-day/icon-[size].png\` (16px ~ 1024px) |
| **4. 白底黑线绿点** | [app-icon-white-black-green.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-white-black-green.svg) | \`png/white-black-green/icon-[size].png\` (16px ~ 1024px) |
| **5. 黑底白线绿点** | [app-icon-black-white-green.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-black-white-green.svg) | \`png/black-white-green/icon-[size].png\` (16px ~ 1024px) |
| **6. 纯白单色 (Mono White)** | [app-icon-mono-white.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-mono-white.svg) | \`png/mono-white/icon-[size].png\` (16px ~ 1024px) |
| **7. 纯黑单色 (Mono Black)** | [app-icon-mono-black.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-mono-black.svg) | \`png/mono-black/icon-[size].png\` (16px ~ 1024px) |

---

## 3. 微型尺寸高清强化 Favicon
- **16px 强化版 (stroke-width=30, r=22)**：[app-icon-favicon-16.svg](file:///C:/Software/conex/assets/iconLib/app-icons/svg/app-icon-favicon-16.svg)
- **网页应用同步**：[favicon.svg](file:///C:/Software/conex/apps/crish-desktop/public/favicon.svg)
`;

    fs.writeFileSync(path.join(BASE_DIR, 'INDEX.md'), indexMarkdown, 'utf8');
    console.log(`🎉 全部图标套件生成完毕！索引已更新至 ${path.join(BASE_DIR, 'INDEX.md')}`);
}

main().catch(err => {
    console.error('❌ 生成失败:', err);
    process.exit(1);
});
