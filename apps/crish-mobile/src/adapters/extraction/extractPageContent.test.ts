/**
 * apps/crish-mobile/src/adapters/extraction/extractPageContent.test.ts
 *
 * 端侧网页正文提纯与 Markdown 转换引擎全面测试套件
 *
 * 覆盖矩阵：
 * 1. 文章正文提取、元数据解析与相对链接展开
 * 2. 对抗性标签、噪音标签、广告与 XSS 攻击向量剔除
 * 3. GFM Markdown 转换与多列对齐表格渲染
 * 4. 4K Token 预算硬截断守门与边界保护
 * 5. 畸形 HTML、未闭合标签与边界异常防御
 * 6. QuickJS 沙箱脚本序列化与自包含执行验证
 */

import {
  extractPageContent,
  buildExtractionSandboxScript,
  countWords,
  truncateContent,
} from './extractPageContent';
import {
  cleanHtml,
  extractMetadata,
  decodeHtmlEntities,
  resolveUrl,
} from './htmlCleaner';
import {
  convertHtmlToMarkdown,
  convertHtmlTableToGfm,
  extractPlainText,
  getVisualWidth,
} from './markdownConverter';
import { EXTRACTION_CONSTANTS } from './types';

describe('端侧网页正文提纯与 Markdown 转换引擎 (Extraction Engine)', () => {
  const targetUrl = 'https://news.example.com/articles/2026/future-of-ai.html';

  describe('1. 文章正文提取与元数据解析', () => {
    const sampleHtml = `
      <!DOCTYPE html>
      <html lang="zh-CN">
      <head>
        <title>页面默认标题 - 备用</title>
        <meta property="og:title" content="2026 年端侧 AI 大模型架构演进">
        <meta property="og:description" content="深入剖析端侧小模型与原生 QuickJS 隔离沙箱协同架构。">
        <meta name="author" content="架构委员会">
        <meta property="og:site_name" content="TechNews">
      </head>
      <body>
        <nav><a href="/">首页</a> | <a href="/news">新闻</a></nav>
        <article>
          <h1>2026 年端侧 AI 大模型架构演进</h1>
          <p>随着端侧算力的提升，<strong>小型化语言模型</strong>正迅速在移动设备上普及。</p>
          <p>更多技术细节请参阅 <a href="/docs/guide.html">架构指南</a> 与图片 <img src="/images/diagram.png" alt="系统拓扑图">。</p>
        </article>
        <footer>版权所有 2026 TechNews</footer>
      </body>
      </html>
    `;

    it('准确提取 OpenGraph 元数据、作者与站点名称', () => {
      // 验证独立元数据解析器
      const meta = extractMetadata(sampleHtml, targetUrl);
      expect(meta.title).toBe('2026 年端侧 AI 大模型架构演进');
      expect(meta.excerpt).toBe(
        '深入剖析端侧小模型与原生 QuickJS 隔离沙箱协同架构。'
      );
      expect(meta.byline).toBe('架构委员会');
      expect(meta.siteName).toBe('TechNews');

      const result = extractPageContent(sampleHtml, { targetUrl });

      expect(result.url).toBe(targetUrl);
      expect(result.title).toBe('2026 年端侧 AI 大模型架构演进');
      expect(result.excerpt).toBe(
        '深入剖析端侧小模型与原生 QuickJS 隔离沙箱协同架构。'
      );
      expect(result.byline).toBe('架构委员会');
      expect(result.siteName).toBe('TechNews');
      expect(result.truncated).toBe(false);
    });

    it('展开内部相对链接与媒体资源为绝对 URL', () => {
      const result = extractPageContent(sampleHtml, { targetUrl });

      expect(result.markdown).toContain(
        '[架构指南](https://news.example.com/docs/guide.html)'
      );
      expect(result.markdown).toContain(
        '![系统拓扑图](https://news.example.com/images/diagram.png)'
      );
    });

    it('当缺少 OpenGraph 时平稳回退至 title 标签与正文首段摘要', () => {
      const fallbackHtml = `
        <html>
        <head><title>纯文本文章标题</title></head>
        <body>
          <p>这是文章的第一段，用于验证自动生成摘要的回退机制是否能正常提取足够字数作为摘要预览。</p>
        </body>
        </html>
      `;

      const result = extractPageContent(fallbackHtml, {
        targetUrl: 'https://example.com/simple',
      });
      expect(result.title).toBe('纯文本文章标题');
      expect(result.excerpt).toContain('这是文章的第一段');
      expect(result.byline).toBeNull();
      expect(result.siteName).toBeNull();
    });

    it('正确计算中西文混合词数统计 (wordCount)', () => {
      const mixedText =
        '端侧 AI 架构 (Edge AI Architecture) 实现了 100% 离线运算。';
      // 汉字: 端, 侧, 架, 构, 实, 现, 了, 离, 线, 运, 算 (11)
      // 西文: AI, Edge, AI, Architecture, 100% (5)
      const count = countWords(mixedText);
      expect(count).toBeGreaterThan(12);
      expect(count).toBeLessThan(20);
    });
  });

  describe('2. 对抗性标签、噪音标签、广告与 XSS 攻击剔除', () => {
    it('彻底剔除 script, style, iframe, noscript, svg 等非正文标签', () => {
      const dirtyHtml = `
        <html>
        <head>
          <style>body { background: #000; }</style>
          <script>window.maliciousToken = "stolen";</script>
        </head>
        <body>
          <iframe src="https://evil.com/phishing"></iframe>
          <noscript><p>请开启 JavaScript</p></noscript>
          <svg><path d="M0 0h10v10H0z"/></svg>
          <p>这是真正的正文内容。</p>
        </body>
        </html>
      `;

      const { cleanedHtml } = cleanHtml(dirtyHtml, targetUrl);
      expect(cleanedHtml).not.toContain('<script');
      expect(cleanedHtml).not.toContain('maliciousToken');
      expect(cleanedHtml).not.toContain('<style');
      expect(cleanedHtml).not.toContain('<iframe');
      expect(cleanedHtml).not.toContain('<noscript');
      expect(cleanedHtml).not.toContain('<svg');
      expect(cleanedHtml).toContain('这是真正的正文内容。');
    });

    it('彻底剥离 nav, footer, header, aside 等外围结构', () => {
      const layoutHtml = `
        <div>
          <header><h1>网站全局头部导航</h1></header>
          <nav><ul><li>菜单项</li></ul></nav>
          <aside><p>侧边栏推荐阅读</p></aside>
          <main><p>核心文章内容。</p></main>
          <footer><p>网站备案号 123456</p></footer>
        </div>
      `;

      const result = extractPageContent(layoutHtml, { targetUrl });
      expect(result.text).not.toContain('网站全局头部导航');
      expect(result.text).not.toContain('菜单项');
      expect(result.text).not.toContain('侧边栏推荐阅读');
      expect(result.text).not.toContain('网站备案号');
      expect(result.text).toContain('核心文章内容。');
    });

    it('识别并剥离广告容器与 Cookie 弹窗', () => {
      const adHtml = `
        <div>
          <div class="ad-banner" id="banner-ad">
            <p>点击领取代金券 999 元！</p>
          </div>
          <div id="cookie-consent" class="cookie-notice">
            <p>我们使用 Cookie 提升您的体验。</p>
          </div>
          <div class="article-body">
            <p>科学研究表明，规律作息有助于身心健康。</p>
          </div>
        </div>
      `;

      const result = extractPageContent(adHtml, { targetUrl });
      expect(result.text).not.toContain('点击领取代金券');
      expect(result.text).not.toContain('我们使用 Cookie');
      expect(result.text).toContain('科学研究表明，规律作息有助于身心健康。');
    });

    it('防御 XSS 攻击：剥离 inline on* 事件属性并中和 javascript: 链接', () => {
      const xssHtml = `
        <div>
          <img src="valid.png" onerror="alert('xss')" onload="fetch('//evil.com')">
          <a href="javascript:void(0)" onclick="doHacks()">点击危险链接</a>
          <p>安全文本。</p>
        </div>
      `;

      const { cleanedHtml } = cleanHtml(xssHtml, targetUrl);
      expect(cleanedHtml).not.toContain('onerror');
      expect(cleanedHtml).not.toContain('onload');
      expect(cleanedHtml).not.toContain('onclick');
      expect(cleanedHtml).not.toContain('javascript:');
      expect(cleanedHtml).toContain('href="#"');
    });
  });

  describe('3. 标准 GFM Markdown 转换与多列对齐表格渲染', () => {
    it('转换段落、多级 ATX 标题、行内修饰与列表', () => {
      const richHtml = `
        <h1>主标题一</h1>
        <h2>二级小标题</h2>
        <p>这是段落，包含 <strong>加粗文字</strong>、<em>斜体强调</em>、<del>已废弃功能</del> 以及 <code>const a = 1;</code> 行内代码。</p>
        <blockquote>这是一条重要引言。</blockquote>
        <hr>
        <ul>
          <li>无序清单项 A</li>
          <li>无序清单项 B</li>
        </ul>
        <ol>
          <li>步骤一</li>
          <li>步骤二</li>
        </ol>
      `;

      const md = convertHtmlToMarkdown(richHtml);
      expect(md).toContain('# 主标题一');
      expect(md).toContain('## 二级小标题');
      expect(md).toContain('**加粗文字**');
      expect(md).toContain('*斜体强调*');
      expect(md).toContain('~~已废弃功能~~');
      expect(md).toContain('`const a = 1;`');
      expect(md).toContain('> 这是一条重要引言。');
      expect(md).toContain('---');
      expect(md).toContain('- 无序清单项 A');
      expect(md).toContain('- 无序清单项 B');
      expect(md).toContain('1. 步骤一');
      expect(md).toContain('2. 步骤二');
    });

    it('代码块完整保留换行与空格，内部不被 Markdown 格式污染', () => {
      const codeHtml = `
        <p>代码示例：</p>
        <pre><code class="language-typescript">function add(a: number, b: number): number {
  // 保持缩进
  return a + b;
}</code></pre>
      `;

      const md = convertHtmlToMarkdown(codeHtml);
      expect(md).toContain('```typescript');
      expect(md).toContain('function add(a: number, b: number): number {');
      expect(md).toContain('  return a + b;');
      expect(md).toContain('```');
    });

    it('将带有 thead/tbody 的标准 HTML 表格转换为对齐 GFM 表格', () => {
      const tableHtml = `
        <table>
          <thead>
            <tr>
              <th>模型名称</th>
              <th>参数量</th>
              <th>上下文窗口</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Crish-Small</td>
              <td>1.5B</td>
              <td>32k</td>
            </tr>
            <tr>
              <td>Crish-Pro</td>
              <td>7B</td>
              <td>128k</td>
            </tr>
          </tbody>
        </table>
      `;

      const gfmTable = convertHtmlTableToGfm(tableHtml);
      expect(gfmTable).toContain('| 模型名称');
      expect(gfmTable).toContain('| 参数量');
      expect(gfmTable).toContain('| 上下文窗口');
      expect(gfmTable).toContain('| ---');
      expect(gfmTable).toContain('| Crish-Small');
      expect(gfmTable).toContain('| 1.5B');
      expect(gfmTable).toContain('| Crish-Pro');
    });

    it('无 th 标头的普通表格自动将第 1 行作为表头并补充对齐行', () => {
      const simpleTable = `
        <table>
          <tr>
            <td>姓名</td>
            <td>职务</td>
          </tr>
          <tr>
            <td>张三</td>
            <td>研发工程师</td>
          </tr>
        </table>
      `;

      const gfmTable = convertHtmlTableToGfm(simpleTable);
      expect(gfmTable).toContain('| 姓名');
      expect(gfmTable).toContain('| 职务');
      expect(gfmTable).toContain('| ---');
      expect(gfmTable).toContain('| 张三');
      expect(gfmTable).toContain('| 研发工程师');
    });

    it('表格单元格内存在竖线 | 时自动转义为 \\|，换行规整为空格', () => {
      const specialTable = `
        <table>
          <tr>
            <th>表达式</th>
            <th>说明</th>
          </tr>
          <tr>
            <td>a | b</td>
            <td>按位或运算<br>多行说明文本</td>
          </tr>
        </table>
      `;

      const gfmTable = convertHtmlTableToGfm(specialTable);
      expect(gfmTable).toContain('a \\| b');
      expect(gfmTable).toContain('按位或运算 多行说明文本');
      // 保证每一行数据仅占单行物理行
      const lines = gfmTable.trim().split('\n');
      expect(lines.length).toBe(3); // 表头 + 分隔线 + 1 行数据

      // 验证视觉显示宽度计算与纯文本提取独立算法
      expect(getVisualWidth('ABC')).toBe(3);
      expect(getVisualWidth('中文字符')).toBe(8);
      expect(extractPlainText('<h1>标题</h1><p>正文段落</p>')).toBe(
        '标题\n\n正文段落'
      );
    });
  });

  describe('4. 4K Token 预算硬截断守门与边界保护', () => {
    it('当内容长度在 4,000 Token 预算内时，不发生截断 (truncated = false)', () => {
      const shortHtml = '<p>这是一篇字数较短的正常新闻资讯，完全在预算内。</p>';
      const result = extractPageContent(shortHtml, { targetUrl });

      expect(result.truncated).toBe(false);
      expect(result.text).not.toContain(EXTRACTION_CONSTANTS.TRUNCATION_MARKER);
      expect(result.estimatedTokens).toBeLessThan(100);
    });

    it('当内容超过 4,000 Token（约 24,000 字符）时硬截断并追加指定标记', () => {
      // 构造超长段落：每个段落 100 字符，共 300 个段落（约 30,000 字符）
      const paragraph =
        '端侧大模型协同执行框架具备低延迟与强隐私保护特性，全面支持离线沙箱执行。\n';
      const repeatedText = paragraph.repeat(700);
      const longHtml = `<html><body><article><p>${repeatedText}</p></article></body></html>`;

      const result = extractPageContent(longHtml, { targetUrl });

      expect(result.truncated).toBe(true);
      expect(result.text).toContain(EXTRACTION_CONSTANTS.TRUNCATION_MARKER);
      expect(result.markdown).toContain(EXTRACTION_CONSTANTS.TRUNCATION_MARKER);
      // 截断后的有效内容应当在 24,000 字符预算上下
      expect(result.text.length).toBeLessThanOrEqual(24500);
      expect(result.estimatedTokens).toBeLessThanOrEqual(4000);
    });

    it('支持自定义单页 Token 预算 (如 maxTokens = 500)', () => {
      const paragraph = '测试自定义预算截断行为规范与准确性。\n';
      const repeated = paragraph.repeat(300); // 约 6,000 字符
      const html = `<p>${repeated}</p>`;

      const result = extractPageContent(html, { targetUrl, maxTokens: 500 });
      // 500 tokens * 6 chars/token = 3000 chars
      expect(result.truncated).toBe(true);
      expect(result.text).toContain(EXTRACTION_CONSTANTS.TRUNCATION_MARKER);
      expect(result.text.length).toBeLessThanOrEqual(3200);
      expect(result.estimatedTokens).toBeLessThanOrEqual(500);
    });

    it('truncateContent 优先寻找标点或换行进行语义截断', () => {
      const content = '第一句话。第二句话。第三句话。第四句话。第五句话。';
      // 设定上限 18 个字符（在第三句与第四句之间截断，优先对齐第三句句号）
      const truncated = truncateContent(content, 18, '... [截断]');
      expect(truncated).toContain('第三句话。');
      expect(truncated).toContain('... [截断]');
      expect(truncated).not.toContain('第四句话');
    });
  });

  describe('5. 畸形 HTML 与对抗场景容错防御', () => {
    it('空字符串或纯空格平稳返回空结构而不抛错', () => {
      const emptyResult = extractPageContent('', { targetUrl });
      expect(emptyResult.title).toBe('');
      expect(emptyResult.text).toBe('');
      expect(emptyResult.wordCount).toBe(0);
      expect(emptyResult.truncated).toBe(false);

      const whitespaceResult = extractPageContent('   \n\t   ', { targetUrl });
      expect(whitespaceResult.text).toBe('');
    });

    it('缺失 html, head, body 标签的裸 HTML 片段平稳解析', () => {
      const nakedHtml = '<div><h2>裸片段标题</h2><p>正文内容测试</p></div>';
      const result = extractPageContent(nakedHtml, { targetUrl });

      expect(result.title).toBe('裸片段标题');
      expect(result.text).toContain('正文内容测试');
      expect(result.markdown).toContain('## 裸片段标题');
    });

    it('存在未闭合标签或交错标签时稳健解析', () => {
      const brokenHtml =
        '<p>未闭合段落 1 <p>未闭合段落 2 <div>未闭合层 <table><tr><td>单格数据</table>';
      const result = extractPageContent(brokenHtml, { targetUrl });

      expect(result.text).toContain('未闭合段落 1');
      expect(result.text).toContain('未闭合段落 2');
      expect(result.text).toContain('单格数据');
    });

    it('处理未知实体、十进制与十六进制合法/非法实体', () => {
      const raw =
        '版权 &copy; 2026 &middot; 价格 &#165; 100 &#x2605; 星星 &#999999999; 异常';
      const decoded = decodeHtmlEntities(raw);

      expect(decoded).toContain('版权 © 2026 · 价格 ¥ 100 ★ 星星');
    });

    it('resolveUrl 能够处理畸形与相对 URL', () => {
      const base = 'https://example.com/a/b/page.html';
      expect(resolveUrl('sub.html', base)).toBe(
        'https://example.com/a/b/sub.html'
      );
      expect(resolveUrl('/root.html', base)).toBe(
        'https://example.com/root.html'
      );
      expect(resolveUrl('//cdn.example.com/pic.png', base)).toBe(
        'https://cdn.example.com/pic.png'
      );
      expect(resolveUrl('#section1', base)).toBe('#section1');
      expect(resolveUrl('javascript:alert(1)', base)).toBe('#');
    });
  });

  describe('6. 沙箱脚本序列化与自包含执行验证 (QuickJS 兼容性)', () => {
    it('buildExtractionSandboxScript 生成的脚本可被自包含评估并返回预期 JSON 结果', () => {
      const testHtml = `
        <html>
        <head>
          <meta property="og:title" content="沙箱脚本执行测试">
          <meta name="description" content="验证 QuickJS 自包含脚本生成与结果序列化。">
        </head>
        <body>
          <article>
            <h1>沙箱脚本执行测试</h1>
            <p>在原生独立沙箱线程中提纯网页正文，确保主 UI 线程零阻塞。</p>
            <table>
              <tr><th>特性</th><th>状态</th></tr>
              <tr><td>零依赖</td><td>支持</td></tr>
            </table>
          </article>
        </body>
        </html>
      `;

      const script = buildExtractionSandboxScript(testHtml, { targetUrl });
      expect(typeof script).toBe('string');
      expect(script).toContain('__payload');

      // 使用 eval 模拟沙箱直接执行自包含脚本字符串

      const rawResult = eval(script);
      expect(typeof rawResult).toBe('string');

      const parsed = JSON.parse(rawResult);
      expect(parsed.url).toBe(targetUrl);
      expect(parsed.title).toBe('沙箱脚本执行测试');
      expect(parsed.excerpt).toBe('验证 QuickJS 自包含脚本生成与结果序列化。');
      expect(parsed.text).toContain('在原生独立沙箱线程中提纯网页正文');
      expect(parsed.markdown).toContain('| 特性');
      expect(parsed.markdown).toContain('| 零依赖');
      expect(parsed.truncated).toBe(false);
    });
  });
});
