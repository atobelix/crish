// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import {
  AttachmentCard,
  formatAttachmentSize,
  getFileKindBadge,
  isImageAttachmentItem,
  resolveCardImageSrc,
  normalizeMessageAttachments,
} from '../AttachmentCard';
import styles from '../AttachmentCard.module.css';

// Mock Tauri convertFileSrc
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: vi.fn((filePath: string) => `asset://${filePath}`),
}));

// Mock workspaceFsApi
vi.mock('../../../api/workspaceFsApi', () => ({
  isAbsoluteFsPath: (p: string) => p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p),
  resolveWorkspacePath: (p: string) =>
    p.startsWith('/') || /^[a-zA-Z]:[/\\]/.test(p) ? p : `/mock-workspace/${p}`,
  getWorkspacePath: () => '/mock-workspace',
  registerFileViewerOpener: vi.fn(),
}));

describe('AttachmentCard 组件规范套件', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  describe('1. 图片正常加载与 58×58 渲染模式', () => {
    it('图片正常加载时渲染 58×58 卡片，包含 img 标签且不包含 ImageOff 失效图标', () => {
      const item = {
        name: 'screenshot.png',
        path: 'c:/Software/conex/screenshot.png',
        isImage: true,
      };

      const { container } = render(<AttachmentCard item={item} />);

      // 验证卡片包含 58 尺寸标识
      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card).not.toBeNull();
      expect(card?.className).toContain(styles.cardImageMode);

      // 验证渲染了正常 <img> 标签
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('asset://c:/Software/conex/screenshot.png');
      expect(img?.getAttribute('alt')).toBe('screenshot.png');

      // 验证不包含失效状态
      expect(container.textContent).not.toContain('失效');
      expect(container.querySelector(`.${styles.missingCard}`)).toBeNull();
    });

    it('基于 dataUrl 渲染图片正常微缩卡片', () => {
      const item = {
        name: 'data-preview.jpg',
        dataUrl: 'data:image/jpeg;base64,mockbinarydata...',
        isImage: true,
      };

      const { container } = render(<AttachmentCard item={item} />);
      const img = container.querySelector('img');
      expect(img).not.toBeNull();
      expect(img?.getAttribute('src')).toBe('data:image/jpeg;base64,mockbinarydata...');
    });
  });

  describe('2. 图片失效降级态（根除原生破图）', () => {
    it('图片 onError 触发后切换为 ImageOff 优雅缺失态，断言 DOM 中不再存在 img 标签', () => {
      const item = {
        name: 'deleted_image.png',
        path: 'c:/Software/conex/deleted_image.png',
        isImage: true,
      };

      const { container } = render(<AttachmentCard item={item} />);

      // 初始渲染有 img 标签
      const img = container.querySelector('img');
      expect(img).not.toBeNull();

      // 模拟物理文件丢失/损坏触发 onError
      fireEvent.error(img!);

      // 核心断言：绝对不渲染原生 <img> 标签（彻底杜绝浏览器破裂图标与丑陋 alt）
      expect(container.querySelector('img')).toBeNull();

      // 核心断言：渲染优雅缺失态卡片与“失效”微型提示
      expect(container.querySelector(`.${styles.missingCard}`)).not.toBeNull();
      expect(container.textContent).toContain('失效');

      // 验证卡片 aria-label 或 Tooltip 反映失效
      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card?.getAttribute('aria-label')).toContain('附件失效');
    });

    it('图片源为空或明确标记 missing/error 时直接渲染优雅缺失态，绝不渲染 img 标签', () => {
      const itemMissing = {
        name: 'empty_src.png',
        path: '',
        isImage: true,
      };

      const { container } = render(<AttachmentCard item={itemMissing} />);

      // 绝不渲染 img 标签
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector(`.${styles.missingCard}`)).not.toBeNull();
      expect(container.textContent).toContain('失效');
    });

    it('图片对象携带 missing: true 时直接进入缺失态', () => {
      const item = {
        name: 'lost.png',
        path: 'c:/images/lost.png',
        isImage: true,
        missing: true,
      };

      const { container } = render(<AttachmentCard item={item} />);
      expect(container.querySelector('img')).toBeNull();
      expect(container.querySelector(`.${styles.missingCard}`)).not.toBeNull();
      expect(container.textContent).toContain('失效');
    });
  });

  describe('3. 文档模式两行排版与文件名可见性（核心修复）', () => {
    it('文档模式下渲染两行布局并能完整看到文件名文本及类型大小元信息', () => {
      const item = {
        name: 'database_migration_v2.sql',
        path: 'c:/Software/conex/database_migration_v2.sql',
        size: 15 * 1024, // 15 KB
      };

      const { container } = render(<AttachmentCard item={item} />);

      // 验证横向微卡片容器
      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card).not.toBeNull();
      expect(card?.className).toContain(styles.fileCardHorizontal);

      // 第一行：完整文件名文本清晰可见
      const fileNameEl = screen.getByText('database_migration_v2.sql');
      expect(fileNameEl).not.toBeNull();
      expect(fileNameEl.className).toContain(styles.fileNameText);

      // 第二行：类型徽标与大小元信息
      expect(container.textContent).toContain('SQL');
      expect(container.textContent).toContain('15.0 KB');

      // 左侧 28×28 图标区存在
      const iconBox = container.querySelector(`.${styles.fileIconBox}`);
      expect(iconBox).not.toBeNull();

      // 文档模式绝不包含 <img> 标签
      expect(container.querySelector('img')).toBeNull();
    });

    it('当文档未显式提供 name 时，自动从 path 解析文件名并展示', () => {
      const item = {
        path: 'c:/Software/conex/configs/app_settings.yaml',
        size: 2048,
      };

      const { container } = render(<AttachmentCard item={item} />);
      expect(screen.getByText('app_settings.yaml')).not.toBeNull();
      expect(container.textContent).toContain('YAML');
      expect(container.textContent).toContain('2.0 KB');
    });

    it('文档模式标记为 missing/error 时应用删除线与失效样式', () => {
      const item = {
        name: 'removed_spec.pdf',
        path: 'c:/docs/removed_spec.pdf',
        missing: true,
      };

      const { container } = render(<AttachmentCard item={item} />);
      const fileNameEl = screen.getByText('removed_spec.pdf');
      expect(fileNameEl).not.toBeNull();
      expect(fileNameEl.className).toContain(styles.fileNameMissing);

      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card?.className).toContain(styles.missingCard);
    });
  });

  describe('4. 点击与交互事件隔离（冒泡拦截）', () => {
    it('点击卡片触发 onClick 并严格阻断事件冒泡', () => {
      const onParentClick = vi.fn();
      const onCardClick = vi.fn();
      const item = {
        name: 'notes.md',
        path: 'c:/Software/conex/notes.md',
      };

      const { container } = render(
        <div onClick={onParentClick} data-testid="parent-wrapper">
          <AttachmentCard item={item} onClick={onCardClick} />
        </div>
      );

      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card).not.toBeNull();

      fireEvent.click(card!);

      expect(onCardClick).toHaveBeenCalledTimes(1);
      expect(onCardClick).toHaveBeenCalledWith(item);
      // 核心断言：父级绝对没有收到冒泡事件
      expect(onParentClick).not.toHaveBeenCalled();
    });

    it('键盘回车与空格键触发 onClick 并严格阻断冒泡与默认行为', () => {
      const onParentClick = vi.fn();
      const onCardClick = vi.fn();
      const item = {
        name: 'design.fig',
        path: 'c:/design.fig',
      };

      const { container } = render(
        <div onClick={onParentClick}>
          <AttachmentCard item={item} onClick={onCardClick} />
        </div>
      );

      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card).not.toBeNull();

      // Enter 键
      fireEvent.keyDown(card!, { key: 'Enter' });
      expect(onCardClick).toHaveBeenCalledTimes(1);
      expect(onParentClick).not.toHaveBeenCalled();

      // Space 键
      fireEvent.keyDown(card!, { key: ' ' });
      expect(onCardClick).toHaveBeenCalledTimes(2);
      expect(onParentClick).not.toHaveBeenCalled();
    });
  });

  describe('5. AGENTS.md §12 全自定义 Tooltip 守门断言', () => {
    it('卡片及其所有子元素严禁包含原生 title 属性', () => {
      const item = {
        name: 'contract.ts',
        path: 'c:/Software/conex/contract.ts',
      };

      const { container } = render(<AttachmentCard item={item} />);
      const card = container.querySelector('[data-testid="attachment-card-58"]');
      expect(card).not.toBeNull();
      expect(card?.getAttribute('title')).toBeNull();

      const cardChildren = card?.querySelectorAll('*') || [];
      cardChildren.forEach((el) => {
        expect(el.getAttribute('title')).toBeNull();
      });
    });
  });

  describe('6. resolveCardImageSrc 无工作区拦截规则', () => {
    it('对任意绝对路径直接调用 convertFileSrc，无 assertWorkspacePath 拦截抛错', () => {
      const winPath = 'C:\\Users\\User\\Pictures\\avatar.png';
      const posixPath = '/var/data/uploads/chart.webp';

      expect(resolveCardImageSrc({ path: winPath })).toBe(
        `asset://${winPath.replace(/\\/g, '/')}`
      );
      expect(resolveCardImageSrc({ path: posixPath })).toBe(`asset://${posixPath}`);
    });

    it('直接返回 dataUrl 与网络协议路径', () => {
      const dataUrl = 'data:image/png;base64,iVBORw...';
      const httpUrl = 'https://example.com/logo.svg';

      expect(resolveCardImageSrc({ dataUrl })).toBe(dataUrl);
      expect(resolveCardImageSrc({ path: httpUrl })).toBe(httpUrl);
    });

    it('拦截虚拟 content: hash 线索，严禁向 img.src 传递伪协议（防止原生破图）', () => {
      expect(resolveCardImageSrc({ path: 'content:abc12345:1024' })).toBe('');
      // 若携带真实 dataUrl，则优先返回真实 dataUrl
      expect(
        resolveCardImageSrc({
          path: 'content:abc12345:1024',
          dataUrl: 'data:image/png;base64,realdata',
        })
      ).toBe('data:image/png;base64,realdata');
    });

    it('相对路径自动解析工作区路径并转为 asset:// 协议', () => {
      expect(resolveCardImageSrc({ path: 'images/logo.png' })).toBe(
        'asset:///mock-workspace/images/logo.png'
      );
    });
  });

  describe('7. 辅助计算函数', () => {
    it('formatAttachmentSize 正确格式化字节大小', () => {
      expect(formatAttachmentSize(undefined)).toBe('');
      expect(formatAttachmentSize(0)).toBe('');
      expect(formatAttachmentSize(500)).toBe('500 B');
      expect(formatAttachmentSize(1024)).toBe('1.0 KB');
      expect(formatAttachmentSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
      expect(formatAttachmentSize(3.2 * 1024 * 1024 * 1024)).toBe('3.2 GB');
    });

    it('isImageAttachmentItem 与 getFileKindBadge 准确定位类型', () => {
      expect(isImageAttachmentItem({ name: 'photo.jpg' })).toBe(true);
      expect(isImageAttachmentItem({ mime: 'image/webp' })).toBe(true);
      expect(isImageAttachmentItem({ name: 'code.rs' })).toBe(false);
      expect(isImageAttachmentItem({ name: 'test.png', isImage: false })).toBe(false);

      expect(getFileKindBadge('document.pdf')).toBe('PDF');
      expect(getFileKindBadge('styles.css')).toBe('CSS');
      expect(getFileKindBadge('unknown_long_extension.somethingverylong')).toBe('FILE');
    });

    it('normalizeMessageAttachments 附件优先并融合图片', () => {
      const items = normalizeMessageAttachments(
        [{ name: 'query.sql', path: '/src/query.sql' }],
        [{ id: 'img-1', source: '/src/chart.png', alt: '图表' }]
      );
      expect(items.length).toBe(2);
      expect(items[0].name).toBe('query.sql');
      expect(items[1].name).toBe('图表');
      expect(items[1].isImage).toBe(true);
    });

    it('同名图片附件自动关联 images 中的 resolvedUrl，避免图片数据丢失', () => {
      const items = normalizeMessageAttachments(
        [{ name: 'photo.png', path: 'C:/Pictures/photo.png' }],
        [
          {
            id: 'img-photo',
            source: 'C:/Pictures/photo.png',
            resolvedUrl: 'data:image/png;base64,preservedThumbnail',
          },
        ]
      );
      expect(items.length).toBe(1);
      expect(items[0].name).toBe('photo.png');
      expect(items[0].dataUrl).toBe('data:image/png;base64,preservedThumbnail');
      expect(items[0].isImage).toBe(true);
    });
  });
});
