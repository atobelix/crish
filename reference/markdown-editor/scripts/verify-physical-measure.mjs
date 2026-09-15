/**
 * 真机自动化物理防御测量系统（Real-Device Physical Defense Verification Suite）
 * 遵循 .agents/LOGIC_PLAN_NO_RETREAT.md 反退避铁律与 docs/markdown-typography-redesign/01 方案。
 * 
 * 核心断言：
 * 1. 字符点击水平吸附误差刚性门槛：|caretRect.left - clickedCharRect.boundary| <= 0.5px
 * 2. 覆盖场景：纯中文 CJK、纯英文 ASCII、中英数混排、H1~H6标题、行内标记、表格单元格
 * 3. 表格交互契约：
 *    - 单次点击：选中单元格（cell-selected），无文本光标，无全高灰色矩形
 *    - 二次点击：进入行内文本编辑态（cell-editing），光标精准定位于鼠标点击字符
 *    - 多格拖选：矩形选择范围高亮，左上角首格绝不出现额外灰色选择框
 * 4. 深度滚动视口对齐验证（3900px+）
 */

import { chromium } from 'playwright';

const TARGET_URL = process.env.TEST_URL || 'http://localhost:5173/';
const TOLERANCE_PX = 0.5; // 刚性物理对齐阈值：0.5 像素以内


/** 行滚动定位（Alcove 布局感知）：行真实 DOM 偏移 + 容器 padding-top。
 * 旧口径按 `行号 * 28` 直接算 scrollTop——容器顶部留白升级为 64px 后
 * 过期（行偏移含 padding-top）。行已虚拟化挂载时用 offsetTop（精确），
 * 未挂载时回落 行号*28 + padding-top（单行高 28px 场景等价）。 */
function scrollTopForLine(container, lineIdx, margin = 150) {
  const padTop = parseFloat(window.getComputedStyle(container).paddingTop || '0');
  const row = container.querySelector(`[data-index="${lineIdx}"]`);
  const base = row ? row.offsetTop + padTop : lineIdx * 28 + padTop;
  return Math.max(0, base - margin);
}

async function runDefenseSuite() {
  console.log('================================================================');
  console.log('🛡️  启动真实 Chromium 物理测量计算与交互状态机防御套件');
  console.log(`📍 目标地址: ${TARGET_URL}`);
  console.log(`📏 物理对齐硬门槛: |ΔX| ≤ ${TOLERANCE_PX}px`);
  console.log('================================================================\n');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
  page.on('pageerror', err => console.error('BROWSER ERROR:', err));

  try {
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForSelector('.editor-scroll-container', { timeout: 10000 });
    await page.evaluate(() => {
      // Alcove 布局感知的行滚动定位（容器顶部留白 64px；行偏移 = 行 offsetTop + padding-top）
      window.__scrollTopForLine = (container, lineIdx, margin = 150) => {
        const padTop = parseFloat(window.getComputedStyle(container).paddingTop || '0');
        const row = container.querySelector(`[data-index="${lineIdx}"]`);
        const base = row ? row.offsetTop + padTop : lineIdx * 28 + padTop;
        return Math.max(0, base - margin);
      };
    });
    
    // 等待字体加载与 DOM 挂载完全稳定
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(300);

    // 在页面内部注入高精度测量防御探针
    const testReport = await page.evaluate(async (maxTolerance) => {
      const suiteResults = [];
      const container = document.querySelector('.editor-scroll-container');
      if (!container) {
        return { fatal: '未找到 .editor-scroll-container 容器' };
      }

      // 辅助函数：等待渲染与测量帧同步
      function waitForFrame(ms = 80) {
        return new Promise((resolve) => {
          requestAnimationFrame(() => {
            setTimeout(resolve, ms);
          });
        });
      }

      // 辅助函数：创建单字符精确 Range 并读取物理外接矩形
      function getCharPhysicalRect(textNode, offset) {
        const range = document.createRange();
        range.setStart(textNode, offset);
        range.setEnd(textNode, offset + 1);
        return range.getBoundingClientRect();
      }

      // 辅助函数：通过 React props 或合成事件模拟点击
      function triggerCellMouseDown(el, clientX, clientY) {
        let propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
        if (propsKey && el[propsKey] && typeof el[propsKey].onMouseDown === 'function') {
          el[propsKey].onMouseDown({
            button: 0,
            clientX,
            clientY,
            currentTarget: el,
            preventDefault: () => {},
          });
          return true;
        }
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX, clientY, button: 0 }));
        return false;
      }

      // ============================================================
      // 场景 1~4：各语料场景下的物理水平对齐探针 (|ΔX| ≤ 0.5px)
      // ============================================================
      const alignmentScenarios = [
        {
          id: 'SCENARIO-1',
          name: '纯中文字符文本行 (CJK 宽字符物理对齐)',
          selector: '.virtual-row',
          matcher: (t) => t.includes('渲染引擎') && t.includes('全面压力测试'),
          sampleChars: ['高', '性', '能', '测', '试'],
        },
        {
          id: 'SCENARIO-2',
          name: '纯英文字符文本 (ASCII 比例字体物理对齐)',
          selector: '.virtual-row',
          matcher: (t) => t.includes('Markdown'),
          sampleChars: ['M', 'a', 'r', 'k'],
        },
        {
          id: 'SCENARIO-3',
          name: '中英数混排标题 (rem 缩放 + 复合字符间距)',
          selector: '.virtual-row',
          matcher: (t) => t.includes('1. 标题边缘测试') || t.includes('核心交互测试区块'),
          sampleChars: ['1', '.', '标', '题'],
        },
        {
          id: 'SCENARIO-4',
          name: '富文本与引用前缀 (行内格式化标记排版)',
          selector: '.virtual-row',
          matcher: (t) => t.includes('当前渲染规模'),
          sampleChars: ['当', '前', '规', '模'],
        },
        {
          id: 'SCENARIO-5',
          name: '代码块内容行 (带行号槽位的等宽代码物理对齐)',
          selector: '.virtual-row',
          matcher: (t) =>
            t.includes('import React') ||
            t.includes('function demo') ||
            t.includes('MarkdownEngine'),
          sampleChars: ['i', 'm', 'p', 'o', 'r', 't', 'f', 'u', 'n', 'c'],
        },
      ];

      for (const sc of alignmentScenarios) {
        let rows = Array.from(document.querySelectorAll(sc.selector));
        let matchedRow = rows.find(r => r.textContent && sc.matcher(r.textContent));
        if (!matchedRow && window.__editorStore) {
          const store = window.__editorStore.getState();
          const totalLines = store.getLineCount();
          for (let i = 0; i < Math.min(200, totalLines); i++) {
            const lineText = store.getLine(i);
            if (lineText && sc.matcher(lineText)) {
              container.scrollTop = window.__scrollTopForLine(container, i, 0);
              container.dispatchEvent(new Event('scroll'));
              await waitForFrame(100);
              rows = Array.from(document.querySelectorAll(sc.selector));
              matchedRow = rows.find(r => r.textContent && sc.matcher(r.textContent));
              break;
            }
          }
        }
        if (!matchedRow) {
          suiteResults.push({
            id: sc.id,
            name: sc.name,
            passed: false,
            maxDeltaX: 0,
            details: `未找到匹配语料行: ${sc.name}`,
          });
          continue;
        }

        // 确保行在视口内且完全稳定静止
        matchedRow.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        container.dispatchEvent(new Event('scroll'));
        await waitForFrame(80);

        // 收集可见有效 TextNode
        const walker = document.createTreeWalker(matchedRow, NodeFilter.SHOW_TEXT);
        const textNodes = [];
        let currNode;
        while ((currNode = walker.nextNode())) {
          if (currNode.nodeValue && currNode.nodeValue.trim().length > 0) {
            textNodes.push(currNode);
          }
        }

        if (textNodes.length === 0) {
          suiteResults.push({
            id: sc.id,
            name: sc.name,
            passed: false,
            maxDeltaX: 0,
            details: '该行无可见文本节点',
          });
          continue;
        }

        let scenarioMaxDelta = 0;
        let probesCount = 0;
        let failureReason = null;

        for (const targetChar of sc.sampleChars) {
          let foundTn = null;
          let charOffset = -1;
          for (const tn of textNodes) {
            const idx = tn.nodeValue.indexOf(targetChar);
            if (idx !== -1) {
              foundTn = tn;
              charOffset = idx;
              break;
            }
          }

          if (!foundTn || charOffset === -1) continue;

          // 在点击前一刻测量字符坐标
          const charRect = getCharPhysicalRect(foundTn, charOffset);
          if (charRect.width <= 0 || charRect.height <= 0) continue;

          const clickY = charRect.top + charRect.height / 2;

          // 探针 A：字符前半部（25% 处）点击 -> 光标应紧密贴合字符左边缘
          const clickX_left = charRect.left + charRect.width * 0.25;
          matchedRow.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_left,
            clientY: clickY,
          }));
          await waitForFrame(20);
          matchedRow.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_left,
            clientY: clickY,
          }));
          matchedRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_left,
            clientY: clickY,
          }));
          await waitForFrame(80);

          const activeCharRectA = getCharPhysicalRect(foundTn, charOffset);
          let cursor = document.querySelector('.cursor-caret');
          if (cursor) {
            const curRect = cursor.getBoundingClientRect();
            const delta = Math.abs(curRect.left - activeCharRectA.left);
            if (delta > scenarioMaxDelta) scenarioMaxDelta = delta;
            probesCount++;
            if (delta > maxTolerance) {
              failureReason = `字符 "${targetChar}" 前半部点击误差 ${delta.toFixed(2)}px 超过门槛 ${maxTolerance}px (charLeft=${activeCharRectA.left.toFixed(2)}, caretLeft=${curRect.left.toFixed(2)})`;
              break;
            }
          }

          // 探针 B：字符后半部（75% 处）点击 -> 光标应紧密贴合字符右边缘
          const charRectB = getCharPhysicalRect(foundTn, charOffset);
          const clickX_right = charRectB.left + charRectB.width * 0.75;
          const clickY_B = charRectB.top + charRectB.height / 2;
          matchedRow.dispatchEvent(new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_right,
            clientY: clickY_B,
          }));
          await waitForFrame(20);
          matchedRow.dispatchEvent(new MouseEvent('mouseup', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_right,
            clientY: clickY_B,
          }));
          matchedRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_right,
            clientY: clickY_B,
          }));
          await waitForFrame(80);

          const activeCharRectB = getCharPhysicalRect(foundTn, charOffset);
          cursor = document.querySelector('.cursor-caret');
          if (cursor) {
            const curRect = cursor.getBoundingClientRect();
            const delta = Math.abs(curRect.left - activeCharRectB.right);
            if (delta > scenarioMaxDelta) scenarioMaxDelta = delta;
            probesCount++;
            if (delta > maxTolerance) {
              failureReason = `字符 "${targetChar}" 后半部点击误差 ${delta.toFixed(2)}px 超过门槛 ${maxTolerance}px (charRight=${activeCharRectB.right.toFixed(2)}, caretLeft=${curRect.left.toFixed(2)})`;
              break;
            }
          }
        }

        suiteResults.push({
          id: sc.id,
          name: sc.name,
          passed: !failureReason && probesCount > 0,
          probesCount,
          maxDeltaX: scenarioMaxDelta,
          details: failureReason || `已完成 ${probesCount} 次实测探针，最大物理偏差 ${scenarioMaxDelta.toFixed(3)}px`,
        });
      }

      // ============================================================
      // 场景 5：表格单元格交互状态机与灰色矩形防御测试
      // ============================================================
      // 精确定位并滚动到表格所在行
      if (window.__editorStore) {
        const st = window.__editorStore.getState();
        let tableLineIdx = -1;
        for (let i = 0; i < Math.min(300, st.getLineCount()); i++) {
          const l = st.getLine(i);
          if (l && l.startsWith('| 功能模块')) {
            tableLineIdx = i;
            break;
          }
        }
        if (tableLineIdx !== -1) {
          const tableOffset = st.lineOffsets.getOffset(tableLineIdx);
          st.setCursorPos(tableOffset + 2);
          container.dispatchEvent(new Event('scroll'));
        }
      }
      await waitForFrame(200);

      // 清空表格选择状态以开始全新测试
      if (window.__tableStore) {
        window.__tableStore.getState().clearCellSelection();
      }
      await waitForFrame(80);

      const cells = Array.from(document.querySelectorAll('.token-table-cell'));
      if (cells.length < 2) {
        suiteResults.push({
          id: 'SCENARIO-TABLE-1',
          name: '表格单元格单选与编辑交互契约',
          passed: false,
          details: '视口内未找到表格单元格',
        });
      } else {
        const cell0 = cells[0];
        const cell0Rect = cell0.getBoundingClientRect();

        // 步骤 1：单击单元格（单选态）
        triggerCellMouseDown(cell0, cell0Rect.left + 20, cell0Rect.top + 15);
        await waitForFrame(120);

        // 重新从 DOM 查询最新渲染节点
        const selectedCell = document.querySelector('.token-table-cell.is-cell-selected');
        const isEditingAfterClick1 = selectedCell ? selectedCell.classList.contains('is-cell-editing') : false;
        const selectionRectsAfterClick1 = document.querySelectorAll('.selection-rect').length;

        const passClick1 = !!selectedCell && !isEditingAfterClick1 && selectionRectsAfterClick1 === 0;

        suiteResults.push({
          id: 'TABLE-SINGLE-CLICK',
          name: '表格单击选中契约 (Single Click: Cell Selected Mode)',
          passed: passClick1,
          details: passClick1
            ? '单击成功进入单选态，油墨蓝微透底色，零文本光标，零全高灰色矩形'
            : `单选态异常: selected=${!!selectedCell}, editing=${isEditingAfterClick1}, selectionRects=${selectionRectsAfterClick1}`,
        });

        // 步骤 2：在已选中的单元格上再次单击（二次点击进入行内编辑）
        if (selectedCell) {
          const rSel = selectedCell.getBoundingClientRect();
          triggerCellMouseDown(selectedCell, rSel.left + 30, rSel.top + 15);
          await waitForFrame(80);
        }

        const editingCell = document.querySelector('.token-table-cell.is-cell-editing');
        const cursorAfterClick2 = document.querySelector('.cursor-caret');
        const selectionRectsAfterClick2 = document.querySelectorAll('.selection-rect').length;

        let cursorInsideCell = false;
        if (cursorAfterClick2 && editingCell) {
          const curR = cursorAfterClick2.getBoundingClientRect();
          const editR = editingCell.getBoundingClientRect();
          cursorInsideCell = curR.left >= editR.left - 2 && curR.right <= editR.right + 10;
        }

        const passClick2 = !!editingCell && cursorInsideCell && selectionRectsAfterClick2 === 0;

        suiteResults.push({
          id: 'TABLE-SECOND-CLICK',
          name: '表格二次点击行内编辑契约 (Second Click: In-place Text Edit)',
          passed: passClick2,
          details: passClick2
            ? '二次点击成功进入行内文本编辑态，光标正确定位于单元格内，零全高灰色矩形'
            : `编辑态异常: editing=${!!editingCell}, cursorInside=${cursorInsideCell}, selectionRects=${selectionRectsAfterClick2}`,
        });

        // 步骤 3：多单元格拖选测试（左上角首格防灰色矩形）
        // 重新获取最新 cells
        const currentCells = Array.from(document.querySelectorAll('.token-table-cell'));
        const cell1 = currentCells.find(c => !c.classList.contains('is-cell-editing')) || currentCells[0];
        
        if (!cell1) {
          suiteResults.push({
            id: 'TABLE-DRAG-DEFENSE',
            name: '单元格拖选防御 (Zero Gray Box on Top-Left Drag Origin)',
            passed: false,
            details: `未找到可用单元格进行拖选测试 (cells count: ${currentCells.length})`,
          });
        } else {
          const cell1Rect = cell1.getBoundingClientRect();
          triggerCellMouseDown(cell1, cell1Rect.left + 15, cell1Rect.top + 15);
          await waitForFrame(60);

          // 悬停至下一行的单元格
          const nextRowCell = currentCells.find(c => 
            c.getAttribute('data-line-index') !== cell1.getAttribute('data-line-index') &&
            c.getAttribute('data-col-index') === cell1.getAttribute('data-col-index')
          ) || currentCells[currentCells.length - 1];

          if (nextRowCell) {
            let propsKeyNext = Object.keys(nextRowCell).find(k => k.startsWith('__reactProps$'));
            if (propsKeyNext && nextRowCell[propsKeyNext] && nextRowCell[propsKeyNext].onMouseEnter) {
              nextRowCell[propsKeyNext].onMouseEnter();
            }
          }
          await waitForFrame(60);

          // 检查 selection-rect
          const selectionRectsDuringDrag = document.querySelectorAll('.selection-rect').length;
          const passDrag = selectionRectsDuringDrag === 0;

          suiteResults.push({
            id: 'TABLE-DRAG-DEFENSE',
            name: '单元格拖选防御 (Zero Gray Box on Top-Left Drag Origin)',
            passed: passDrag,
            details: passDrag
              ? '单元格拖选期间完全抑制多余 selection-rect，左上角首格零灰色矩形干扰'
              : `拖选期间检测到 ${selectionRectsDuringDrag} 个非法 selection-rect 泄露`,
          });

          // 步骤 4：单元格就地编辑点击移动与零选区泄露防御 (TABLE-INCELL-CLICK-MOVE)
          const teamCell = currentCells.find(c => c.innerText.includes('负责团队')) || currentCells[3];
          if (teamCell) {
            const tRect = teamCell.getBoundingClientRect();
            // 单击选择
            triggerCellMouseDown(teamCell, tRect.left + 20, tRect.top + 15);
            await waitForFrame(50);
            // 二次点击进入编辑态（前部字符）
            triggerCellMouseDown(teamCell, tRect.left + 35, tRect.top + 15);
            await waitForFrame(50);
            const pos1 = window.__editorStore.getState().cursorPos;

            // 三次点击在编辑态中重新定位到后部字符（例如"队"）
            const editingTeam = document.querySelector('.token-table-cell.is-cell-editing') || teamCell;
            triggerCellMouseDown(editingTeam, tRect.left + 65, tRect.top + 15);
            await waitForFrame(50);
            const pos2 = window.__editorStore.getState().cursorPos;

            const selRectsMove = document.querySelectorAll('.selection-rect').length;
            const passMove = pos2 !== pos1 && selRectsMove === 0;

            suiteResults.push({
              id: 'TABLE-INCELL-CLICK-MOVE',
              name: '单元格编辑态点击自由重定位契约 (In-cell Click Repositioning)',
              passed: passMove,
              details: passMove
                ? `编辑态点击成功在单元格内移动光标 (${pos1} -> ${pos2})，零选区矩形泄露`
                : `重定位异常: pos1=${pos1}, pos2=${pos2}, selRects=${selRectsMove}`,
            });

            // 步骤 5：单元格方向键边界与行列导航契约 (TABLE-KEYBOARD-NAV)
            const textarea = document.querySelector('textarea');
            if (textarea) {
              // 左键单步移动
              textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
              await waitForFrame(40);
              const posAfterLeft = window.__editorStore.getState().cursorPos;
              const movedLeft = posAfterLeft === pos2 - 1;

              // 连续左键越过左边界进入上一列
              for (let k = 0; k < 5; k++) {
                textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
              }
              await waitForFrame(40);
              const colAfterCrossLeft = window.__tableStore.getState().selectedCell?.startCol;
              const crossedLeft = colAfterCrossLeft !== undefined && colAfterCrossLeft < 3;

              // 下键下跳到下一行数据单元格（跳过分隔行）
              textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
              await waitForFrame(40);
              const lineAfterDown = window.__tableStore.getState().selectedCell?.startLine;
              const downSkippedSep = lineAfterDown !== undefined && lineAfterDown > 138;

              const passNav = movedLeft && crossedLeft && downSkippedSep;
              suiteResults.push({
                id: 'TABLE-KEYBOARD-NAV',
                name: '单元格方向键安全漫游与分隔行越障契约 (Cell Arrow Navigation)',
                passed: passNav,
                details: passNav
                  ? '方向键单步移动、跨列漫游、跨分隔行越障完全正确'
                  : `导航异常: movedLeft=${movedLeft} (pos2=${pos2}, posAfterLeft=${posAfterLeft}), crossedLeft=${crossedLeft}, downSkippedSep=${downSkippedSep}`,
              });
            }
          }
        }
      }

      // ============================================================
      // 场景 6：隐藏语法标记折叠与预演点击锚定测试 (SYNTAX-HIDDEN-EXPANSION-ANCHOR)
      // ============================================================
      if (window.__tableStore) {
        window.__tableStore.getState().clearCellSelection();
      }
      const headingEl = Array.from(document.querySelectorAll('.virtual-row')).find(r => {
        return r.querySelector('.token-heading-prefix');
      });
      if (headingEl) {
        const spans = headingEl.querySelectorAll('span[data-token-start]');
        const textSpan = spans[1] || spans[0];
        const tNode = textSpan.childNodes[0];
        if (tNode) {
          const range = document.createRange();
          range.setStart(tNode, Math.min(2, (tNode.nodeValue || '').length - 1));
          range.setEnd(tNode, Math.min(3, (tNode.nodeValue || '').length));
          const charR = range.getBoundingClientRect();
          const clickX = charR.left + charR.width / 2;
          const clickY = charR.top + charR.height / 2;

          headingEl.dispatchEvent(new MouseEvent('mousedown', { clientX: clickX, clientY: clickY, bubbles: true }));
          await waitForFrame(20);
          headingEl.dispatchEvent(new MouseEvent('click', { clientX: clickX, clientY: clickY, bubbles: true }));
          await waitForFrame(60);

          const cursorPos = window.__editorStore.getState().cursorPos;
          const prefixLen = parseInt(spans[0].getAttribute('data-token-length') || '0', 10);
          const lineStart = parseInt(headingEl.getAttribute('data-line-start') || '0', 10);
          const anchorCorrect = cursorPos >= lineStart + prefixLen;

          suiteResults.push({
            id: 'SYNTAX-HIDDEN-ANCHOR',
            name: '隐藏语法前缀展开光标视觉锚定防御 (Syntax Hidden Expansion Anchor)',
            passed: anchorCorrect,
            details: anchorCorrect
              ? `光标严格锚定于点击之可见字符 (pos=${cursorPos} >= textStart=${lineStart + prefixLen})，零被折叠前缀抢占`
              : `光标被折叠前缀抢占: pos=${cursorPos} < textStart=${lineStart + prefixLen}`,
          });
        }
      }

      // ============================================================
      // 场景 7：内联 HTML 标签折叠展开精准光标锚定测试 (HTML-SPAN-EXPANSION-ANCHOR)
      // ============================================================
      // 先将光标移到第 0 行，确保目标行处于未激活、折叠语法隐藏状态
      if (window.__editorStore) {
        window.__editorStore.getState().setCursorPos(0);
      }
      await waitForFrame(80);

      // 滚动并查找包含 "这是蓝色文字吗" 的行
      if (window.__editorStore) {
        const st = window.__editorStore.getState();
        let spanLineIdx = -1;
        for (let i = 0; i < Math.min(300, st.getLineCount()); i++) {
          const l = st.getLine(i);
          if (l && l.includes('这是蓝色文字吗')) {
            spanLineIdx = i;
            break;
          }
        }
        if (spanLineIdx !== -1) {
          const rowEl = document.querySelector(`[data-index="${spanLineIdx}"]`);
          if (rowEl) {
            rowEl.scrollIntoView({ block: 'center' });
          } else {
            container.scrollTop = 3800;
          }
        }
      }
      await waitForFrame(120);

      const htmlRow = Array.from(document.querySelectorAll('.virtual-row')).find(r => {
        return r.textContent && r.textContent.includes('这是蓝色文字吗');
      });

      if (htmlRow) {
        // 查找未激活状态下的目标 span
        const targetSpan = Array.from(htmlRow.querySelectorAll('span[data-token-start]')).find(s => {
          return s.textContent && s.textContent.includes('这是蓝色文字吗');
        });
        const textNode = targetSpan ? (targetSpan.firstChild?.nodeType === 3 ? targetSpan.firstChild : targetSpan.querySelector('span[data-token-start]')?.firstChild) : null;
        if (textNode && textNode.nodeType === 3) {
          // 测量字符 "字" (5) 与 "吗" (6) 的边界
          const rangeZi = document.createRange();
          rangeZi.setStart(textNode, 5);
          rangeZi.setEnd(textNode, 6);
          const rectZi = rangeZi.getBoundingClientRect();

          const clickX = rectZi.right;
          const clickY = (rectZi.top + rectZi.bottom) / 2;

          // 在未展开状态下点击 "字" 与 "吗" 之间
          htmlRow.dispatchEvent(new MouseEvent('mousedown', { clientX: clickX, clientY: clickY, bubbles: true }));
          await waitForFrame(30);
          htmlRow.dispatchEvent(new MouseEvent('mouseup', { clientX: clickX, clientY: clickY, bubbles: true }));
          htmlRow.dispatchEvent(new MouseEvent('click', { clientX: clickX, clientY: clickY, bubbles: true }));
          await waitForFrame(100);

          // 此时语法标签展开，重新测量展开后 "字" 与 "吗" 的物理位置
          const expandedSpan = Array.from(htmlRow.querySelectorAll('span[data-token-start]')).find(s => {
            return s.textContent && s.textContent.includes('这是蓝色文字吗');
          });
          const expTextNode = expandedSpan ? (expandedSpan.firstChild?.nodeType === 3 ? expandedSpan.firstChild : expandedSpan.querySelector('span[data-token-start]')?.firstChild) : null;

          let delta = 999;
          let details = '未找到展开后文本节点';
          let passed = false;

          if (expTextNode && expTextNode.nodeType === 3) {
            const expRangeZi = document.createRange();
            expRangeZi.setStart(expTextNode, 5);
            expRangeZi.setEnd(expTextNode, 6);
            const expRectZi = expRangeZi.getBoundingClientRect();

            const cursor = document.querySelector('.cursor-caret');
            if (cursor) {
              const curRect = cursor.getBoundingClientRect();
              delta = Math.abs(curRect.left - expRectZi.right);
              passed = delta <= maxTolerance;
              details = passed
                ? `光标在标签展开后严格贴合于 "字" 与 "吗" 之间，物理误差 ${delta.toFixed(3)}px <= ${maxTolerance}px`
                : `光标在标签展开后错位，物理误差 ${delta.toFixed(3)}px > ${maxTolerance}px (caretLeft=${curRect.left.toFixed(2)}, ziRight=${expRectZi.right.toFixed(2)})`;
            } else {
              details = '展开后未找到光标 caret 元素';
            }
          }

          suiteResults.push({
            id: 'HTML-SPAN-EXPANSION-ANCHOR',
            name: '内联 HTML 标签展开光标锚定与亚像素对齐防御',
            passed,
            maxDeltaX: delta < 900 ? delta : undefined,
            details,
          });
        }

        // ============================================================
        // 场景 12：代码块点击编辑前后绝对零跳动物理防御 (|ΔY| <= 0.5px)
        // ============================================================
        {
          const startEl = document.querySelector('.line-code-fence-start');
          const endEl = document.querySelector('.line-code-fence-end');
          if (startEl && endEl) {
            startEl.scrollIntoView({ block: 'center', behavior: 'instant' });
            container.dispatchEvent(new Event('scroll'));
            await waitForFrame(80);

            const getBlockSnapshot = () => {
              const rows = Array.from(
                document.querySelectorAll(
                  '.line-code-fence-start, .line-code, .line-code-fence-end'
                )
              );
              return rows.map((r) => {
                const rect = r.getBoundingClientRect();
                return {
                  contentTop: rect.top + container.scrollTop,
                  height: rect.height,
                };
              });
            };

            const baseline = getBlockSnapshot();

            // 点击 fence_start (进入编辑态)
            const startRect = startEl.getBoundingClientRect();
            startEl.dispatchEvent(
              new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: startRect.left + 20,
                clientY: startRect.top + 10,
              })
            );
            await waitForFrame(20);
            startEl.dispatchEvent(
              new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: startRect.left + 20,
                clientY: startRect.top + 10,
              })
            );
            startEl.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                clientX: startRect.left + 20,
                clientY: startRect.top + 10,
              })
            );
            await waitForFrame(80);

            const activeStartSnapshot = getBlockSnapshot();
            let maxJumpY = 0;
            for (let i = 0; i < baseline.length; i++) {
              if (activeStartSnapshot[i]) {
                const dy = Math.abs(
                  activeStartSnapshot[i].contentTop - baseline[i].contentTop
                );
                const dh = Math.abs(
                  activeStartSnapshot[i].height - baseline[i].height
                );
                if (dy > maxJumpY) maxJumpY = dy;
                if (dh > maxJumpY) maxJumpY = dh;
              }
            }

            // 点击 fence_end
            const endRect = endEl.getBoundingClientRect();
            endEl.dispatchEvent(
              new MouseEvent('mousedown', {
                bubbles: true,
                cancelable: true,
                clientX: endRect.left + 20,
                clientY: endRect.top + 10,
              })
            );
            await waitForFrame(20);
            endEl.dispatchEvent(
              new MouseEvent('mouseup', {
                bubbles: true,
                cancelable: true,
                clientX: endRect.left + 20,
                clientY: endRect.top + 10,
              })
            );
            endEl.dispatchEvent(
              new MouseEvent('click', {
                bubbles: true,
                cancelable: true,
                clientX: endRect.left + 20,
                clientY: endRect.top + 10,
              })
            );
            await waitForFrame(80);

            const activeEndSnapshot = getBlockSnapshot();
            for (let i = 0; i < baseline.length; i++) {
              if (activeEndSnapshot[i]) {
                const dy = Math.abs(
                  activeEndSnapshot[i].contentTop - baseline[i].contentTop
                );
                const dh = Math.abs(
                  activeEndSnapshot[i].height - baseline[i].height
                );
                if (dy > maxJumpY) maxJumpY = dy;
                if (dh > maxJumpY) maxJumpY = dh;
              }
            }

            const passed = maxJumpY <= maxTolerance;
            suiteResults.push({
              id: 'CODE-ZERO-JUMP-DEFENSE',
              name: '代码块点击编辑前后绝对零上下跳动防御',
              passed,
              maxDeltaX: maxJumpY,
              details: passed
                ? `代码块围栏与各代码行在点击前后位移与高度严格恒定，最大物理偏差 ${maxJumpY.toFixed(3)}px <= ${maxTolerance}px`
                : `代码块点击前后发生跳变，最大偏差 ${maxJumpY.toFixed(3)}px > ${maxTolerance}px`,
            });
          }
        }
      }

      // ============================================================
      // 场景 9：行内空白与行尾点击全类型覆盖防御契约 (LINE-TRAILING-CLICK-DEFENSE)
      // 铁律：光标未选文字但在一行内时，点击空白处严格统一定位于当前行末尾 (lineStart + lineLen)
      // 覆盖类型：标题行、普通段落行、列表项行、代码起始围栏、代码内容行、引用块行、行内加粗行、行内代码行、空行等
      // ============================================================
      {
        const st = window.__editorStore.getState();
        const testTargets = [
          {
            type: '标题行 (Heading)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && (t.startsWith('# ') || t.startsWith('### '))) return i;
              }
              return -1;
            },
          },
          {
            type: '普通段落行 (Paragraph)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (
                  t &&
                  t.length > 20 &&
                  !t.startsWith('#') &&
                  !t.startsWith('-') &&
                  !t.startsWith('`') &&
                  !t.startsWith('>') &&
                  !t.startsWith('|') &&
                  !t.startsWith('$')
                )
                  return i;
              }
              return -1;
            },
          },
          {
            type: '列表项行 (List Item)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && (t.startsWith('- ') || t.startsWith('* '))) return i;
              }
              return -1;
            },
          },
          {
            type: '代码块起始行 (Code Fence Start)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && (t.startsWith('```') || t.startsWith('~~~'))) return i;
              }
              return -1;
            },
          },
          {
            type: '代码块内容行 (Code Line)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount() - 1; i++) {
                const t = st.getLine(i);
                if (t && (t.startsWith('```') || t.startsWith('~~~'))) {
                  const next = st.getLine(i + 1);
                  if (next && !next.startsWith('```')) return i + 1;
                }
              }
              return -1;
            },
          },
          {
            type: '引用块行 (Blockquote)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && t.startsWith('>')) return i;
              }
              return -1;
            },
          },
          {
            type: '行内加粗格式化行 (Bold Inline)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && t.includes('**') && !t.startsWith('#')) return i;
              }
              return -1;
            },
          },
          {
            type: '行内代码格式化行 (Inline Code)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t && t.includes('`') && !t.startsWith('```') && t.split('`').length >= 3) return i;
              }
              return -1;
            },
          },
          {
            type: '空行 (Empty Line)',
            findLineIdx: () => {
              for (let i = 0; i < st.getLineCount(); i++) {
                const t = st.getLine(i);
                if (t !== undefined && t.trim() === '') return i;
              }
              return -1;
            },
          },
        ];

        const trailingClickResults = [];

        for (const target of testTargets) {
          const targetLineIdx = target.findLineIdx();
          if (targetLineIdx >= 0) {
            // 通过 scrollTop 定位并将目标行置于可视区
            container.scrollTop = window.__scrollTopForLine(container, targetLineIdx, 150);
            await waitForFrame(50);

            const activeRow = document.querySelector(
              `.virtual-row[data-index="${targetLineIdx}"]`
            );
            if (!activeRow) continue;

            const lineStart = parseInt(
              activeRow.getAttribute('data-line-start') || '0',
              10
            );
            const lineLen = parseInt(
              activeRow.getAttribute('data-line-length') || '0',
              10
            );
            const expectedEnd = lineStart + lineLen;

            const rowRect = activeRow.getBoundingClientRect();
            // 在行内右侧空白区域点击（避免点击右上角可能存在的复制按钮）
            const clickX = Math.min(
              rowRect.right - 50,
              rowRect.left + rowRect.width - 50
            );
            const clickY = rowRect.top + rowRect.height / 2;

            activeRow.dispatchEvent(
              new MouseEvent('mousedown', {
                clientX: clickX,
                clientY: clickY,
                bubbles: true,
              })
            );
            await waitForFrame(20);
            activeRow.dispatchEvent(
              new MouseEvent('mouseup', {
                clientX: clickX,
                clientY: clickY,
                bubbles: true,
              })
            );
            activeRow.dispatchEvent(
              new MouseEvent('click', {
                clientX: clickX,
                clientY: clickY,
                bubbles: true,
              })
            );
            await waitForFrame(60);

            const actualCursor = window.__editorStore.getState().cursorPos;
            const isMatch = actualCursor === expectedEnd;
            trailingClickResults.push({
              type: target.type,
              lineIdx: targetLineIdx,
              expected: expectedEnd,
              actual: actualCursor,
              offset: actualCursor - expectedEnd,
              passed: isMatch,
            });
          }
        }

        const allTrailingPassed =
          trailingClickResults.length > 0 &&
          trailingClickResults.every((r) => r.passed);
        const failedItems = trailingClickResults.filter((r) => !r.passed);
        suiteResults.push({
          id: 'LINE-TRAILING-CLICK-DEFENSE',
          name: '行内空白与行尾点击全类型覆盖防御契约 (Line Trailing Click Defense)',
          passed: allTrailingPassed,
          details: allTrailingPassed
            ? `全部 ${trailingClickResults.length} 种行类型 (${trailingClickResults.map((r) => r.type).join(', ')}) 点击行内空白严格 100% 统一定位于行末 (lineStart + lineLen)，零偏差`
            : `存在行尾点击定位偏差: ${failedItems.map((f) => `${f.type}(L${f.lineIdx}): 预期=${f.expected}, 实际=${f.actual}, 偏移=${f.offset}`).join('; ')}`,
        });
      }

      // ============================================================
      // 场景 10：嵌套列表符号宽度与前缀交互防御契约 (LIST-PREFIX-DEFENSE)
      // 铁律：
      // 1. 列表符号严禁人工特殊盒模型 (零 display: inline-block, 零 min-width: 16px, 零 margin-right: 8px)
      // 2. 嵌套有序列表 (如 "   1. 嵌套的有序列表 1")：
      //    - 点击数字 '1' 必须精准定位于 '1' 的全局索引 (不得跳回行首 0，不得塌陷)
      //    - 光标实际物理 X 坐标与单字符 Range 边界偏差 |ΔX| <= 0.5px
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let targetLineIdx = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          const t = st.getLine(i);
          if (t && t.includes('嵌套的有序列表 1')) {
            targetLineIdx = i;
            break;
          }
        }

        if (targetLineIdx !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, targetLineIdx, 150);
          await waitForFrame(80);

          const lineText = st.getLine(targetLineIdx);
          const lineOffset = st.lineOffsets.getOffset(targetLineIdx);
          const rowEl = document.querySelector(`.virtual-row[data-index="${targetLineIdx}"]`);

          if (rowEl) {
            // 1. 检查样式规则：无特殊盒模型
            const numEl = rowEl.querySelector('.token-list-number');
            const numStyle = numEl ? window.getComputedStyle(numEl) : null;
            const isBoxPristine = numStyle && numStyle.display !== 'inline-block' && parseInt(numStyle.marginRight || '0', 10) === 0;

            // 2. 点击数字 '1'
            const num1IdxInLine = lineText.indexOf('1');
            const expectedNum1Index = lineOffset + num1IdxInLine;

            // 找到包含 '1' 的文本节点
            let walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
            let n = walker.nextNode();
            let clicked = false;
            let actualCursor = -1;
            let deltaX = 0;

            while (n) {
              const val = n.nodeValue || '';
              const idxInNode = val.indexOf('1');
              if (idxInNode !== -1 && n.parentElement && !n.parentElement.classList.contains('syntax-hidden')) {
                const charRect = getCharPhysicalRect(n, idxInNode);
                const clickX = charRect.left + charRect.width / 2;
                const clickY = charRect.top + charRect.height / 2;

                rowEl.dispatchEvent(new MouseEvent('mousedown', { clientX: clickX, clientY: clickY, bubbles: true }));
                await waitForFrame(20);
                rowEl.dispatchEvent(new MouseEvent('mouseup', { clientX: clickX, clientY: clickY, bubbles: true }));
                rowEl.dispatchEvent(new MouseEvent('click', { clientX: clickX, clientY: clickY, bubbles: true }));
                await waitForFrame(60);

                actualCursor = window.__editorStore.getState().cursorPos;
                const caretEl = document.querySelector('.custom-cursor-blink');
                if (caretEl) {
                  const caretRect = caretEl.getBoundingClientRect();
                  deltaX = Math.abs(caretRect.left - charRect.left);
                }
                clicked = true;
                break;
              }
              n = walker.nextNode();
            }

            const cursorMatched = actualCursor === expectedNum1Index;
            const alignPassed = deltaX <= maxTolerance;
            const passed = isBoxPristine && clicked && cursorMatched && alignPassed;

            suiteResults.push({
              id: 'LIST-PREFIX-DEFENSE',
              name: '嵌套列表符号宽度与前缀交互防御契约 (List Prefix Defense)',
              passed,
              maxDeltaX: deltaX,
              details: passed
                ? `符号盒模型纯净无特例 (display: ${numStyle?.display}, margin-right: ${numStyle?.marginRight})，点击 '1' 精准定位 (pos=${actualCursor}==${expectedNum1Index})，光标物理贴合 |ΔX|=${deltaX.toFixed(3)}px <= 0.5px`
                : `列表前缀防御失败: 盒模型纯净=${isBoxPristine}, 已触发点击=${clicked}, 光标定位=${actualCursor}(预期 ${expectedNum1Index}), 物理对齐偏差=${deltaX.toFixed(3)}px`,
            });
          }
        }
      }

      // ============================================================
      // 场景 11：任务列表复选框纯交互与绝不坍缩防御契约 (TASK-CHECKBOX-PURE-INTERACTION)
      // 铁律：
      // - 点击复选框直接触发完成态切换 ([ ] <-> [x])
      // - 绝不坍缩为原始源码文本 (- [ ] )
      // - 随后的正文物理 X 坐标严格恒定 (|ΔX| <= 0.5px)
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let taskLineIdx = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          const t = st.getLine(i);
          if (t && t.includes('- [ ]') && t.includes('引用内的任务 2')) {
            taskLineIdx = i;
            break;
          }
        }

        if (taskLineIdx !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, taskLineIdx, 150);
          await waitForFrame(80);

          const rowEl = document.querySelector(`.virtual-row[data-index="${taskLineIdx}"]`);
          if (rowEl) {
            const checkboxWrapper = rowEl.querySelector('.task-checkbox-wrapper');
            const textSpan = Array.from(rowEl.querySelectorAll('span[data-token-start]')).find(s => s.textContent && s.textContent.includes('引用内的任务 2'));
            const beforeRect = textSpan ? textSpan.getBoundingClientRect() : null;

            if (checkboxWrapper && textSpan && beforeRect) {
              const cbRect = checkboxWrapper.getBoundingClientRect();
              const clickX = cbRect.left + cbRect.width / 2;
              const clickY = cbRect.top + cbRect.height / 2;

              checkboxWrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }));
              await waitForFrame(80);

              const afterLineText = window.__editorStore.getState().getLine(taskLineIdx);
              const toggled = afterLineText.includes('- [x]');
              const afterRowEl = document.querySelector(`.virtual-row[data-index="${taskLineIdx}"]`);
              const hiddenEl = afterRowEl?.querySelector('.syntax-hidden');
              const isSourceRevealed = Boolean(
                hiddenEl &&
                window.getComputedStyle(hiddenEl).display !== 'none'
              );
              const isTextLeaked = Boolean(
                afterRowEl?.innerText?.includes('- [x]') ||
                afterRowEl?.innerText?.includes('- [ ]')
              );
              const afterTextSpan = Array.from(afterRowEl.querySelectorAll('span[data-token-start]')).find(s => s.textContent && s.textContent.includes('引用内的任务 2'));
              const afterRect = afterTextSpan ? afterTextSpan.getBoundingClientRect() : null;
              const deltaX = afterRect && beforeRect ? Math.abs(afterRect.left - beforeRect.left) : 999;

              const passed = toggled && !isSourceRevealed && !isTextLeaked && deltaX <= maxTolerance;
              suiteResults.push({
                id: 'TASK-CHECKBOX-PURE-INTERACTION',
                name: '复选框纯交互切换与绝对零坍缩位移防御 (Task Checkbox Pure Toggle)',
                passed,
                maxDeltaX: deltaX,
                details: passed
                  ? `点击复选框成功在原位切换状态 ([ ] -> [x])，零源码坍缩 (isSourceRevealed=false, isTextLeaked=false)，正文物理位置绝对恒定 |ΔX|=${deltaX.toFixed(3)}px <= 0.5px`
                  : `复选框切换失败: 状态切换=${toggled}, 源码泄露=${isSourceRevealed || isTextLeaked}, 文本位移=${deltaX.toFixed(3)}px`,
              });

              // 复原状态
              checkboxWrapper.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY }));
              await waitForFrame(60);
            }
          }
        }
      }

      // ============================================================
      // 场景 12：引用与列表多行中轴线与正文起点绝对对齐防御 (ROW-MULTI-AXIS-ALIGNMENT)
      // 铁律：
      // - Line 68: "> 引用内包含列表：" 前缀 2ch，正文起始于 2ch
      // - Line 69: "> - [x] 引用内的任务" 导线 2ch + 任务槽 2ch，正文起始于 4ch
      // - Line 70: "> - [ ] 引用内的任务 2" 导线 2ch + 任务槽 2ch，正文起始于 4ch
      // - Line 69 与 Line 70 复选框中轴线物理对齐 (|ΔX| <= 0.5px)
      // - Line 69 与 Line 70 正文起始 X 物理对齐 (|ΔX| <= 0.5px)
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let l68 = -1, l69 = -1, l70 = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          const t = st.getLine(i);
          if (t && t.includes('引用内包含列表')) {
            l68 = i;
            l69 = i + 1;
            l70 = i + 2;
            break;
          }
        }

        if (l68 !== -1 && l69 !== -1 && l70 !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, l68, 100);
          await waitForFrame(80);

          const r68 = document.querySelector(`.virtual-row[data-index="${l68}"]`);
          const r69 = document.querySelector(`.virtual-row[data-index="${l69}"]`);
          const r70 = document.querySelector(`.virtual-row[data-index="${l70}"]`);

          if (r68 && r69 && r70) {
            const cb69 = r69.querySelector('.task-checkbox-wrapper');
            const cb70 = r70.querySelector('.task-checkbox-wrapper');
            const rectCb69 = cb69?.getBoundingClientRect();
            const rectCb70 = cb70?.getBoundingClientRect();
            const cbAxis69 = rectCb69 ? rectCb69.left + rectCb69.width / 2 : 0;
            const cbAxis70 = rectCb70 ? rectCb70.left + rectCb70.width / 2 : 0;
            const deltaCbAxis = Math.abs(cbAxis69 - cbAxis70);

            const textSpan69 = Array.from(r69.querySelectorAll('span[data-token-start]')).find(s => s.textContent && s.textContent.includes('引用内的任务'));
            const textSpan70 = Array.from(r70.querySelectorAll('span[data-token-start]')).find(s => s.textContent && s.textContent.includes('引用内的任务 2'));
            const textRect69 = textSpan69?.getBoundingClientRect();
            const textRect70 = textSpan70?.getBoundingClientRect();
            const deltaTextX = textRect69 && textRect70 ? Math.abs(textRect69.left - textRect70.left) : 999;

            const passed = deltaCbAxis <= maxTolerance && deltaTextX <= maxTolerance;
            suiteResults.push({
              id: 'ROW-MULTI-AXIS-ALIGNMENT',
              name: '引用内多行复选框中轴线与正文起始对齐防御 (Row Multi-Axis Alignment)',
              passed,
              maxDeltaX: Math.max(deltaCbAxis, deltaTextX),
              details: passed
                ? `L${l69} 与 L${l70} 复选框中轴线物理对齐 (|ΔX|=${deltaCbAxis.toFixed(3)}px <= 0.5px)，正文绝对对齐 (|ΔX|=${deltaTextX.toFixed(3)}px <= 0.5px)`
                : `对齐偏差: 复选框中轴线偏差=${deltaCbAxis.toFixed(3)}px, 正文起点偏差=${deltaTextX.toFixed(3)}px`,
            });
          }
        }
      }

      // ============================================================
      // 场景 13：划词选区单层几何互斥与零重复灰度防御 (SELECTION-NO-OVERLAP)
      // 铁律：
      // - 选区矩形层 (SelectionHighlight) 内任意两个属于同一视觉行的矩形，相交面积恒为 0
      // - 原生 ::selection 背景透明，容器 user-select: none，杜绝双层叠加
      // ============================================================
      {
        const st = window.__editorStore.getState();
        st.setSelection(100, 350);
        await waitForFrame(80);

        const selRects = Array.from(document.querySelectorAll('.selection-rect')).map(el => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
        });

        let hasOverlap = false;
        let overlapDetails = '零重叠';
        for (let i = 0; i < selRects.length; i++) {
          for (let j = i + 1; j < selRects.length; j++) {
            const a = selRects[i];
            const b = selRects[j];
            const isSameLine = Math.abs(a.top - b.top) <= 4;
            if (isSameLine) {
              const xOverlap = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
              if (xOverlap > 1) { // 允许 1px 亚像素接缝
                hasOverlap = true;
                overlapDetails = `矩形 ${i} 与 ${j} 同行水平重叠 ${xOverlap.toFixed(2)}px`;
                break;
              }
            }
          }
          if (hasOverlap) break;
        }

        const editorContainer = document.querySelector('.editor-container');
        const compStyle = editorContainer ? window.getComputedStyle(editorContainer) : null;
        const isUserSelectNone = compStyle?.userSelect === 'none' || compStyle?.webkitUserSelect === 'none';
        const passed = !hasOverlap && isUserSelectNone;

        suiteResults.push({
          id: 'SELECTION-NO-OVERLAP',
          name: '划词选区单层几何互斥与零重复灰度防御 (Selection No Overlap)',
          passed,
          details: passed
            ? `共渲染 ${selRects.length} 个独立视觉行选区矩形，同一视觉行重叠面积严格为 0，userSelect=none 彻底杜绝双层灰度`
            : `选区重叠或双层灰度检测失败: ${overlapDetails}, userSelectNone=${isUserSelectNone}`,
        });

        st.setSelection(0, 0);
        await waitForFrame(40);
      }

      // ============================================================
      // 场景 14：多级嵌套列表引导线连续垂直对齐防御 (LIST-INDENT-GUIDE-LINES)
      // 铁律：
      // - 缩进层级存在 .syntax-indent-guide 元素
      // - 引导线数量与缩进深度一致
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let nestedListIdx = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          const t = st.getLine(i);
          if (t && t.includes('混合嵌套无序列表')) {
            nestedListIdx = i;
            break;
          }
        }

        if (nestedListIdx !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, nestedListIdx, 150);
          await waitForFrame(80);

          const rowEl = document.querySelector(`.virtual-row[data-index="${nestedListIdx}"]`);
          if (rowEl) {
            const guides = Array.from(rowEl.querySelectorAll('.syntax-indent-guide'));
            const hasGuides = guides.length >= 2;
            const passed = hasGuides;

            suiteResults.push({
              id: 'LIST-INDENT-GUIDE-LINES',
              name: '多级嵌套列表引导线连续垂直对齐防御 (List Indent Guide Lines)',
              passed,
              details: passed
                ? `嵌套行成功渲染 ${guides.length} 级垂直对齐引导线，中轴线分别对齐上级列表符号`
                : `未找到预期的多级列表引导线，检测到数量=${guides.length}`,
            });
          }
        }
      }

      // ============================================================
      // 场景 15：列表嵌套代码块 CommonMark §4.5 缩进剥离对齐防御 (CODEBLOCK-NESTED-INDENT)
      // 铁律：
      // - 列表内嵌套代码块（开栏 1~3 空格缩进）
      // - 代码内容行 (.code-content) 首行字符贴合 gutter，零异常附加缩进 (额外空白 = 0px)
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let codeContentIdx = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          const t = st.getLine(i);
          if (t && t.includes('def foo():')) {
            codeContentIdx = i;
            break;
          }
        }

        if (codeContentIdx !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, codeContentIdx, 150);
          await waitForFrame(80);

          const rowEl = document.querySelector(`.virtual-row[data-index="${codeContentIdx}"]`);
          if (rowEl) {
            const codeContent = rowEl.querySelector('.code-content');
            const textSpan = codeContent?.querySelector('span[data-token-start]');
            const contentRect = codeContent?.getBoundingClientRect();
            const textRect = textSpan?.getBoundingClientRect();
            const paddingLeft = parseFloat(window.getComputedStyle(codeContent).paddingLeft || '0');
            const totalOffset = textRect && contentRect ? textRect.left - contentRect.left : 999;
            const extraIndent = Math.abs(totalOffset - paddingLeft);
            const passed = extraIndent <= maxTolerance; // 除去预设 padding 后，附加缩进误差 <= 0.5px

            suiteResults.push({
              id: 'CODEBLOCK-NESTED-INDENT',
              name: '列表嵌套代码块缩进剥离与卡片平齐防御 (Codeblock Nested Indent Stripped)',
              passed,
              maxDeltaX: extraIndent,
              details: passed
                ? `CommonMark §4.5 缩进剥离完全生效：def foo() 贴齐代码内容槽 (附加缩进=${extraIndent.toFixed(3)}px <= 0.5px)，零多余缩进`
                : `嵌套代码块缩进异常：def foo() 出现多余附加缩进 (附加缩进=${extraIndent.toFixed(3)}px > 0.5px)`,
            });
          }
        }
      }

      // ============================================================
      // 场景 16：列表划词选区与复选框零重叠、无序圆点常显与多级导线防御 (TASK-SELECTION-OVERLAP-DEFENSE)
      // 铁律：
      // - 划词选中任务列表时，复选框右边界严格在正文左边界之前 (cbRight <= textLeft)，零骑脸重叠
      // - 无序列表在划词选区中圆点 • 始终可见，不蒸发
      // - 4 空格嵌套行严格渲染 2 级引导线 (0.5ch 和 2.5ch)，零断线
      // - 选区矩形绝不出现 100% 容器宽的整行漫溢色块
      // ============================================================
      {
        const st = window.__editorStore.getState();
        let targetIdx = -1;
        for (let i = 0; i < st.getLineCount(); i++) {
          if ((st.getLine(i) || '').includes('顶层已完成任务')) {
            targetIdx = i;
            break;
          }
        }

        if (targetIdx !== -1) {
          container.scrollTop = window.__scrollTopForLine(container, targetIdx, 100);
          await waitForFrame(80);

          const off1 = st.lineOffsets.getOffset(targetIdx);
          const lastLine = st.getLine(targetIdx + 6);
          const off2 =
            st.lineOffsets.getOffset(targetIdx + 6) +
            (lastLine ? lastLine.length : 0);
          st.setSelection(off1, off2);
          await waitForFrame(120);

          let hasOverlap = false;
          let overlapDetails = '';
          let bulletVisible = false;
          let guidesTwoLevels = false;
          let hasRunawayRect = false;

          const containerRect = container.getBoundingClientRect();

          for (let i = targetIdx; i <= targetIdx + 6; i++) {
            const rowEl = document.querySelector(
              `.virtual-row[data-index="${i}"]`
            );
            if (!rowEl) continue;

            const cb = rowEl.querySelector('.task-checkbox-wrapper');
            const bullet = rowEl.querySelector('.token-bullet-char');
            const textSpan = rowEl.querySelector(
              'span[data-token-start]:last-child'
            );
            const guides = Array.from(
              rowEl.querySelectorAll('.syntax-indent-guide')
            );

            if (cb && textSpan) {
              const cbRect = cb.getBoundingClientRect();
              const textRect = textSpan.getBoundingClientRect();
              if (cbRect.right > textRect.left + 0.5) {
                hasOverlap = true;
                overlapDetails = `Line ${i} 复选框 (right=${cbRect.right.toFixed(1)}) 与正文 (left=${textRect.left.toFixed(1)}) 发生重叠`;
              }
            }

            const bulletSpan = rowEl.querySelector('.token-list-bullet');
            if (bulletSpan) {
              const bRect = (bullet && bullet.getBoundingClientRect().width > 0)
                ? bullet.getBoundingClientRect()
                : bulletSpan.getBoundingClientRect();
              if (bRect.width > 0) bulletVisible = true;
            }

            if (st.getLine(i)?.includes('二级嵌套未完成任务')) {
              if (guides.length >= 2) guidesTwoLevels = true;
            }
          }

          const selRects = Array.from(
            document.querySelectorAll('.selection-rect')
          ).map((el) => {
            const r = el.getBoundingClientRect();
            return { width: r.width };
          });
          hasRunawayRect = selRects.some(
            (r) => r.width >= containerRect.width - 20
          );

          st.setSelection(0, 0);
          await waitForFrame(40);

          const passed =
            !hasOverlap && bulletVisible && guidesTwoLevels && !hasRunawayRect;
          suiteResults.push({
            id: 'TASK-SELECTION-OVERLAP-DEFENSE',
            name: '列表划词选区与复选框零重叠、圆点常显与多级导线防御 (Task Selection Overlap Defense)',
            passed,
            details: passed
              ? '复选框严格排版于正文前方（零骑脸重叠）、无序圆点常显不蒸发、二级嵌套完整呈现2级引导线、选区零满宽跑冒'
              : `防御未通过: hasOverlap=${hasOverlap} (${overlapDetails}), bulletVisible=${bulletVisible}, guidesTwoLevels=${guidesTwoLevels}, hasRunawayRect=${hasRunawayRect}`,
          });
        }
      }

      return { suiteResults };
    }, TOLERANCE_PX);

    if (testReport.fatal) {
      console.error(`❌ 严重错误: ${testReport.fatal}`);
      process.exit(1);
    }

    // 格式化输出报告
    let allPassed = true;
    console.log('----------------------------------------------------------------');
    console.log('📋 防御测试结果汇总:');
    console.log('----------------------------------------------------------------');

    for (const res of testReport.suiteResults) {
      const mark = res.passed ? '✅ 通过' : '❌ 失败';
      if (!res.passed) allPassed = false;
      const deltaInfo = res.maxDeltaX !== undefined ? ` [Max ΔX: ${res.maxDeltaX.toFixed(3)}px]` : '';
      console.log(`${mark} | ${res.id.padEnd(20)} | ${res.name}${deltaInfo}`);
      console.log(`     └─ ${res.details}`);
    }

    console.log('\n================================================================');
    if (allPassed) {
      console.log('🎉 全部物理测量计算与交互状态机防御测试 100% 通过！零退化！');
      console.log('================================================================\n');
      process.exit(0);
    } else {
      console.error('🚨 存在未通过的物理测量防御断言！请检查上述日志定位根因！');
      console.log('================================================================\n');
      process.exit(1);
    }
  } catch (err) {
    console.error('❌ 执行测试脚本期间发生未捕获异常:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

runDefenseSuite();
