/**
 * IME 端×断言矩阵常量（M3 / Round8 / **W6-B-S** Skeleton）。
 *
 * 权威文档：`docs/block-workspace-architecture/plans/specs/ime-matrix.md`
 *
 * ## 包轨钉死（W6-B-S）
 * - 本模块轨 = **W6-B-S**（必须带 `-S`）：L0 矩阵成型 + L1/L1+ 语义自动化可测加深
 * - **W6-B 方向加深**：A-IME-06 可标 🟨automated（语义子集）；**仍禁止**写 e2e / 去 `-S`
 * - **≠ W6-B** Strict：WebView L2 必测格 e2e / 叶子核锁定门禁属 W6-B，本文件不得冒充
 * - **≠ 叶子核锁定门禁**：L3「叶子核=PM」仅在 L2 必测全 `e2e` 后；`imeMatrixLeafCoreLockEligible` 在 Skeleton 下应恒 false
 * - **≠ EL**：不关闭任何 EL（IME 锁定相关仅认 **W6-B** + 真 PM）；见 EL-dashboard 表 E
 *
 * 状态语义：
 * - `open` → 文档表 `☐`
 * - `automated` → `🟨自动化`（纯逻辑/契约；不替代 WebView e2e）
 * - `e2e` → `✅e2e`（目标端 WebView 已绿；**仅 W6-B** 可写）
 *
 * 关闭「叶子核=PM」仅认必测格 `e2e`，见矩阵 L2/L3——**W6-B-S 永不写 e2e**。
 */

// ---------------------------------------------------------------------------
// 包轨（W6-B-S Skeleton · 程序可读）
// ---------------------------------------------------------------------------

/**
 * IME 矩阵当前交付包轨。
 *
 * - 值必须为 **`W6-B-S`**（带 `-S`），禁止去 `-S` 冒充 W6-B Strict
 * - 本常量仅标识 L0/L1 自动化骨架轨，**不**表示 L2 e2e / L3 锁核 / EL 关闭
 */
export const IME_MATRIX_PACKAGE_TRACK = 'W6-B-S' as const;

/** 包轨字面量类型（钉死 W6-B-S，拒绝无 `-S` 别名） */
export type ImeMatrixPackageTrack = typeof IME_MATRIX_PACKAGE_TRACK;

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
 * - e2e：目标 WebView e2e 已绿（**仅 W6-B 可写**；W6-B-S 禁止）
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

/**
 * Round8：A-IME-01 / A-IME-02 automated。
 * Round9 / **W6-B-S**：A-IME-03…05 语义自动化加深（仍非 WebView e2e）。
 * **W6-B 方向加深**：A-IME-06 语义自动化（远端/Agent 暂缓/禁 remount）；仍非 e2e。
 *
 * 注意：`automated` **≠** L2 `e2e`；本集合不得被写成「W6-B 完成 / 叶子核锁定 / EL 关」。
 * 07–08 仍 open；全矩阵无 e2e 格。
 */
const AUTOMATED_IDS: ReadonlySet<ImeMatrixAssertId> = new Set([
  'A-IME-01',
  'A-IME-02',
  'A-IME-03',
  'A-IME-04',
  'A-IME-05',
  /** W6-B 方向加深一格：语义 🟨；≠ L2 e2e */
  'A-IME-06',
]);

/** L1 核心：A-IME-01 / 02（04-S / W6-B-S 语义子集） */
const L1_ASSERT_IDS: readonly ImeMatrixAssertId[] = ['A-IME-01', 'A-IME-02'];

/** L1+ 加深：A-IME-03…05（仍为 🟨，**不计 L2**；W6-B-S 合法交付） */
const L1_PLUS_ASSERT_IDS: readonly ImeMatrixAssertId[] = [
  'A-IME-03',
  'A-IME-04',
  'A-IME-05',
];

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
  'A-IME-03': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-03 合成中滚动 pin / planScrollUnmount 不卸 composing',
    'packages/editor-kit/src/viewport/pin.test.ts',
  ],
  'A-IME-04': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-04 end_then_switch 点另一块先 end 再切',
  ],
  'A-IME-05': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-05 多次 update 仅 end 产生一条 commit 边界',
  ],
  'A-IME-06': [
    'packages/editor-kit/src/ime/ime-matrix.contract.test.ts',
    'A-IME-06 合成中远端/Agent 同块 text 暂缓；禁 full remount',
    'packages/editor-kit/src/ime/remotePatchGuard.ts',
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

/**
 * 矩阵格抽样：按端过滤（三端 e2e 必须分端勾选；自动化可同格并进）。
 * W6-B-S 用途：契约侧断言「某端 必测/抽样」与文档表一致，**不**推进 L2。
 */
export function imeMatrixCellsForPlatform(
  platform: ImeMatrixPlatform
): readonly ImeMatrixCell[] {
  return IME_MATRIX_CELLS.filter((c) => c.platform === platform);
}

/**
 * 矩阵格抽样：按覆盖状态过滤。
 * W6-B-S + 方向加深预期：`automated` 含 01–06×3 端；`e2e` 为空；`open` 含 07–08。
 */
export function imeMatrixCellsByStatus(
  status: ImeMatrixCellStatus
): readonly ImeMatrixCell[] {
  return IME_MATRIX_CELLS.filter((c) => c.status === status);
}

/** 必测且仍未 e2e 的格（L2 未关闭清单） */
export function imeMatrixOpenRequiredCells(): readonly ImeMatrixCell[] {
  return IME_MATRIX_CELLS.filter(
    (c) => c.requirement === '必测' && c.status !== 'e2e'
  );
}

/**
 * 是否存在任一 `e2e` 格。
 * **W6-B-S 预期恒 false**——出现 true 表示有人误把 L2 状态写进 Skeleton 矩阵。
 */
export function imeMatrixAnyE2e(): boolean {
  return IME_MATRIX_CELLS.some((c) => c.status === 'e2e');
}

/**
 * L3 叶子核锁定资格（程序可读）。
 * 条件：全部「必测」格均为 `e2e`（openRequired 为空）。
 *
 * - **≠ W6-B-S 完成定义**：Skeleton 下应恒 `false`
 * - **≠ EL 关闭**：本函数不触碰任何 EL 位
 * - 仅当 **W6-B** 真把必测格刷成 e2e 后才可能 true
 */
export function imeMatrixLeafCoreLockEligible(): boolean {
  return imeMatrixOpenRequiredCells().length === 0;
}

/** L0/L1：矩阵成型 + A-IME-01/02 语义子集是否就绪（仍 ≠ L2） */
export function imeMatrixL1Ready(): boolean {
  return L1_ASSERT_IDS.every((id) =>
    imeMatrixCellsFor(id).every((c) => c.status !== 'open')
  );
}

/**
 * L1+：A-IME-03…05 语义子集是否均非 open（仍为 🟨 automated）。
 *
 * - W6-B-S 合法加深目标：本函数可为 true
 * - **≠ L2**：不检查 e2e；true **不得**解释为 WebView 矩阵关闭
 * - **≠ 叶子核锁定**；**≠ EL**
 */
export function imeMatrixL1PlusReady(): boolean {
  return L1_PLUS_ASSERT_IDS.every((id) =>
    imeMatrixCellsFor(id).every((c) => c.status !== 'open')
  );
}

/** L1 断言 ID 列表（只读导出，供契约测抽样） */
export function imeMatrixL1AssertIds(): readonly ImeMatrixAssertId[] {
  return L1_ASSERT_IDS;
}

/** L1+ 断言 ID 列表（只读导出，供契约测抽样） */
export function imeMatrixL1PlusAssertIds(): readonly ImeMatrixAssertId[] {
  return L1_PLUS_ASSERT_IDS;
}
