/**
 * presentationMode · SD-04 内容宿主互斥（反三宿主）
 *
 * 验收：
 * ① 产品默认路径不会同时出现 content-row 全量 + paper-list 内容块（除非 debug-dual）
 * ② 解析表钉死；兼容 keepReactRows
 * ③ chrome 槽不参与内容互斥（本文件只测模式解析）
 *
 * ≠ EL-01；≠ 关 PaperList 结构门。
 */
import { describe, expect, it } from 'vitest';
import {
  isPresentationMode,
  isProductContentHostExclusive,
  PRESENTATION_MODES,
  resolvePresentationMode,
  showPaperListContent,
  showReactContentRows,
  type PresentationMode,
} from './presentationMode';

describe('presentationMode · SD-04 解析', () => {
  it('sd04_default_no_paper_list_is_react_rows', () => {
    expect(resolvePresentationMode({ paperListEnabled: false })).toBe(
      'react-rows'
    );
    expect(
      resolvePresentationMode({ paperListEnabled: false, keepReactRows: true })
    ).toBe('react-rows');
  });

  it('sd04_product_paper_list_default_exclusive', () => {
    // 点名 paperList 且未显式 dual → 产品默认 paper-list（互斥 content-row）
    expect(resolvePresentationMode({ paperListEnabled: true })).toBe(
      'paper-list'
    );
    expect(
      resolvePresentationMode({
        paperListEnabled: true,
        keepReactRows: false,
      })
    ).toBe('paper-list');
  });

  it('sd04_debug_dual_only_when_explicit', () => {
    expect(
      resolvePresentationMode({
        paperListEnabled: true,
        presentationMode: 'debug-dual',
      })
    ).toBe('debug-dual');
    // 兼容旧 keepReactRows:true → debug-dual（非产品默认）
    expect(
      resolvePresentationMode({
        paperListEnabled: true,
        keepReactRows: true,
      })
    ).toBe('debug-dual');
  });

  it('sd04_explicit_mode_wins_over_keepReactRows', () => {
    expect(
      resolvePresentationMode({
        paperListEnabled: true,
        presentationMode: 'paper-list',
        keepReactRows: true,
      })
    ).toBe('paper-list');
  });

  it('sd04_paper_list_mode_without_mount_falls_back_to_react_rows', () => {
    // 无列表槽却声明 paper-list / debug-dual → 诚实回落
    expect(
      resolvePresentationMode({
        paperListEnabled: false,
        presentationMode: 'paper-list',
      })
    ).toBe('react-rows');
    expect(
      resolvePresentationMode({
        paperListEnabled: false,
        presentationMode: 'debug-dual',
      })
    ).toBe('react-rows');
  });

  it('sd04_show_flags_match_mode_matrix', () => {
    const matrix: Record<
      PresentationMode,
      { rows: boolean; list: boolean; exclusive: boolean }
    > = {
      'react-rows': { rows: true, list: false, exclusive: true },
      'paper-list': { rows: false, list: true, exclusive: true },
      'debug-dual': { rows: true, list: true, exclusive: false },
    };
    for (const mode of PRESENTATION_MODES) {
      expect(showReactContentRows(mode)).toBe(matrix[mode].rows);
      expect(showPaperListContent(mode)).toBe(matrix[mode].list);
      expect(isProductContentHostExclusive(mode)).toBe(matrix[mode].exclusive);
    }
  });

  it('sd04_isPresentationMode_guard', () => {
    expect(isPresentationMode('react-rows')).toBe(true);
    expect(isPresentationMode('paper-list')).toBe(true);
    expect(isPresentationMode('debug-dual')).toBe(true);
    expect(isPresentationMode('dual')).toBe(false);
    expect(isPresentationMode(null)).toBe(false);
  });
});
