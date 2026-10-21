import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = dirname(fileURLToPath(import.meta.url));
const cardCss = readFileSync(join(dir, 'ChatCard.module.css'), 'utf8');
const listCss = readFileSync(
  join(dir, '../chat-message-list/ChatMessageList.module.css'),
  'utf8'
);
const tabCss = readFileSync(
  join(dir, '../binary-tree/PaneHeader.module.css'),
  'utf8'
);

describe('会话切换动效契约', () => {
  it('底栏只做位移，滚动占位不跟 flex-grow 伸缩', () => {
    expect(cardCss).not.toMatch(/transition:\s*flex-grow/);
    expect(cardCss).toMatch(/\.footerMotion\s*\{[^}]*transition:\s*transform/);
    expect(cardCss).toMatch(
      /data-empty-kind='session-empty'\] \.footerMotion[\s\S]*translateY\(calc\(50% - 61\.8cqh\)\)/
    );
    expect(cardCss).not.toMatch(/flex:\s*3\s+1\s+auto/);
  });

  it('消息层入场只淡入，不平移正文', () => {
    const keyframes = listCss.slice(
      listCss.indexOf('@keyframes streamHostEnter'),
      listCss.indexOf('.streamHost {')
    );
    expect(keyframes).not.toMatch(/translateY/);
    expect(keyframes).toMatch(/opacity:\s*0\.94/);
  });

  it('会话标签选中态不改变字重', () => {
    const block = tabCss.slice(
      tabCss.indexOf('.tabItemActive {'),
      tabCss.indexOf('.tabItemActive:hover')
    );
    expect(block).toMatch(/font-weight:\s*400/);
    expect(block).not.toMatch(/font-weight:\s*500/);
  });
});
