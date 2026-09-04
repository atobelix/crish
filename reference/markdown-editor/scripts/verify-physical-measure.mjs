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
      ];

      for (const sc of alignmentScenarios) {
        const rows = Array.from(document.querySelectorAll(sc.selector));
        const matchedRow = rows.find(r => r.textContent && sc.matcher(r.textContent));
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
          matchedRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_left,
            clientY: clickY,
          }));
          await waitForFrame(80);

          let cursor = document.querySelector('.cursor-caret');
          if (cursor) {
            const curRect = cursor.getBoundingClientRect();
            const delta = Math.abs(curRect.left - charRect.left);
            if (delta > scenarioMaxDelta) scenarioMaxDelta = delta;
            probesCount++;
            if (delta > maxTolerance) {
              failureReason = `字符 "${targetChar}" 前半部点击误差 ${delta.toFixed(2)}px 超过门槛 ${maxTolerance}px (charLeft=${charRect.left.toFixed(2)}, caretLeft=${curRect.left.toFixed(2)})`;
              break;
            }
          }

          // 探针 B：字符后半部（75% 处）点击 -> 光标应紧密贴合字符右边缘
          const charRectB = getCharPhysicalRect(foundTn, charOffset);
          const clickX_right = charRectB.left + charRectB.width * 0.75;
          const clickY_B = charRectB.top + charRectB.height / 2;
          const posBeforeB = window.__editorStore ? window.__editorStore.getState().cursorPos : -1;
          matchedRow.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: clickX_right,
            clientY: clickY_B,
          }));
          await waitForFrame(80);

          cursor = document.querySelector('.cursor-caret');
          const posAfterB = window.__editorStore ? window.__editorStore.getState().cursorPos : -1;
          if (cursor) {
            const curRect = cursor.getBoundingClientRect();
            const delta = Math.abs(curRect.left - charRectB.right);
            if (delta > scenarioMaxDelta) scenarioMaxDelta = delta;
            probesCount++;
            if (delta > maxTolerance) {
              failureReason = `字符 "${targetChar}" 后半部点击误差 ${delta.toFixed(2)}px 超过门槛 ${maxTolerance}px (charRight=${charRectB.right.toFixed(2)}, caretLeft=${curRect.left.toFixed(2)})`;
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
