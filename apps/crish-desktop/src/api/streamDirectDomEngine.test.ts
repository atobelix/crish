import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  StreamDirectDomEngine,
  MAX_DIRECT_DOM_SLOTS,
  detectStructuralSyntaxBoundary,
} from './streamDirectDomEngine';

class MockTextNode {
  readonly nodeType = 3;
  data: string;
  parentNode: MockElement | null = null;

  constructor(initialData = '') {
    this.data = initialData;
  }

  appendData(chunk: string): void {
    this.data += chunk;
  }
}

class MockElement {
  isConnected = true;
  readonly childNodes: MockTextNode[] = [];
  readonly ownerDocument: { createTextNode: (text: string) => Text };

  constructor(doc: { createTextNode: (text: string) => Text }) {
    this.ownerDocument = doc;
  }

  appendChild(node: MockTextNode): MockTextNode {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.data).join('');
  }
}

function createConnectedContainer(): HTMLElement {
  const doc = {
    createTextNode: (text: string) => new MockTextNode(text) as unknown as Text,
  };
  return new MockElement(doc) as unknown as HTMLElement;
}

describe('StreamDirectDomEngine (src/api)', () => {
  let engine: StreamDirectDomEngine;

  beforeEach(() => {
    engine = new StreamDirectDomEngine();
  });

  it('binds container and appends incremental suffixes via TextNode.appendData', () => {
    const container = createConnectedContainer();

    const slot = engine.bindContainer('sess-1', 'msg-1', container, 'Hello');
    expect(slot).not.toBeNull();
    expect(container.textContent).toBe('Hello');

    const appendSpy = vi.spyOn(slot!.textNode, 'appendData');

    const ok1 = engine.appendText('sess-1', 'msg-1', 'Hello, ');
    expect(ok1).toBe(true);
    expect(appendSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledWith(', ');
    expect(container.textContent).toBe('Hello, ');

    const ok2 = engine.appendText('sess-1', 'msg-1', 'Hello, world!');
    expect(ok2).toBe(true);
    expect(appendSpy).toHaveBeenCalledTimes(2);
    expect(appendSpy).toHaveBeenLastCalledWith('world!');
    expect(container.textContent).toBe('Hello, world!');
    expect(engine.getCommittedText('sess-1', 'msg-1')).toBe('Hello, world!');
  });

  it('supports appendChunk for O(chunk.length) direct chunk writes', () => {
    const container = createConnectedContainer();
    const slot = engine.bindContainer('sess-chunk', 'msg-1', container, 'A');
    const appendSpy = vi.spyOn(slot!.textNode, 'appendData');

    const res = engine.appendChunk('sess-chunk', 'msg-1', 'BC');
    expect(res.appended).toBe(true);
    expect(res.deltaLength).toBe(2);
    expect(appendSpy).toHaveBeenCalledWith('BC');
    expect(container.textContent).toBe('ABC');
  });

  it('preserves ahead direct-DOM text when React commits an older prefix snapshot', () => {
    const container = createConnectedContainer();

    engine.bindContainer('sess-1', 'msg-1', container, 'Part 1');
    engine.appendText('sess-1', 'msg-1', 'Part 1 + Part 2');
    expect(container.textContent).toBe('Part 1 + Part 2');

    // React 批处理提交稍旧的前缀快照时，不得回退已直写的超前字符
    engine.reconcileAfterReactCommit('sess-1', 'msg-1', 'Part 1');
    expect(container.textContent).toBe('Part 1 + Part 2');

    // React 赶上最新文本后保持一致
    engine.reconcileAfterReactCommit('sess-1', 'msg-1', 'Part 1 + Part 2');
    expect(container.textContent).toBe('Part 1 + Part 2');
  });

  it('detects structural syntax boundaries across split incremental chunks', () => {
    const container = createConnectedContainer();
    engine.bindContainer('sess-ast', 'msg-ast', container, 'Here is code:\n``');

    const events: string[] = [];
    const unsubscribe = engine.onStructuralBoundary((_sid, _mid, boundary) => {
      if (boundary.kind) {
        events.push(boundary.kind);
      }
    });

    // 跨 chunk 闭合三个反引号 ```ts
    const report1 = engine.appendTextWithReport(
      'sess-ast',
      'msg-ast',
      'Here is code:\n```ts\nconst x = 1;'
    );
    expect(report1.boundary.hasBoundary).toBe(true);
    expect(report1.boundary.kind).toBe('code-fence');
    expect(events).toEqual(['code-fence']);

    // 跨 chunk 形成双换行段落边界
    const report2 = engine.appendTextWithReport(
      'sess-ast',
      'msg-ast',
      'Here is code:\n```ts\nconst x = 1;\n\nNext paragraph'
    );
    expect(report2.boundary.hasBoundary).toBe(true);
    expect(report2.boundary.kind).toBe('paragraph-break');

    unsubscribe();
  });

  it('detects GFM table delimiter, heading, blockquote, and list item boundaries', () => {
    expect(
      detectStructuralSyntaxBoundary('| Col A | Col B |\n', '| --- | --- |\n')
        .kind
    ).toBe('table-delimiter');
    expect(detectStructuralSyntaxBoundary('Intro\n', '## Section 2').kind).toBe(
      'heading-line'
    );
    expect(
      detectStructuralSyntaxBoundary('Intro\n', '> Quoted line').kind
    ).toBe('blockquote-line');
    expect(
      detectStructuralSyntaxBoundary('Intro\n', '- First bullet').kind
    ).toBe('list-item-line');
    expect(
      detectStructuralSyntaxBoundary('Plain words ', 'more plain words')
        .hasBoundary
    ).toBe(false);
  });

  it('enforces bounded LRU slot cap (MAX_DIRECT_DOM_SLOTS = 256) and refreshes accessed slots', () => {
    expect(MAX_DIRECT_DOM_SLOTS).toBe(256);
    const smallEngine = new StreamDirectDomEngine(4);

    for (let i = 0; i < 4; i += 1) {
      const el = createConnectedContainer();
      smallEngine.bindContainer('s1', `m-${i}`, el, `v-${i}`);
    }

    // 访问 m-0 使其刷新为最新槽位，此时最老槽位变为 m-1
    expect(smallEngine.getCommittedText('s1', 'm-0')).toBe('v-0');

    const el4 = createConnectedContainer();
    smallEngine.bindContainer('s1', 'm-4', el4, 'v-4');

    expect(smallEngine.size).toBe(4);
    expect(smallEngine.getCommittedText('s1', 'm-0')).toBe('v-0');
    expect(smallEngine.getCommittedText('s1', 'm-1')).toBeUndefined();
    expect(smallEngine.getCommittedText('s1', 'm-4')).toBe('v-4');
  });

  it('releases slots by session without affecting other sessions', () => {
    const el1 = createConnectedContainer();
    const el2 = createConnectedContainer();

    engine.bindContainer('sess-a', 'm1', el1, 'a');
    engine.bindContainer('sess-b', 'm1', el2, 'b');

    expect(engine.releaseSession('sess-a')).toBe(1);
    expect(engine.getCommittedText('sess-a', 'm1')).toBeUndefined();
    expect(engine.getCommittedText('sess-b', 'm1')).toBe('b');
  });
});
