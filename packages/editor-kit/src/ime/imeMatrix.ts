/**
 * IME 端×断言矩阵常量（M3 / Round8）。
 *
 * 权威文档：`docs/block-workspace-architecture/plans/specs/ime-matrix.md`
 *
 * 状态语义：
 * - `open` → 文档表 `☐`
 * - `automated` → `🟨自动化`（纯逻辑/契约；不替代 WebView e2e）
 * - `e2e` → `✅e2e`（目标端 WebView 已绿；W6-B）
 *
 * 关闭「叶子核=PM」仅认必测格 `e2e`，见矩阵 L2/L3。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 断言 ID（D7 A-IME-01…08） */
export type ImeMatrixAssertId =
  | 'A-IME-01'
  | 'A-IME-02'
  | 'A-IME-03'
  | 'A-IME-04'
  | 'A-IME-05'
  | 'A-IME-06'
  | 'A-IME-07'
  | 'A-IME-08';

/** 目标端 */
export type ImeMatrixPlatform = 'win_webview2' | 'macos_wk' | 'linux_webkit';

/** 发布前要求强度 */
export type ImeMatrixRequirement = '必测' | '抽样';

/**
 * 单元格覆盖状态。
 * - open：未覆盖
 * - automated：契约/单测语义子集已绿
 * - e2e：目标 WebView e2e 已绿
 */
export type ImeMatrixCellStatus = 'open' | 'automated' | 'e2e';

/** 文档表显示符号 */
export type ImeMatrixStatusGlyph = '☐' | '🟨自动化' | '✅e2e';

/** 单格 */
export type ImeMatrixCell = {
  /** 断言 ID */
  id: ImeMatrixAssertId;
  /** 端 */
  platform: ImeMatrixPlatform;
  /** 必测 / 抽样 */
  requirement: ImeMatrixRequirement;
  /** 覆盖状态 */
  status: ImeMatrixCellStatus;
  /** 一句话断言摘要 */
  title: string;
  /**
   * 自动化映射（测试文件或 describe 名）；e2e 前可空。
   * 契约层引用 A-IME-0x 时写此处，便于矩阵与测试互查。
   */
  automationRefs?: readonly string[];
};

// ---------------------------------------------------------------------------
// 图例 / 工具
// ---------------------------------------------------------------------------

export const IME_MATRIX_STATUS_GLYPH: Record<
  ImeMatrixCellStatus,
  ImeMatrixStatusGlyph
> = {
  open: '☐',
  automated: '🟨自动化',
  e2e: '✅e2e',
};

export function imeMatrixStatusGlyph(
  status: ImeMatrixCellStatus
): ImeMatrixStatusGlyph {
  return IME_MATRIX_STATUS_GLYPH[status];
}

// ---------------------------------------------------------------------------
// 断言元数据（端无关）
// ---------------------------------------------------------------------------

export const IME_MATRIX_ASSERTS: ReadonlyArray<{
  id: ImeMatrixAssertId;
  title: string;
  /** 各端要求；缺省按 win/mac 必测、linux 抽样的常见默认，显式表为准 */
  requirementByPlatform: Record<ImeMatrixPlatform, ImeMatrixRequirement>;
}> = [
  {
    id: 'A-IME-01',
    title: '长句合成不丢字',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '必测',
    },
  },
  {
    id: 'A-IME-02',
    title: '合成中无 slash/结构键',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '必测',
    },
  },
  {
    id: 'A-IME-03',
    title: '合成中滚动 pin',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '抽样',
    },
  },
  {
    id: 'A-IME-04',
    title: '点另一块策略',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '抽样',
    },
  },
  {
    id: 'A-IME-05',
    title: '合成=一步撤销',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '抽样',
    },
  },
  {
    id: 'A-IME-06',
    title: '合成中远端/Agent',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '抽样',
      linux_webkit: '抽样',
    },
  },
  {
    id: 'A-IME-07',
    title: 'fullRemount=0',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '必测',
    },
  },
  {
    id: 'A-IME-08',
    title: '合成后 `# ` 转标题',
    requirementByPlatform: {
      win_webview2: '必测',
      macos_wk: '必测',
      linux_webkit: '抽样',
    },
  },
];

const PLATFORMS: readonly ImeMatrixPlatform[] = [
  'win_webview2',
  'macos_wk',
  'linux_webkit',
];

/** Round8：仅 A-IME-01 / A-IME-02 标 automated（三端共享语义） */
const AUTOMATED_IDS: ReadonlySet<ImeMatrixAssertId> = new Set([
  'A-IME-01',
  'A-IME-02',
]);

const AUTOMATION_REFS: Partial<Record<ImeMatrixAssertId, readonly string[]>> = {
  'A-IME-01': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-01 长句合成不丢字 / value 优先 / end 后 idle',
  ],
  'A-IME-02': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-02 合成中结构键与 slash 拒绝 / end 后放行',
    'packages/block-paper/src/chrome/chrome.asil.test.ts',
    'packages/block-paper/src/chrome/chrome.w3f.test.ts',
  ],
};

/**
 * 全矩阵单元格（8 断言 × 3 端 = 24 格）。
 * 状态以本常量为程序可读真相；文档表须与之一致。
 */
export const IME_MATRIX_CELLS: readonly ImeMatrixCell[] =
  IME_MATRIX_ASSERTS.flatMap((assert) =>
    PLATFORMS.map((platform): ImeMatrixCell => {
      const status: ImeMatrixCellStatus = AUTOMATED_IDS.has(assert.id)
        ? 'automated'
        : 'open';
      const cell: ImeMatrixCell = {
        id: assert.id,
        platform,
        requirement: assert.requirementByPlatform[platform],
        status,
        title: assert.title,
      };
      const refs = AUTOMATION_REFS[assert.id];
      if (refs) {
        cell.automationRefs = refs;
      }
      return cell;
    })
  );

/** 按断言 ID 取三端单元格 */
export function imeMatrixCellsFor(
  id: ImeMatrixAssertId
): readonly ImeMatrixCell[] {
  return IME_MATRIX_CELLS.filter((c) => c.id === id);
}

/** 必测且仍未 e2e 的格（L2 未关闭清单） */
export function imeMatrixOpenRequiredCells(): readonly ImeMatrixCell[] {
  return IME_MATRIX_CELLS.filter(
    (c) => c.requirement === '必测' && c.status !== 'e2e'
  );
}

/** L0/L1：矩阵成型 + 语义子集是否就绪 */
export function imeMatrixL1Ready(): boolean {
  return (
    imeMatrixCellsFor('A-IME-01').every((c) => c.status !== 'open') &&
    imeMatrixCellsFor('A-IME-02').every((c) => c.status !== 'open')
  );
}
