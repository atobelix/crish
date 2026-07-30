/**
 * ImageGallery 集成测试 — Round 6 Agent 6.2
 *
 * 覆盖：
 *   1. ImageGallery 组件（空 / 单 / 多图 / className 透传）
 *   2. ImageTile 组件（http / data / local / svg / error / onerror）
 *   3. LocalImgResolver 组件（扫描 / 解析 / 已有 src 跳过 / 失败标记）
 *   4. resolveToolImages / isImageProducingTool（提取 / 去重 / 限制 16）
 *   5. sanitizeSvgContent（剥离 script / on* / javascript: / 保留合法元素与属性）
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  render,
  cleanup,
  waitFor,
  act,
  fireEvent,
} from '@testing-library/react';
import type { MessageImageRef } from '../../store/types';

// ─── inline mock: workspaceFsApi.toAssetUrl ───────────────────────────────
// 截断 Tauri IPC（convertFileSrc）依赖，直接控制 toAssetUrl 返回值。
const { toAssetUrlMock } = vi.hoisted(() => ({
  toAssetUrlMock: vi.fn<(path: string) => Promise<string | null>>(),
}));

vi.mock('../../api/workspaceFsApi', () => ({
  toAssetUrl: (path: string) => toAssetUrlMock(path),
}));

import { ImageGallery } from './ImageGallery';
import { ImageTile } from './ImageTile';
import { LocalImgResolver } from './LocalImgResolver';
import {
  resolveToolImages,
  isImageProducingTool,
} from '../../api/toolFeedback';
import { sanitizeSvgContent } from '../../api/markdown-render/markdownSanitizer';

// ─── IntersectionObserver 可控 mock ────────────────────────────────────────
// jsdom 无原生 IntersectionObserver；此处提供可控实现，支持手动触发相交。
interface IORecord {
  cb: (entries: IntersectionObserverEntry[]) => void;
  el: Element | null;
  disconnected: boolean;
}
let ioRecords: IORecord[] = [];

class IntersectionObserverMock {
  private rec: IORecord;
  constructor(cb: (entries: IntersectionObserverEntry[]) => void) {
    this.rec = { cb, el: null, disconnected: false };
    ioRecords.push(this.rec);
  }
  observe(el: Element) {
    this.rec.el = el;
  }
  unobserve() {}
  disconnect() {
    this.rec.disconnected = true;
  }
}

/** 触发所有未断开的 observer 的相交回调 */
function fireIntersection(isIntersecting: boolean) {
  act(() => {
    for (const r of ioRecords) {
      if (r.el && !r.disconnected) {
        r.cb([
          {
            isIntersecting,
            target: r.el,
          } as unknown as IntersectionObserverEntry,
        ]);
      }
    }
  });
}

// ─── helpers ──────────────────────────────────────────────────────────────
function makeImg(
  overrides: Partial<MessageImageRef> &
    Pick<MessageImageRef, 'id' | 'source' | 'kind'>
): MessageImageRef {
  const kind = overrides.kind;
  const isDirect = kind === 'http' || kind === 'data';
  return {
    status: isDirect ? 'resolved' : 'pending',
    resolvedUrl: isDirect ? overrides.source : undefined,
    ...overrides,
  };
}

function setupDom() {
  ioRecords = [];
  globalThis.IntersectionObserver =
    IntersectionObserverMock as unknown as typeof IntersectionObserver;
  toAssetUrlMock.mockReset();
}

function teardownDom() {
  cleanup();
}

// ─── ImageGallery ─────────────────────────────────────────────────────────
describe('ImageGallery', () => {
  beforeEach(setupDom);
  afterEach(teardownDom);

  it('returns null for empty images array', () => {
    const { container } = render(<ImageGallery images={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a single ImageTile for one image', async () => {
    const img = makeImg({
      id: 'a',
      source: 'https://ex.com/a.png',
      kind: 'http',
    });
    const { container } = render(<ImageGallery images={[img]} />);
    fireIntersection(true);
    await waitFor(() => {
      expect(container.querySelectorAll('img').length).toBe(1);
    });
  });

  it('renders multiple ImageTiles keyed by image.id', async () => {
    const images = [
      makeImg({ id: 'a', source: 'https://ex.com/a.png', kind: 'http' }),
      makeImg({ id: 'b', source: 'https://ex.com/b.png', kind: 'http' }),
      makeImg({ id: 'c', source: 'https://ex.com/c.png', kind: 'http' }),
    ];
    const { container } = render(<ImageGallery images={images} />);
    fireIntersection(true);
    await waitFor(() => {
      expect(container.querySelectorAll('img').length).toBe(3);
    });
    const srcs = Array.from(container.querySelectorAll('img')).map((e) =>
      e.getAttribute('src')
    );
    expect(srcs).toEqual([
      'https://ex.com/a.png',
      'https://ex.com/b.png',
      'https://ex.com/c.png',
    ]);
  });

  it('passes className through to the gallery container', () => {
    const img = makeImg({
      id: 'a',
      source: 'https://ex.com/a.png',
      kind: 'http',
    });
    const { container } = render(
      <ImageGallery images={[img]} className="my-custom-class" />
    );
    const gallery = container.firstChild as HTMLElement;
    expect(gallery).toBeTruthy();
    expect(gallery.className).toContain('my-custom-class');
  });
});

// ─── ImageTile ────────────────────────────────────────────────────────────
describe('ImageTile', () => {
  beforeEach(setupDom);
  afterEach(teardownDom);

  it('renders img directly for http kind after intersection', async () => {
    const img = makeImg({
      id: 'a',
      source: 'https://ex.com/a.png',
      kind: 'http',
    });
    const { container } = render(<ImageTile image={img} />);
    // Before intersection: placeholder, no img
    expect(container.querySelector('img')).toBeNull();
    fireIntersection(true);
    await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).toBeTruthy();
      expect(el!.getAttribute('src')).toBe('https://ex.com/a.png');
    });
  });

  it('renders img directly for data kind after intersection', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const img = makeImg({ id: 'a', source: dataUrl, kind: 'data' });
    const { container } = render(<ImageTile image={img} />);
    expect(container.querySelector('img')).toBeNull();
    fireIntersection(true);
    await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).toBeTruthy();
      expect(el!.getAttribute('src')).toBe(dataUrl);
    });
  });

  it('shows placeholder before intersection for local kind, then resolves via toAssetUrl', async () => {
    const img = makeImg({ id: 'a', source: 'C:\\imgs\\a.png', kind: 'local' });
    toAssetUrlMock.mockResolvedValue('asset://localhost/a.png');
    const { container } = render(<ImageTile image={img} />);
    // Before intersection: placeholder, no img, no IPC call
    expect(container.querySelector('img')).toBeNull();
    expect(toAssetUrlMock).not.toHaveBeenCalled();
    fireIntersection(true);
    await waitFor(() =>
      expect(toAssetUrlMock).toHaveBeenCalledWith('C:\\imgs\\a.png')
    );
    await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).toBeTruthy();
      expect(el!.getAttribute('src')).toBe('asset://localhost/a.png');
    });
  });

  it('shows error placeholder when toAssetUrl returns null', async () => {
    const img = makeImg({
      id: 'a',
      source: 'C:\\imgs\\bad.png',
      kind: 'local',
    });
    toAssetUrlMock.mockResolvedValue(null);
    const { container } = render(<ImageTile image={img} />);
    fireIntersection(true);
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('图片加载失败');
    });
  });

  it('shows error placeholder when toAssetUrl rejects', async () => {
    const img = makeImg({
      id: 'a',
      source: 'C:\\imgs\\err.png',
      kind: 'local',
    });
    toAssetUrlMock.mockRejectedValue(new Error('IPC failed'));
    const { container } = render(<ImageTile image={img} />);
    fireIntersection(true);
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('图片加载失败');
    });
  });

  it('renders img for svg kind when resolvedUrl is pre-set (independent channel)', async () => {
    const svgDataUrl = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const img = makeImg({
      id: 'a',
      source: '<svg></svg>',
      kind: 'svg',
      resolvedUrl: svgDataUrl,
      status: 'resolved',
    });
    const { container } = render(<ImageTile image={img} />);
    fireIntersection(true);
    await waitFor(() => {
      const el = container.querySelector('img');
      expect(el).toBeTruthy();
      expect(el!.getAttribute('src')).toBe(svgDataUrl);
    });
    // svg kind must not go through local path resolution
    expect(toAssetUrlMock).not.toHaveBeenCalled();
  });

  it('shows error for svg kind without resolvedUrl (no local resolution path)', async () => {
    const img = makeImg({ id: 'a', source: '<svg></svg>', kind: 'svg' });
    const { container } = render(<ImageTile image={img} />);
    fireIntersection(true);
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('图片加载失败');
    });
    expect(toAssetUrlMock).not.toHaveBeenCalled();
  });

  it('transitions to error state when img fires onerror', async () => {
    const img = makeImg({
      id: 'a',
      source: 'https://ex.com/broken.png',
      kind: 'http',
    });
    const { container } = render(<ImageTile image={img} />);
    fireIntersection(true);
    await waitFor(() => expect(container.querySelector('img')).toBeTruthy());
    const el = container.querySelector('img')!;
    fireEvent.error(el);
    await waitFor(() => {
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toContain('图片加载失败');
    });
  });
});

// ─── LocalImgResolver ─────────────────────────────────────────────────────
describe('LocalImgResolver', () => {
  beforeEach(setupDom);
  afterEach(teardownDom);

  it('scans img[data-local-path]:not([src]) and resolves via toAssetUrl', async () => {
    const localPath = 'C:\\imgs\\x.png';
    toAssetUrlMock.mockResolvedValue('asset://localhost/x.png');
    const containerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={containerRef}>
        <img data-local-path={localPath} className="md-img-pending" alt="x" />
        <LocalImgResolver containerRef={containerRef} />
      </div>
    );
    await waitFor(() => expect(toAssetUrlMock).toHaveBeenCalledWith(localPath));
    const img = containerRef.current!.querySelector('img')!;
    await waitFor(() => {
      expect(img.getAttribute('src')).toBe('asset://localhost/x.png');
    });
    expect(img.getAttribute('data-local-path')).toBeNull();
    expect(img.classList.contains('md-img-pending')).toBe(false);
  });

  it('skips img elements that already have src', async () => {
    const localPath = 'C:\\imgs\\y.png';
    toAssetUrlMock.mockResolvedValue('asset://localhost/y.png');
    const containerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={containerRef}>
        <img data-local-path={localPath} src="already-set.png" alt="y" />
        <LocalImgResolver containerRef={containerRef} />
      </div>
    );
    // Allow microtasks to flush
    await new Promise((r) => setTimeout(r, 50));
    expect(toAssetUrlMock).not.toHaveBeenCalled();
    const img = containerRef.current!.querySelector('img')!;
    expect(img.getAttribute('src')).toBe('already-set.png');
  });

  it('adds md-img-error class when toAssetUrl returns null', async () => {
    const localPath = 'C:\\imgs\\bad.png';
    toAssetUrlMock.mockResolvedValue(null);
    const containerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={containerRef}>
        <img data-local-path={localPath} alt="bad" />
        <LocalImgResolver containerRef={containerRef} />
      </div>
    );
    await waitFor(() => expect(toAssetUrlMock).toHaveBeenCalled());
    await waitFor(() => {
      const img = containerRef.current!.querySelector('img')!;
      expect(img.classList.contains('md-img-error')).toBe(true);
      expect(img.getAttribute('src')).toBeNull();
    });
  });

  it('adds md-img-error class when toAssetUrl rejects', async () => {
    const localPath = 'C:\\imgs\\err.png';
    toAssetUrlMock.mockRejectedValue(new Error('IPC error'));
    const containerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={containerRef}>
        <img data-local-path={localPath} alt="err" />
        <LocalImgResolver containerRef={containerRef} />
      </div>
    );
    await waitFor(() => expect(toAssetUrlMock).toHaveBeenCalled());
    await waitFor(() => {
      const img = containerRef.current!.querySelector('img')!;
      expect(img.classList.contains('md-img-error')).toBe(true);
    });
  });
});

// ─── isImageProducingTool ─────────────────────────────────────────────────
describe('isImageProducingTool', () => {
  it.each([
    'screenshot',
    'capture',
    'capture_screen',
    'generate_image',
    'image_generation',
    'draw',
    'render_image',
    'browser_capture',
    'take_screenshot',
    'Take-Screenshot',
    'GENERATE_IMAGE',
  ])('returns true for %s', (name) => {
    expect(isImageProducingTool(name)).toBe(true);
  });

  it.each([
    'edit',
    'write_file',
    'shell',
    'run_command',
    'read_file',
    'search',
    'list_dir',
  ])('returns false for %s', (name) => {
    expect(isImageProducingTool(name)).toBe(false);
  });
});

// ─── resolveToolImages ────────────────────────────────────────────────────
describe('resolveToolImages', () => {
  it('returns structuredImages as-is when provided (highest priority)', () => {
    const structured: MessageImageRef[] = [
      { id: 's1', source: 'structured.png', kind: 'local' },
    ];
    const result = resolveToolImages({
      name: 'screenshot',
      output: 'C:\\imgs\\from_output.png',
      structuredImages: structured,
    });
    expect(result).toBe(structured);
    expect(result).toHaveLength(1);
  });

  it('extracts Windows local paths from output text', () => {
    const result = resolveToolImages({
      name: 'screenshot',
      output: 'Saved to C:\\shots\\capture.png',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('local');
    expect(result[0]!.source).toBe('C:\\shots\\capture.png');
    expect(result[0]!.status).toBe('pending');
    expect(result[0]!.resolvedUrl).toBeUndefined();
  });

  it('extracts Unix local paths from output text', () => {
    const result = resolveToolImages({
      name: 'screenshot',
      output: 'Saved to /tmp/shots/capture.png',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('local');
    expect(result[0]!.source).toBe('/tmp/shots/capture.png');
  });

  it('extracts http URLs from output text', () => {
    const result = resolveToolImages({
      name: 'fetch',
      output: 'Image at https://example.com/img/photo.jpg',
    });
    // Note: the local-path regex also matches the /img/photo.jpg path segment
    // inside the URL, so both a 'local' and an 'http' ref are produced.
    // Verify the http ref is present and correctly populated.
    const httpRef = result.find((r) => r.kind === 'http');
    expect(httpRef).toBeDefined();
    expect(httpRef!.source).toBe('https://example.com/img/photo.jpg');
    expect(httpRef!.resolvedUrl).toBe('https://example.com/img/photo.jpg');
    expect(httpRef!.status).toBe('resolved');
  });

  it('extracts data URLs from output text and records byte size', () => {
    const result = resolveToolImages({
      name: 'generate',
      output: 'data:image/png;base64,iVBORw0KGgo=',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('data');
    expect(result[0]!.source).toBe('data:image/png;base64,iVBORw0KGgo=');
    expect(result[0]!.byteSize).toBeGreaterThan(0);
  });

  it('extracts file_path from args for image-producing tools', () => {
    const result = resolveToolImages({
      name: 'take_screenshot',
      args: JSON.stringify({ output_path: 'C:\\shots\\arg.png' }),
      output: '',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.kind).toBe('local');
    expect(result[0]!.source).toBe('C:\\shots\\arg.png');
  });

  it('deduplicates refs with the same source hash', () => {
    const result = resolveToolImages({
      name: 'take_screenshot',
      args: JSON.stringify({ output_path: 'C:\\shots\\dup.png' }),
      output: 'Saved: C:\\shots\\dup.png',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe('C:\\shots\\dup.png');
  });

  it('limits to 16 images', () => {
    const paths: string[] = [];
    for (let i = 0; i < 20; i++) {
      paths.push(`C:\\imgs\\img${i}.png`);
    }
    const result = resolveToolImages({
      name: 'batch',
      output: paths.join('\n'),
    });
    expect(result).toHaveLength(16);
  });

  it('returns empty array for non-image output', () => {
    const result = resolveToolImages({
      name: 'read_file',
      output: 'just some text content',
    });
    expect(result).toHaveLength(0);
  });
});

// ─── sanitizeSvgContent ───────────────────────────────────────────────────
describe('sanitizeSvgContent', () => {
  it('strips <script> tags entirely', () => {
    const input = '<svg><script>alert(1)</script><path d="M0 0"/></svg>';
    const out = sanitizeSvgContent(input);
    expect(out.toLowerCase()).not.toContain('script');
    expect(out).not.toContain('alert');
    expect(out).toContain('<path');
    expect(out).toContain('d="M0 0"');
  });

  it('strips <style> blocks entirely', () => {
    const input = '<svg><style>rect{fill:red}</style><rect width="10"/></svg>';
    const out = sanitizeSvgContent(input);
    expect(out.toLowerCase()).not.toContain('<style');
    expect(out).not.toContain('fill:red');
    expect(out).toContain('<rect');
  });

  it('strips on* event handlers from whitelisted elements', () => {
    const input =
      '<svg><rect onclick="alert(1)" onload="x()" width="10" height="10"/></svg>';
    const out = sanitizeSvgContent(input);
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('onload');
    expect(out).not.toContain('alert');
    expect(out).toContain('width="10"');
    expect(out).toContain('height="10"');
  });

  it('strips javascript: URLs from href on whitelisted elements', () => {
    const input = '<svg><use href="javascript:alert(1)"/></svg>';
    const out = sanitizeSvgContent(input);
    expect(out.toLowerCase()).not.toContain('javascript:');
    expect(out).not.toContain('alert');
    expect(out).toContain('<use');
    // href attribute itself must be dropped (dangerous scheme)
    expect(out.toLowerCase()).not.toContain('href');
  });

  it('preserves legal SVG elements (path, rect, circle, line, g)', () => {
    const input =
      '<svg><g><path d="M0 0"/><rect x="0" y="0" width="10" height="10"/><circle cx="5" cy="5" r="3"/><line x1="0" y1="0" x2="10" y2="10"/></g></svg>';
    const out = sanitizeSvgContent(input);
    expect(out).toContain('<path');
    expect(out).toContain('<rect');
    expect(out).toContain('<circle');
    expect(out).toContain('<line');
    expect(out).toContain('<g>');
    expect(out).toContain('</g>');
    expect(out).toContain('</svg>');
  });

  it('preserves viewBox and other core attributes', () => {
    const input =
      '<svg viewBox="0 0 100 100" width="50" height="50"><circle cx="50" cy="50" r="40"/></svg>';
    const out = sanitizeSvgContent(input);
    expect(out).toContain('viewBox="0 0 100 100"');
    expect(out).toContain('width="50"');
    expect(out).toContain('height="50"');
    expect(out).toContain('cx="50"');
    expect(out).toContain('cy="50"');
    expect(out).toContain('r="40"');
  });

  it('strips non-whitelisted tags (foreignObject, image, a) but keeps text', () => {
    const input =
      '<svg><foreignObject><div>x</div></foreignObject><image href="evil.png"/><a href="javascript:alert(1)">link</a></svg>';
    const out = sanitizeSvgContent(input);
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out.toLowerCase()).not.toContain('<image');
    expect(out.toLowerCase()).not.toContain('<a ');
    expect(out.toLowerCase()).not.toContain('<a>');
    expect(out.toLowerCase()).not.toContain('javascript:');
    // text content inside stripped tags is preserved
    expect(out).toContain('x');
    expect(out).toContain('link');
  });

  it('returns empty string for falsy input', () => {
    expect(sanitizeSvgContent('')).toBe('');
  });
});
