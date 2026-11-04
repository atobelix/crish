// WebView 文档拼装断言（批 E)：库内嵌完整、源码逐字保真且不可逃逸、
// 主题与安全口径（本地拼装、无网络面、mermaid strict）逐项钉死。
import { buildWebHtml } from './buildWebHtml';

describe('buildWebHtml · math', () => {
  const html = buildWebHtml({
    kind: 'math',
    source: 'E = mc^2',
    dark: false,
    textColor: '#171717',
  });

  it('内嵌 KaTeX 库与字体 CSS（本地拼装，无外部引用）', () => {
    expect(html).toContain('katex');
    expect(html.length).toBeGreaterThan(100_000);
    // 字体以 data URI 内嵌，不留相对 / 远程 url
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toMatch(/href="https?:/);
  });

  it('公式原文逐字进入渲染调用，displayMode 开', () => {
    expect(html).toContain('katex.render(');
    expect(html).toContain('"E = mc^2"');
    expect(html).toContain('displayMode: true');
    expect(html).toContain('trust: false');
  });

  it('源码含 </script> 时被转义，不可能提前闭合脚本', () => {
    const hostile = buildWebHtml({
      kind: 'math',
      source: 'x</script><script>alert(1)</script>',
      dark: false,
      textColor: '#171717',
    });
    expect(hostile).not.toContain('x</script>');
    expect(hostile).toContain('x\\u003c/script>');
  });
});

describe('buildWebHtml · mermaid', () => {
  it('内嵌 mermaid 库、strict 安全级、原文保真', () => {
    const html = buildWebHtml({
      kind: 'mermaid',
      source: 'graph TD; A-->B;',
      dark: false,
      textColor: '#171717',
    });
    expect(html).toContain('mermaid');
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(html).toContain("securityLevel: 'strict'");
    expect(html).toContain('"graph TD; A-->B;"');
    expect(html).toContain("theme: 'default'");
  });

  it('深色主题走 dark 图主题', () => {
    const html = buildWebHtml({
      kind: 'mermaid',
      source: 'graph TD; A-->B;',
      dark: true,
      textColor: '#ececec',
    });
    expect(html).toContain("theme: 'dark'");
  });
});
