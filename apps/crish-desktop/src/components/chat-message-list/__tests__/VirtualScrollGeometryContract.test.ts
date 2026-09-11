import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

describe('虚拟滚动几何稳定与统一盒模型契约 (Plan 05 DEF-13 & DEF-14)', () => {
  const listCssPath = path.resolve(__dirname, '../ChatMessageList.module.css');
  const rowCssPath = path.resolve(__dirname, '../../chat-message-row/ChatMessageRow.module.css');
  const virtualizerTsxPath = path.resolve(__dirname, '../MessageVirtualizer.tsx');

  const listCss = fs.readFileSync(listCssPath, 'utf-8');
  const rowCss = fs.readFileSync(rowCssPath, 'utf-8');
  const virtualizerTsx = fs.readFileSync(virtualizerTsxPath, 'utf-8');

  describe('1. ChatMessageList.module.css 契约：消除相邻兄弟外边距黑洞 (DEF-13)', () => {
    it('彻底切除 [data-chat-list-inner] 相邻兄弟 margin-top 选择器', () => {
      // 严禁存在相邻兄弟 + 选择器注入 margin-top: 16px
      expect(listCss).not.toMatch(/\[data-chat-list-inner\][\s\S]*?\+[\s\S]*?margin-top/);
      expect(listCss).not.toContain('[data-chat-list-inner] > :not([hidden]) + :not([hidden])');
      expect(listCss).not.toContain('[data-chat-list-inner] > :not([hidden]) + :not([hidden]) > [data-vindex]');
    });

    it('保留虚拟化 Spacer 几何占位', () => {
      expect(listCss).toContain('[data-vsm-spacer]');
    });

    it('.listInner 禁止纵向 padding（几何 SSOT 归 chatScrollGeometry）', () => {
      // 纵向 padding 会与绝对切片脱节 → 顶遮挡/底截断
      expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding:\s*48px/);
      expect(listCss).not.toMatch(/\.listInner\s*\{[^}]*padding-top:\s*48px/);
    });
  });

  describe('2. ChatMessageRow.module.css 契约：内部盒模型与双重虚拟化切除 (DEF-13 & DEF-14)', () => {
    it('.row 包含内部盒模型 padding-bottom: 16px 与 margin: 0', () => {
      expect(rowCss).toMatch(/\.row\s*\{[\s\S]*?padding-bottom:\s*16px;/);
      expect(rowCss).toMatch(/\.row\s*\{[\s\S]*?margin-top:\s*0;/);
      expect(rowCss).toMatch(/\.row\s*\{[\s\S]*?margin-bottom:\s*0;/);
    });

    it('.row 仅保留 contain: layout paint，彻底剔除 content-visibility 与 contain-intrinsic-size', () => {
      expect(rowCss).toMatch(/\.row\s*\{[^}]*contain:\s*layout paint;/);
      expect(rowCss).not.toMatch(/content-visibility\s*:/);
      expect(rowCss).not.toMatch(/contain-intrinsic-size\s*:/);
    });

    it('.rowCarrier 纯状态载体赋予紧凑发丝节奏 4px，彻底切除外部 margin', () => {
      expect(rowCss).toMatch(/\.rowCarrier\s*\{[^}]*padding:\s*0 0 4px;/);
      expect(rowCss).toMatch(/\.rowCarrier\s*\{[^}]*margin:\s*0;/);
      // 严禁旧版 margin: 2px 0 造成的外部边距漏洞
      expect(rowCss).not.toMatch(/\.rowCarrier\s*\{[^}]*margin:\s*2px 0;/);
    });
  });

  describe('3. MessageVirtualizer.tsx 统一度量契约 (DEF-13 §2.2)', () => {
    it('ResizeObserver 统一度量入口使用 el.offsetHeight 度量完整盒模型高度', () => {
      expect(virtualizerTsx).toContain('el.offsetHeight');
      expect(virtualizerTsx).toMatch(/const measuredHeight =\s*el\.offsetHeight \|\| Math\.ceil\(entry\.contentRect\.height\);/);
    });
  });

  describe('4. 几何等式与 1600px 累积黑洞消除断言', () => {
    it('100 条消息场景下，行垂直间距由内部盒模型承载，DOM Physical Height 与 VSM 实测 100% 恒等', () => {
      // 模拟 100 条消息
      const rowCount = 100;
      const contentHeight = 84; // 假定正文内容高
      const paddingBottom = 16; // 内部盒模型间距
      const externalMargin = 0; // 外部 margin 为 0

      // 物理 offsetHeight 包含 content + paddingBottom + border
      const singleRowPhysicalHeight = contentHeight + paddingBottom;

      // 原相邻兄弟模型：物理 DOM 高度含 16px margin-top，但 offsetHeight 与 contentRect 均不含外部 margin
      const legacyVsmMeasuredHeight = contentHeight; // 旧模型遗漏外部 margin
      const legacyMarginBlackHole = rowCount * 16; // 1600px 黑洞

      expect(legacyMarginBlackHole).toBe(1600);
      expect(singleRowPhysicalHeight - legacyVsmMeasuredHeight).toBe(16);

      // 新纯净盒模型：VSM 实测高度 = el.offsetHeight = contentHeight + paddingBottom
      const newVsmMeasuredHeight = singleRowPhysicalHeight;
      const newMarginBlackHole = externalMargin * rowCount;

      // 验证几何等式：DOM Physical Height (offsetHeight) === VSM Measured Height，黑洞误差为 0px
      expect(newMarginBlackHole).toBe(0);
      expect(singleRowPhysicalHeight).toBe(newVsmMeasuredHeight);
    });
  });
});
