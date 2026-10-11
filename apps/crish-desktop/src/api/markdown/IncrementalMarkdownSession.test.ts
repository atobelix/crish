import { describe, expect, it } from 'vitest';
import { IncrementalMarkdownSession } from './IncrementalMarkdownSession';

describe('IncrementalMarkdownSession', () => {
  it('只为累计输入的新增后缀创建文本渲染片段', () => {
    const session = new IncrementalMarkdownSession();

    const first = session.advance('a');
    expect(first.reset).toBe(false);
    expect(first.textParts.map((part) => part.source)).toEqual(['a']);
    expect(first.textParts[0]?.kind).toBe('inline');
    expect(first.html).toBe('<p class="md-p"></p>');
    session.resolveTextPart(first.textParts[0]!.id, 'a');

    const second = session.advance('ab');
    expect(second.reset).toBe(false);
    expect(second.textParts.map((part) => part.source)).toEqual(['b']);
    expect(second.textParts.map((part) => part.source)).not.toContain('ab');
    session.resolveTextPart(second.textParts[0]!.id, 'b');

    const third = session.advance('abc');
    expect(third.reset).toBe(false);
    expect(third.textParts.map((part) => part.source)).toEqual(['c']);
    expect(third.textParts.map((part) => part.source)).not.toContain('abc');
    session.resolveTextPart(third.textParts[0]!.id, 'c');

    expect(session.toHtml()).toBe('<p class="md-p">abc</p>');
  });

  it('标题先建立结构，强调正文随新增字符可见，控制符不进入 DOM', () => {
    const session = new IncrementalMarkdownSession();

    const first = session.advance('## **安全');
    expect(first.html).toBe('<h2 class="md-h2"></h2>');
    expect(first.html).not.toContain('##');
    expect(first.html).not.toContain('**');
    expect(first.textParts.map((part) => part.source)).toEqual(['安', '全']);
    session.resolveTextPart(first.textParts[0]!.id, '安');
    session.resolveTextPart(first.textParts[1]!.id, '全');

    const second = session.advance('## **安全**\n');

    expect(second.textParts).toHaveLength(1);
    expect(second.textParts[0]?.kind).toBe('inline');
    expect(second.textParts[0]?.source).toBe('**安全**');
    session.resolveTextPart(second.textParts[0]!.id, '<strong>安全</strong>');
    expect(session.toHtml()).toBe('<h2 class="md-h2"><strong>安全</strong></h2>');
    expect(session.toHtml()).not.toContain('##');
    expect(session.toHtml()).not.toContain('**');
  });

  it('列表项和围栏正文未封口时也按新增内容推进', () => {
    const session = new IncrementalMarkdownSession();

    const marker = session.advance('- ');
    expect(marker.html).toContain('<ul class="md-ul"><li class="md-li"></li></ul>');
    expect(marker.html).not.toMatch(/>\s*-/);
    const list = session.advance('- item');
    expect(list.textParts.map((part) => part.source)).toEqual(['item']);
    expect(list.textParts[0]?.kind).toBe('list-item');
    expect(list.html).toContain('<ul class="md-ul"><li class="md-li"></li></ul>');
    session.resolveTextPart(list.textParts[0]!.id, 'item');

    const second = session.advance('- item\n- second\n');
    expect(second.textParts.map((part) => part.source)).toEqual(['second']);
    expect(second.textParts[0]?.kind).toBe('list-item');
    session.resolveTextPart(second.textParts[0]!.id, 'second');
    expect(session.toHtml()).toContain(
      '<ul class="md-ul"><li class="md-li">item</li><li class="md-li">second</li></ul>'
    );

    const fence = session.advance('- item\n- second\n```ts\nconst value = 1');
    expect(fence.textParts).toHaveLength(0);
    expect(fence.html).toContain('<div class="md-code-block" data-lang="ts">');
    expect(fence.html).toContain('const value = 1');
    expect(fence.html).not.toContain('```');

    const closedFence = session.advance('- item\n- second\n```ts\nconst value = 1\n```\n');
    expect(closedFence.html).toContain('const value = 1');
    expect(closedFence.html).not.toContain('```');
  });

  it('链接和强调的开放 token 只展示安全正文，闭合时替换为 renderer 片段', () => {
    const linkSession = new IncrementalMarkdownSession();
    const partial = linkSession.advance('See [la');
    expect(partial.textParts.map((part) => part.source)).toContain('l');
    expect(partial.textParts.map((part) => part.source)).toContain('a');
    expect(partial.html).not.toContain('[la');
    for (const part of partial.textParts) linkSession.resolveTextPart(part.id, part.source);

    const link = linkSession.advance('See [label](https://example.test)');
    const complete = link.textParts.find((part) => part.source === '[label](https://example.test)');
    expect(complete?.kind).toBe('inline');
    expect(complete?.source).not.toBe('See [label](https://example.test)');
    linkSession.resolveTextPart(complete!.id, '<a href="https://example.test">label</a>');
    expect(linkSession.toHtml()).toContain('<a href="https://example.test">label</a>');
    expect(linkSession.toHtml()).not.toContain('[label]');
  });

  it('跨 chunk 分隔符、图片链接和 setext 标题不提前泄露源码', () => {
    const emphasis = new IncrementalMarkdownSession();
    expect(emphasis.advance('*').textParts).toHaveLength(0);
    const strong = emphasis.advance('**bold**');
    expect(strong.textParts.some((part) => part.source === '**bold**')).toBe(true);
    expect(strong.html).not.toContain('**');

    const image = new IncrementalMarkdownSession();
    expect(image.advance('!').textParts).toHaveLength(0);
    const imagePart = image.advance('![alt](https://example.test/a.png)')
      .textParts.find((part) => part.source === '![alt](https://example.test/a.png)');
    expect(imagePart?.kind).toBe('inline');
    image.resolveTextPart(imagePart!.id, '<img alt="alt" src="https://example.test/a.png">');
    expect(image.toHtml()).toContain('<img');
    expect(image.toHtml()).not.toContain('![alt]');

    const setext = new IncrementalMarkdownSession();
    const title = setext.advance('Title\n===');
    expect(title.html).toContain('<h1 class="md-h1">');
    expect(title.html).not.toContain('===');
    const titleParts = title.textParts;
    for (const part of titleParts) setext.resolveTextPart(part.id, part.source);
    expect(setext.toHtml()).toContain('<h1 class="md-h1">Title</h1>');
  });

  it('独立分割线按新增字符建立闭合 HTML 单元，并保留 setext 标题优先级', () => {
    for (const marker of ['---', '***', '___']) {
      const session = new IncrementalMarkdownSession();
      expect(session.advance(marker[0]!).html).not.toContain('<hr');
      expect(session.advance(marker.slice(0, 2)).html).not.toContain('<hr');

      const complete = session.advance(`${marker}\n`);
      expect(complete.html).toBe('<hr class="md-hr" />');
      expect(complete.html).not.toContain(marker);
      expect(session.toHtml()).toBe('<hr class="md-hr" />');
    }

    const setext = new IncrementalMarkdownSession();
    const heading = setext.advance('Title\n-');
    expect(heading.html).toContain('<p class="md-p">');
    expect(heading.html).not.toContain('---');
    for (const part of heading.textParts) setext.resolveTextPart(part.id, part.source);
    const completedHeading = setext.advance('Title\n---\n');
    expect(completedHeading.html).toBe('<h2 class="md-h2">Title</h2>');
    expect(completedHeading.html).not.toContain('<hr');
    expect(completedHeading.html).not.toContain('---');

    const plain = new IncrementalMarkdownSession();
    const plainResult = plain.advance('---text\n');
    for (const part of plainResult.textParts) plain.resolveTextPart(part.id, part.source);
    expect(plainResult.html).not.toContain('<hr');
    expect(plain.toHtml()).toContain('---text');

    const spaced = new IncrementalMarkdownSession();
    expect(spaced.advance('   ---\n').html).toBe('<hr class="md-hr" />');

    const indented = new IncrementalMarkdownSession();
    const indentedResult = indented.advance('    ---\n');
    for (const part of indentedResult.textParts) indented.resolveTextPart(part.id, part.source);
    expect(indentedResult.html).not.toContain('<hr');
    expect(indented.toHtml()).toContain('---');
  });

  it('列表续行保留同一 li，空行不会伪造 br', () => {
    const list = new IncrementalMarkdownSession();
    const first = list.advance('- first\n');
    for (const part of first.textParts) list.resolveTextPart(part.id, part.source);
    const continuation = list.advance('- first\n  continuation');
    for (const part of continuation.textParts) list.resolveTextPart(part.id, part.source);
    expect(list.toHtml()).toContain('<li class="md-li">first<br />continuation</li>');

    const paragraph = new IncrementalMarkdownSession();
    const blank = paragraph.advance('Title\n\n');
    for (const part of blank.textParts) paragraph.resolveTextPart(part.id, part.source);
    expect(paragraph.toHtml()).toBe('<p class="md-p">Title</p>');
  });

  it('输入回退时丢弃旧会话片段，避免旧结果重新进入 DOM', () => {
    const session = new IncrementalMarkdownSession();
    const first = session.advance('old');
    const oldRevision = first.revision;
    const next = session.advance('new');

    expect(next.reset).toBe(true);
    expect(next.revision).toBeGreaterThan(oldRevision);
    expect(session.toHtml()).not.toContain('old');
    expect(session.resolveTextPart(first.textParts[0]!.id, 'old')).toBe(false);
  });
});
