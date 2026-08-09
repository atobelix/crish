// tests/unit/selection-anchor.test.ts
// R4-B 选区方向轮（04 编辑深度扩展 §3.3 方案 1：anchor/head/assoc）测试
//
// 覆盖：
// 1. anchor/head 语义：setSelection(start, end) 兼容（无 anchor 时 start 即
//    anchor、head = end）；anchorPos/headPos 独立存储，兼容层归一化字段
//    （selectionStart/selectionEnd/cursorPos）行为零变化（336 门禁）。
// 2. moveHead：只动 head 不动 anchor；选区区间 = [min(anchor,head), max]，
//    方向由 anchor/head 相对位置判定——反向移动天然正确。
// 3. extendSelectionByDirection：Shift+方向键扩展的存储侧语义——「Shift+Left
//    后 Shift+Right」第二次方向正确（旧启发式 selectionStart === cursorPos
//    在光标离开选区端后即失效，本模型 anchor 全程固定）。
// 4. 删除选区语义：head/anchor 任意顺序的选区删除（deleteSelection /
//    insertText 覆盖）后光标收敛到选区起点，anchor = head = 落点。
// 5. 与 applyChange 交互：事务后方向层同步收敛到落点；undo/redo 从 before
//    快照恢复方向（含反向选区）。
// 6. assoc：光标方向性（行尾 'after' / 其他 'before'）——computeAssoc 纯函数
//    与 setCursorPos/moveHead/applyChange/appendText 落点联动。

import { describe, it, expect, beforeEach } from 'vitest';
import { useEditorStore, computeAssoc } from '../../src/core/EditorStore';
import { LineOffsetTree } from '../../src/core/SegmentTree';

// 重置 store 到初始单行空文档（与既有测试同款：旧字段 lines 经
// normalizeSetStatePartial 映射为主数组并清空尾段/流式会话记账；方向层由
// R4-B 默认补齐逻辑同步为 anchor = head = cursor）
function resetStore() {
  useEditorStore.setState({
    lines: [''],
    lineOffsets: new LineOffsetTree([0]),
    codeBlockState: ['none'],
    textLength: 0,
    cursorPos: 0,
    selectionStart: 0,
    selectionEnd: 0,
    undoStack: [],
    redoStack: [],
  });
}

describe('R4-B 选区方向性（anchor/head/assoc）', () => {
  beforeEach(() => {
    resetStore();
  });

  // —— 1. anchor/head 基础语义 ——

  it('setSelection 正向：anchor = start、head = end、cursor = head', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    const s = useEditorStore.getState();
    // 兼容层（门禁语义不变）：归一化 min/max、cursorPos 恒等于 end
    expect(s.selectionStart).toBe(5);
    expect(s.selectionEnd).toBe(8);
    expect(s.cursorPos).toBe(8);
    // 方向层：无 anchor 时 start 即 anchor，head = end
    expect(s.anchorPos).toBe(5);
    expect(s.headPos).toBe(8);
  });

  it('setSelection 反向（start > end）：方向层保留 start 即 anchor，兼容层仍归一化', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(8, 5);
    const s = useEditorStore.getState();
    // 兼容层归一化不变（336 门禁的 setSelection 行为）
    expect(s.selectionStart).toBe(5);
    expect(s.selectionEnd).toBe(8);
    expect(s.cursorPos).toBe(5);
    // 方向层：anchor 在 8（start），head 在 5（end，光标端）
    expect(s.anchorPos).toBe(8);
    expect(s.headPos).toBe(5);
  });

  it('setSelection 越界钳制：负值与超长边界收敛到 [0, textLength]', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(-5, 100);
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(0);
    expect(s.headPos).toBe(11);
    expect(s.cursorPos).toBe(11);
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(11);
  });

  // —— 2. moveHead：只动 head 不动 anchor ——

  it('moveHead 只移动 head，anchor 保持不动（正向扩展）', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().moveHead(10);
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(5); // 锚点固定
    expect(s.headPos).toBe(10);
    expect(s.cursorPos).toBe(10);
    expect(s.selectionStart).toBe(5);
    expect(s.selectionEnd).toBe(10);
  });

  it('moveHead 反向移动：head 越过 anchor，选区翻转但方向保持', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().moveHead(3);
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(5); // 锚点依旧固定
    expect(s.headPos).toBe(3);
    expect(s.cursorPos).toBe(3);
    expect(s.selectionStart).toBe(3);
    expect(s.selectionEnd).toBe(5);
  });

  it('moveHead 越界钳制：新位置收敛到 [0, textLength]', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(2, 5);
    useEditorStore.getState().moveHead(999);
    expect(useEditorStore.getState().headPos).toBe(11);
    useEditorStore.getState().moveHead(-5);
    expect(useEditorStore.getState().headPos).toBe(0);
  });

  it('setSelection(newPos, newPos) 等价纯移动：anchor = head = 新位置', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().setSelection(10, 10);
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(10);
    expect(s.headPos).toBe(10);
    expect(s.cursorPos).toBe(10);
    expect(s.selectionStart).toBe(10);
    expect(s.selectionEnd).toBe(10);
  });

  it('setCursorPos 纯移动：anchor = head = 新位置', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().setCursorPos(4);
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(4);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(4);
  });

  // —— 3. extendSelectionByDirection：Shift+方向键扩展（任务书核心用例）——

  it('Shift+方向键扩展：anchor 不动、head 移动（向右扩展）', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(3, 3);
    useEditorStore.getState().extendSelectionByDirection('right');
    const s1 = useEditorStore.getState();
    expect(s1.anchorPos).toBe(3);
    expect(s1.headPos).toBe(4);
    expect(s1.selectionStart).toBe(3);
    expect(s1.selectionEnd).toBe(4);
    useEditorStore.getState().extendSelectionByDirection('right');
    const s2 = useEditorStore.getState();
    expect(s2.anchorPos).toBe(3);
    expect(s2.headPos).toBe(5);
    expect(s2.selectionEnd).toBe(5);
  });

  it('反向扩展第二次方向正确：Shift+Left 后 Shift+Right 从原方向继续', () => {
    useEditorStore.getState().insertText('Hello World');
    // 光标 3 处开始，向左扩展两次到 1
    useEditorStore.getState().setSelection(3, 3);
    useEditorStore.getState().extendSelectionByDirection('left');
    useEditorStore.getState().extendSelectionByDirection('left');
    let s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(1);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(3);
    // 反向（向右）第二次：head 从 1 回到 2，anchor 仍 3——
    // 旧启发式（selectionStart === cursorPos ? newPos : selectionStart）
    // 在此场景会把 anchor 错设为 1，本模型方向保持正确
    useEditorStore.getState().extendSelectionByDirection('right');
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(2);
    expect(s.cursorPos).toBe(2);
    expect(s.selectionStart).toBe(2);
    expect(s.selectionEnd).toBe(3);
  });

  it('扩展越过 anchor：head 越过锚点后选区反向，anchor 依旧固定', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(3, 3);
    // 向左扩展 4 次：head 3 → 2 → 1 → 0，第 4 次已到文首
    useEditorStore.getState().extendSelectionByDirection('left');
    useEditorStore.getState().extendSelectionByDirection('left');
    useEditorStore.getState().extendSelectionByDirection('left');
    let s = useEditorStore.getState();
    expect(s.headPos).toBe(0);
    expect(s.anchorPos).toBe(3);
    expect(s.selectionStart).toBe(0);
    expect(s.selectionEnd).toBe(3);
    // 反向第一次向右：head 0 → 1，选区 [1,3]——锚点依旧 3
    useEditorStore.getState().extendSelectionByDirection('right');
    s = useEditorStore.getState();
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(1);
    expect(s.cursorPos).toBe(1);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(3);
  });

  it('扩展至文档边界为空操作（幂等）', () => {
    // 空文档：左右均无动作
    useEditorStore.getState().extendSelectionByDirection('left');
    useEditorStore.getState().extendSelectionByDirection('right');
    let s = useEditorStore.getState();
    expect(s.headPos).toBe(0);
    expect(s.anchorPos).toBe(0);
    // 文首向左：不动
    useEditorStore.getState().insertText('Hello');
    useEditorStore.getState().setSelection(1, 1);
    useEditorStore.getState().extendSelectionByDirection('left');
    s = useEditorStore.getState();
    expect(s.headPos).toBe(0);
    expect(s.anchorPos).toBe(1);
    // 文末向右：不动
    useEditorStore.getState().setSelection(5, 5);
    useEditorStore.getState().extendSelectionByDirection('right');
    s = useEditorStore.getState();
    expect(s.headPos).toBe(5);
    expect(s.anchorPos).toBe(5);
  });

  it('扩展为 grapheme 粒度（代理对整体跨越）', () => {
    useEditorStore.getState().insertText('a🙂b');
    useEditorStore.getState().setSelection(0, 0);
    useEditorStore.getState().extendSelectionByDirection('right');
    expect(useEditorStore.getState().headPos).toBe(1); // 'a' 之后
    useEditorStore.getState().extendSelectionByDirection('right');
    expect(useEditorStore.getState().headPos).toBe(3); // emoji（2 码元）之后
    useEditorStore.getState().extendSelectionByDirection('right');
    expect(useEditorStore.getState().headPos).toBe(4); // 'b' 之后（文末）
    useEditorStore.getState().extendSelectionByDirection('left');
    expect(useEditorStore.getState().headPos).toBe(3);
  });

  // —— 4. 删除选区语义（head/anchor 任意顺序）——

  it('deleteSelection 反向选区：参数任意顺序、删除区间一致、光标收敛到选区起点', () => {
    useEditorStore.getState().insertText('Hello World');
    // 反向选区：anchor=8、head=5（deleteSelection 传 (5, 8)）
    useEditorStore.getState().setSelection(8, 5);
    useEditorStore.getState().deleteSelection(5, 8);
    const s = useEditorStore.getState();
    // 删除 [5,8)=' Wo'（5 空格 / 6 W / 7 o），'Hello'+'rld'='Hellorld'
    expect(s.getText()).toBe('Hellorld');
    expect(s.cursorPos).toBe(5);
    expect(s.anchorPos).toBe(5);
    expect(s.headPos).toBe(5);
  });

  it('deleteSelection 正向选区：参数反传（end, start）同样正确', () => {
    useEditorStore.getState().insertText('Hello World');
    // 正向选区：anchor=5、head=8（deleteSelection 传 (8, 5) 反向参数）
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().deleteSelection(8, 5);
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Hellorld');
    expect(s.cursorPos).toBe(5);
    expect(s.anchorPos).toBe(5);
    expect(s.headPos).toBe(5);
  });

  it('反向选区 insertText 覆盖：删除选区 + 插入合并，方向层收敛到落点', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(8, 5); // 反向选区 [5,8)
    useEditorStore.getState().insertText('!');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Hello!rld');
    expect(s.cursorPos).toBe(6); // 5 + 1
    expect(s.anchorPos).toBe(6);
    expect(s.headPos).toBe(6);
    expect(s.selectionStart).toBe(6);
    expect(s.selectionEnd).toBe(6);
  });

  it('deleteText 有选区时删除整个选区（方向任意）', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(8, 5);
    useEditorStore.getState().deleteText(true); // Backspace
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Hellorld');
    expect(s.cursorPos).toBe(5);
    expect(s.anchorPos).toBe(5);
    expect(s.headPos).toBe(5);
  });

  // —— 5. 与 applyChange 交互 ——

  it('applyChange 事务后方向层收敛到落点（替换/删除/插入）', () => {
    useEditorStore.getState().insertText('abcdef');
    useEditorStore.getState().setSelection(2, 4); // 无方向意义的中间选区
    // 替换 [2,5) → 'XY'：光标落 2+2=4
    useEditorStore.getState().applyChange(2, 5, 'XY');
    let s = useEditorStore.getState();
    expect(s.getText()).toBe('abXYf');
    expect(s.cursorPos).toBe(4);
    expect(s.anchorPos).toBe(4);
    expect(s.headPos).toBe(4);
    expect(s.selectionStart).toBe(4);
    expect(s.selectionEnd).toBe(4);
    // 删除 [1,3) → ''：光标落 1
    useEditorStore.getState().applyChange(1, 3, '');
    s = useEditorStore.getState();
    expect(s.getText()).toBe('aYf');
    expect(s.cursorPos).toBe(1);
    expect(s.anchorPos).toBe(1);
    expect(s.headPos).toBe(1);
    // 纯插入 [0,0) → 'ZZ'：光标落 2
    useEditorStore.getState().applyChange(0, 0, 'ZZ');
    s = useEditorStore.getState();
    expect(s.getText()).toBe('ZZaYf');
    expect(s.cursorPos).toBe(2);
    expect(s.anchorPos).toBe(2);
    expect(s.headPos).toBe(2);
  });

  it('undo 恢复方向：正向选区撤销后 anchor/head 还原', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(3, 8); // anchor=3、head=8
    useEditorStore.getState().insertText('XYZ'); // 覆盖 [3,8)='lo Wo'
    useEditorStore.getState().undo();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Hello World');
    expect(s.cursorPos).toBe(8); // 编辑前光标在选区 end 端
    expect(s.anchorPos).toBe(3);
    expect(s.headPos).toBe(8);
    expect(s.selectionStart).toBe(3);
    expect(s.selectionEnd).toBe(8);
  });

  it('undo 恢复方向：反向选区撤销后 anchor/head 还原（anchor 在 max 端）', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(8, 3); // anchor=8、head=3（光标在 min 端）
    useEditorStore.getState().insertText('X'); // 覆盖 [3,8)='lo Wo'
    useEditorStore.getState().undo();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('Hello World');
    expect(s.cursorPos).toBe(3); // 编辑前光标在选区 min 端
    expect(s.anchorPos).toBe(8); // 反向选区：anchor 还原到 max 端
    expect(s.headPos).toBe(3);
  });

  it('redo 恢复方向：与 undo 对称', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(3, 8);
    useEditorStore.getState().insertText('XYZ');
    useEditorStore.getState().undo();
    useEditorStore.getState().redo();
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('HelXYZrld');
    expect(s.cursorPos).toBe(6);
    expect(s.anchorPos).toBe(6);
    expect(s.headPos).toBe(6);
  });

  it('appendText 平移方向层：追加点前移路径（光标处插入）选区不跨锚点不动', () => {
    useEditorStore.getState().insertText('abc'); // 触发用户活跃标记（1s 窗口）
    // 光标 2 在逻辑末行内且用户活跃 → 追加点前移至光标处
    useEditorStore.getState().setSelection(1, 2);
    useEditorStore.getState().appendText('XY');
    const s = useEditorStore.getState();
    // 流内容插入到光标前：'ab' + 'XY' + 'c'
    expect(s.getText()).toBe('abXYc');
    // 选区 [1,2) 在追加点（光标 2）之前：anchor/head 均不平移
    expect(s.anchorPos).toBe(1);
    expect(s.headPos).toBe(2);
    expect(s.cursorPos).toBe(2);
  });

  it('appendText 平移方向层：追加点 = 全文末尾（光标恰在文末），选区跨末尾 +delta', () => {
    useEditorStore.getState().insertText('abc'); // 光标 = 3（全文末尾）
    // 光标恰在文末（cursorPos === textLength）→ 追加点锚定全文末尾
    useEditorStore.getState().setSelection(1, 3); // 选区 [1,3) 尾跨末尾
    useEditorStore.getState().appendText('XY');
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('abcXY');
    // anchor 1 < 追加点 3：不动；head 3 ≥ 追加点：+2 → 5
    expect(s.anchorPos).toBe(1);
    expect(s.headPos).toBe(5);
    expect(s.cursorPos).toBe(5);
    expect(s.selectionStart).toBe(1);
    expect(s.selectionEnd).toBe(5);
  });

  // —— 6. assoc 光标方向性 ——

  it('computeAssoc 纯函数：行尾/文末 after，其余 before', () => {
    const text = 'ab\ncd';
    expect(computeAssoc(text, 0)).toBe('before'); // 文首
    expect(computeAssoc(text, 1)).toBe('before'); // 行中
    expect(computeAssoc(text, 2)).toBe('after'); // 'ab' 行尾
    expect(computeAssoc(text, 3)).toBe('before'); // 'cd' 行首
    expect(computeAssoc(text, 4)).toBe('before'); // 行中
    expect(computeAssoc(text, 5)).toBe('after'); // 文末
    expect(computeAssoc('', 0)).toBe('before'); // 空文档
    expect(computeAssoc('abc', 3)).toBe('after'); // 无换行文末
    // 越界钳制
    expect(computeAssoc('ab\ncd', -1)).toBe('before');
    expect(computeAssoc('ab\ncd', 99)).toBe('after');
  });

  it('setCursorPos / moveHead 刷新 assoc：行尾 after、行首 before', () => {
    useEditorStore.getState().insertText('ab\ncd');
    useEditorStore.getState().setCursorPos(2); // 'ab' 行尾
    expect(useEditorStore.getState().assoc).toBe('after');
    useEditorStore.getState().setCursorPos(3); // 'cd' 行首
    expect(useEditorStore.getState().assoc).toBe('before');
    useEditorStore.getState().setCursorPos(5); // 文末
    expect(useEditorStore.getState().assoc).toBe('after');
    // moveHead 到行尾
    useEditorStore.getState().setSelection(0, 0);
    useEditorStore.getState().moveHead(2);
    expect(useEditorStore.getState().assoc).toBe('after');
  });

  it('extendSelectionByDirection 刷新 assoc：扩展到行尾为 after', () => {
    useEditorStore.getState().insertText('ab\ncd');
    useEditorStore.getState().setSelection(0, 0);
    useEditorStore.getState().extendSelectionByDirection('right');
    expect(useEditorStore.getState().assoc).toBe('before'); // head=1 行中
    useEditorStore.getState().extendSelectionByDirection('right');
    expect(useEditorStore.getState().assoc).toBe('after'); // head=2 行尾
  });

  it('applyChange 落点在行尾时 assoc 为 after', () => {
    useEditorStore.getState().insertText('ab\ncd');
    useEditorStore.getState().setCursorPos(2); // 'ab' 行尾
    useEditorStore.getState().applyChange(2, 2, 'x'); // 行尾插入
    const s = useEditorStore.getState();
    expect(s.getText()).toBe('abx\ncd');
    expect(s.cursorPos).toBe(3); // 'abx' 行尾
    expect(s.assoc).toBe('after');
  });

  it('appendText 后光标在文末时 assoc 为 after', () => {
    useEditorStore.getState().insertText('abc');
    useEditorStore.getState().appendText('de');
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(5);
    expect(s.assoc).toBe('after');
  });

  it('setText 整档重置：方向层一并复位', () => {
    useEditorStore.getState().insertText('Hello World');
    useEditorStore.getState().setSelection(5, 8);
    useEditorStore.getState().setText('new doc');
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(0);
    expect(s.headPos).toBe(0);
    expect(s.assoc).toBe('before');
  });

  // —— 7. 外部直改（normalize 默认补齐）与不变量 ——

  it('外部 setState 直改旧三元组：方向层按「start 即 anchor、cursor 即 head」补齐', () => {
    useEditorStore.getState().insertText('Hello World');
    // 模拟 HiddenInput selectionchange 回写路径（直接 setState 三元组）
    useEditorStore.setState({
      cursorPos: 4,
      selectionStart: 2,
      selectionEnd: 4,
    });
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(2);
    expect(s.headPos).toBe(4);
    expect(s.assoc).toBe('before'); // 外部路径无文本上下文，保守默认
  });

  it('resetStore（不含方向层字段）后 anchor = head = 0', () => {
    resetStore();
    const s = useEditorStore.getState();
    expect(s.anchorPos).toBe(0);
    expect(s.headPos).toBe(0);
  });

  it('不变量：cursorPos 恒等于 headPos（混合操作序列）', () => {
    const store = useEditorStore.getState();
    store.insertText('one two three');
    store.setSelection(0, 3);
    store.moveHead(8);
    store.extendSelectionByDirection('left');
    store.extendSelectionByDirection('right');
    store.insertText('X');
    store.setSelection(6, 2);
    store.deleteSelection(2, 6);
    store.appendText('tail');
    store.undo();
    store.redo();
    const s = useEditorStore.getState();
    expect(s.cursorPos).toBe(s.headPos);
    expect(s.anchorPos).toBe(s.headPos); // 编辑后选区收敛，anchor = head
    // 兼容层与方向层一致：selectionStart/End = [min(anchor,head), max]
    expect(s.selectionStart).toBe(Math.min(s.anchorPos, s.headPos));
    expect(s.selectionEnd).toBe(Math.max(s.anchorPos, s.headPos));
  });
});
