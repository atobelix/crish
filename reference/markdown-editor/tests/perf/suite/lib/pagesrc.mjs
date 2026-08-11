// tests/perf/suite/lib/pagesrc.mjs
// 页面探针源码字符串库（Playwright evaluate 执行；从既有四脚本单向提取 +
// 新探针：平滑滚动 ramp / 选区完整性 / 节点身份 / 表格定型 / 内存曲线）。
//
// 约定（与既有脚本一致）：
// - 每个页面函数必须自包含（不引用本模块作用域符号），单对象参数解构；
// - 一律 var 声明、字符串拼接（不用模板串），规避注入层转义风险；
// - 所有计时在页面内 performance.now() 完成，防 Playwright 外部计时污染；
// - 页面函数经 new Function(src + '\nreturn fnName;')() 实例化后
//   page.evaluate(fn, args) 执行（final-verify 同款注入形态）。
//
// 纪律：UTF-8 无 BOM；中文注释；不 commit。

// ---- token 生成器源码（流式注入共用；由 stream-inject-500 GEN_SRC 提取扩展）--
// scenario 取值：
//   plain   纯文本（每 8 个文本 token 附带一个换行，约 62 行/s）
//   fence10 代码 fence 段占 ~10%（每 50 token 进一段 5 token 段）
//   fence30 代码 fence 段占 ~30%（每 12 token 进一段 5 token 段）
//   math5   公式段占 ~5%（每 80 token 进一段 4 token 段）
//   table   表格行流（表头 + 分隔行 + 数据行循环，驱动表格列宽定型热路径）
export const GEN_SRC = `
function createTokenGen(scenario) {
  var words = ['流式','注入','引擎','渲染','性能','帧率','预算','解析','增量','合并','光标','选区','撤销','重做','虚拟','滚动','测量','回填','样本','缓存','线程','提交','布局','绘制','采样','统计','判定','预算','达标','回落'];
  var CODE_SEG = ['\`\`\`js\\n', 'const a = 1;\\n', 'a + b = 3;\\n', 'console.log(a);\\n', '\`\`\`\\n'];
  var MATH_SEG = ['$$\\n', 'x_i^2 + y_i^2 = r^2\\n', '\\\\sum_{i=1}^n i = n(n+1)/2\\n', '$$\\n'];
  var TABLE_SEG = ['| 列A | 列B | 列C |\\n', '| --- | --- | --- |\\n', '| 甲 | 乙 | 丙 |\\n', '| 丁 | 戊 | 己 |\\n', '| 庚 | 辛 | 壬 |\\n'];
  var cfg = null;
  if (scenario === 'fence10') { cfg = { seg: CODE_SEG, every: 50 }; }
  else if (scenario === 'fence30') { cfg = { seg: CODE_SEG, every: 12 }; }
  else if (scenario === 'math5') { cfg = { seg: MATH_SEG, every: 80 }; }
  else if (scenario === 'table') { cfg = { seg: TABLE_SEG, every: 6 }; }
  var seg = cfg ? cfg.seg : null;
  var segEvery = cfg ? cfg.every : 0;
  var segPos = seg ? 0 : null;
  var segAt = -1;
  var n = 0;
  var w = 0;
  var nl = 0;
  var tw = 0;
  return function next() {
    var t;
    if (segPos !== null) {
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else if (seg && n - segAt >= segEvery) {
      segAt = n;
      segPos = 0;
      t = seg[segPos++];
      if (segPos >= seg.length) { segPos = null; }
    } else {
      if (scenario === 'table') {
        tw++;
        t = '| 数据' + tw + '_' + String(tw % 97) + ' | 行' + tw + ' | v' + tw + ' |\\n';
      } else {
        t = words[w++ % words.length];
        nl++;
        if (nl >= 8) { t += '\\n'; nl = 0; }
      }
    }
    n++;
    return t;
  };
}
`;

// ---- 文档构造源码（矩阵场景共用）--------------------------------------------
// 参数：
//   lines     目标行数
//   mixed     1 = 混合行高（每 20 行插一个 h1 标题行，标题 40px 量级）；
//             0 = 标准行高（全正文 28px）
//   density   文档密度轴：plain / fence10 / fence30 / math5（fence 段占比
//             与 GEN_SRC 口径一致，构造期预埋——滚动/注入时触发重放成本）
//   timeoutMs 分块加载超时
// 返回：{ ms, loadedLines, ok, rowHeight }（rowHeight 为实测首行高，供
// M2a/M2b 锚点模型使用）。
export const PAGE_BUILD_DOC_SRC = `
async function pageBuildDoc(args) {
  var lines = args.lines;
  var mixed = args.mixed ? 1 : 0;
  var density = args.density || 'plain';
  var timeoutMs = args.timeoutMs || 120000;
  var store = window.__CRISH_SESSION_STORE__;
  var arr = new Array(lines);
  var f1 = 'L';
  for (var i = 0; i < lines; i++) {
    var isTitle = mixed && i > 0 && i % 20 === 0;
    var isFenceOpen = false;
    if (density === 'fence10') { isFenceOpen = i > 0 && i % 45 === 0; }
    else if (density === 'fence30') { isFenceOpen = i > 0 && i % 12 === 0; }
    else if (density === 'math5') { isFenceOpen = i > 0 && i % 80 === 0; }
    if (isTitle) {
      arr[i] = '# 标题行 ' + i;
    } else if (isFenceOpen) {
      var code = (density === 'math5')
        ? ['$$', 'x_i^2 + y_i^2 = r^2', '\\\\sum_{i=1}^n i = n(n+1)/2', '$$']
        : ['\`\`\`js', 'const a = ' + i + ';', 'const b = a * 2;', '\`\`\`'];
      var segLines = '';
      for (var k = 0; k < code.length; k++) segLines += code[k] + '\\n';
      segLines += f1 + i + '_' + i;
      arr[i] = segLines;
    } else {
      arr[i] = f1 + i + '_'.repeat(20) + i;
    }
  }
  var text = arr.join('\\n');
  var t0 = performance.now();
  store.getState().setText(text);
  var syncMs = performance.now() - t0;
  var waitT0 = performance.now();
  var got = 0;
  while (true) {
    got = store.getState().lines.length;
    if (got >= lines) break;
    if (performance.now() - waitT0 > timeoutMs) break;
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { requestAnimationFrame(r); });
  var rowHeight = 28;
  var scroller = document.querySelector('.editor-scroll-container');
  var first = scroller ? scroller.querySelector('[data-index="0"]') : null;
  if (first) rowHeight = Math.round(first.getBoundingClientRect().height) || 28;
  return {
    ms: performance.now() - waitT0,
    syncMs: Number(syncMs.toFixed(2)),
    loadedLines: got,
    ok: got >= lines,
    rowHeight: rowHeight,
  };
}
`;

// ---- M2a/M2c 平滑滚动 ramp 探针源码（核心关切：跳动相对脱节口径）------------
// 口径（review-P3 维度 4 修订落地）：
// - 每帧 scrollTop += rampPx（默认 120px @60Hz ≈ 7200px/s 匀速）；
// - actualDelta = 滚动容器真实位移（滚动条侧）；
// - anchorDelta = 锚点行（视口垂直中部 [data-index] 行，切换见采样循环）
//   视口内位移（内容侧）；
// - 稳态期望两者均 ≈ rampPx；**跳动 = 内容与滚动条脱节**（相对脱节）：
//   relErr = |anchorDelta - actualDelta| > REL_TOL 即脱节（0 容忍判定主指标）；
//   掉帧（双峰 120/240）时两侧同步放大，relErr 仍 ≈ 0 → 不误报
//   （headless 防抖动核心）；
// - 绝对突变 jumpErr / freeze 序列为报告项（证据链，不判 FAIL）；
// - 同帧内嵌 M1a rAF JS 段近似（t0→t1）与 M1c longtask 观察。
// 参数：{ durationMs, rampPx, relTolPx, jumpTolPx, scrollStartRatio }
// 返回：帧率统计 + 跳动判定数据 + jsPhaseMs + longTasks。
export const PAGE_RAMP_SCROLL_SRC = `
async function pageRampScroll(args) {
  var durationMs = args.durationMs || 3000;
  var rampPx = args.rampPx || 120;
  var relTolPx = args.relTolPx || 2;
  var jumpTolPx = args.jumpTolPx || 8;
  var scrollStartRatio = (args.scrollStartRatio === undefined) ? 0.3 : args.scrollStartRatio;
  var scroller = document.querySelector('.editor-scroll-container');
  var maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.round(maxTop * scrollStartRatio);
  var intervals = [];
  var jsPhaseMs = [];
  var last = null;
  var prevTop = scroller.scrollTop;
  var anchorIdx = -1;
  var anchorTop = 0;
  var relDetachCount = 0;
  var maxRelErrPx = 0;
  var jumpCount = 0;
  var maxJumpErrPx = 0;
  var freezeFrames = 0;
  var freezeTimestamps = [];
  var lastFreeze = -1;
  var anchorSamples = 0;
  var anchorSwitchFrames = 0;
  var longTasks = [];
  var ltObserver = null;
  try {
    ltObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) longTasks.push(entries[i].duration);
    });
    ltObserver.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  var start = performance.now();
  await new Promise(function (resolve) {
    var step = function () {
      var now = performance.now();
      if (last !== null) intervals.push(now - last);
      last = now;
      var t0 = performance.now();
      var prev = prevTop;
      scroller.scrollTop = Math.min(scroller.scrollTop + rampPx, maxTop);
      var actualDelta = scroller.scrollTop - prev;
      prevTop = scroller.scrollTop;
      // 锚点行跟踪：优先沿用上一帧锚点行（按 data-index 定位），其滚出
      // 视口（rect.bottom ≤ 0 / rect.top ≥ 视口高）或已卸载时才切换。
      // 锚点选「视口垂直中部行」而非首可见行——ramp 120px/帧 下行高 28px
      // 的首可见行 1 帧即滚出视口 → 恒切换 → 零采样（首跑实测
      // anchorSamples=0 / 181 帧，suite/README.md 异常登记 ②）；中部行需
      // 约半视口高度 ÷ rampPx 帧才滚出，期间连续采样，样本量显著 > 0。
      var anchorEl = null;
      if (anchorIdx >= 0) {
        anchorEl = scroller.querySelector('[data-index="' + anchorIdx + '"]');
        if (anchorEl) {
          var rKeep = anchorEl.getBoundingClientRect();
          if (rKeep.bottom <= 0 || rKeep.top >= scroller.clientHeight) anchorEl = null;
        }
      }
      if (!anchorEl) {
        var els = scroller.querySelectorAll('[data-index]');
        var midY = scroller.clientHeight / 2;
        var bestEl = null;
        var bestDist = Infinity;
        for (var i = 0; i < els.length; i++) {
          var r = els[i].getBoundingClientRect();
          if (r.bottom <= 0 || r.top >= scroller.clientHeight) continue;
          var c = (r.top + r.bottom) / 2;
          var d = c >= midY ? c - midY : midY - c;
          if (d < bestDist) { bestDist = d; bestEl = els[i]; }
        }
        anchorEl = bestEl;
        if (anchorEl) anchorSwitchFrames++;
      }
      if (anchorEl) {
        var idx = parseInt(anchorEl.getAttribute('data-index'), 10);
        var top = anchorEl.getBoundingClientRect().top;
        if (idx === anchorIdx) {
          var anchorDelta = anchorTop - top;
          anchorSamples++;
          var relErr = Math.abs(anchorDelta - actualDelta);
          if (relErr > relTolPx) relDetachCount++;
          if (relErr > maxRelErrPx) maxRelErrPx = relErr;
          var jumpErr = Math.abs(actualDelta - rampPx);
          if (jumpErr > jumpTolPx) jumpCount++;
          if (jumpErr > maxJumpErrPx) maxJumpErrPx = jumpErr;
          if (actualDelta < 2) {
            freezeFrames++;
            if (freezeFrames - lastFreeze > 1) { lastFreeze = freezeFrames; freezeTimestamps.push(Number((now - start).toFixed(0))); }
            else lastFreeze = freezeFrames;
          }
        }
        anchorIdx = idx;
        anchorTop = top;
      }
      jsPhaseMs.push(performance.now() - t0);
      if (now - start < durationMs) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  if (ltObserver) { try { ltObserver.disconnect(); } catch (e) {} }
  var sorted = intervals.slice().sort(function (a, b) { return a - b; });
  var ltTotal = 0;
  var ltMax = 0;
  for (var j = 0; j < longTasks.length; j++) { ltTotal += longTasks[j]; if (longTasks[j] > ltMax) ltMax = longTasks[j]; }
  return {
    durationMs: durationMs,
    rampPx: rampPx,
    frames: {
      count: intervals.length,
      p50: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] : NaN,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : NaN,
      p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : NaN,
      mean: intervals.length ? intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length : NaN,
      over16_7: intervals.filter(function (v) { return v > 16.7; }).length,
      over33_3: intervals.filter(function (v) { return v > 33.3; }).length,
    },
    jsPhaseMs: jsPhaseMs,
    ramp: {
      anchorSamples: anchorSamples,
      anchorSwitchFrames: anchorSwitchFrames,
      relDetachCount: relDetachCount,
      maxRelErrPx: Number(maxRelErrPx.toFixed(2)),
      jumpCount: jumpCount,
      maxJumpErrPx: Number(maxJumpErrPx.toFixed(2)),
      freezeFrames: freezeFrames,
      freezeTimestampsMs: freezeTimestamps,
    },
    longTasks: {
      count: longTasks.length,
      totalMs: Number(ltTotal.toFixed(2)),
      maxMs: Number(ltMax.toFixed(2)),
    },
    error: null,
  };
}
`;

// ---- M2b 滚动条/内容一致性探针源码（20 位置采样，01 §5.2 P1 落地）------------
// 参数：{ rowHeight, mixed }
// 判定口径（引擎行定位存在系统偏移——B1 scrollMap 内容高度接管引入的
// 恒定位移，实测 ~3686px——线性绝对模型不适用，改用**相邻位置差分预测**：
// predicted_i = firstIdx_{i-1} + round(ΔscrollTop / rowHeight)，误差 =
// |firstIdx_i - predicted_i|——系统偏移在差分中完全抵消，测的是「行高
// 模型精度」（M2b 语义本体：行高模型预测 vs 实际渲染首行的一致性）。
// - 标准行高（mixed=0）：差分误差 P95 ≤ 1 行（阈值在 budgets）；
// - 混合行高（mixed=1）：线性行高不适用，差分预测用「上一位置实测行距」
//   推进（行距 = ΔscrollTop / Δindex，滑动平均），误差作报告项；
//   主判定改为首行索引单调性 + scrollHeight 恒定。
// scrollHeightError = |模型总高 - 物理 scrollHeight| / 模型总高（报告项；
// 含系统偏移时如实反映，不掩盖）。
export const PAGE_M2B_SRC = `
async function pageM2bConsistency(args) {
  var rowHeight = args.rowHeight || 28;
  var mixed = args.mixed ? 1 : 0;
  var scroller = document.querySelector('.editor-scroll-container');
  var docLines = window.__CRISH_SESSION_STORE__.getState().getLineCount();
  var maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var samples = [];
  var scrollHeights = [];
  var prevIdx = -1;
  var monotonic = true;
  var positions = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95];
  var lastIdx = null;
  var lastTop = null;
  var lastRowDist = rowHeight; // 混合模式滑动平均行距
  for (var p = 0; p < positions.length; p++) {
    var target = Math.round(maxTop * positions[p] / 100);
    scroller.scrollTop = target;
    await new Promise(function (r) { requestAnimationFrame(r); });
    await new Promise(function (r) { requestAnimationFrame(r); });
    var els = scroller.querySelectorAll('[data-index]');
    var firstIdx = -1;
    for (var i = 0; i < els.length; i++) {
      var r = els[i].getBoundingClientRect();
      if (r.bottom > 0 && r.top < scroller.clientHeight) { firstIdx = parseInt(els[i].getAttribute('data-index'), 10); break; }
    }
    if (firstIdx < prevIdx) monotonic = false;
    prevIdx = firstIdx;
    var err = null;
    var predicted = null;
    if (lastIdx !== null && firstIdx >= 0) {
      if (!mixed) {
        var deltaScroll = scroller.scrollTop - lastTop;
        predicted = lastIdx + Math.round(deltaScroll / rowHeight);
        err = Math.abs(firstIdx - predicted);
      } else {
        // 混合模式：用上一位置实测行距推进预测（滑动平均），误差作报告项
        var idxDelta = firstIdx - lastIdx;
        if (idxDelta > 0) lastRowDist = (scroller.scrollTop - lastTop) / idxDelta;
        predicted = lastIdx + Math.round((scroller.scrollTop - lastTop) / lastRowDist);
        err = Math.abs(firstIdx - predicted);
      }
    }
    lastIdx = firstIdx;
    lastTop = scroller.scrollTop;
    scrollHeights.push(scroller.scrollHeight);
    samples.push({ pos: positions[p], scrollTop: scroller.scrollTop, firstIdx: firstIdx, predicted: predicted, errorRows: err });
  }
  var minH = Math.min.apply(null, scrollHeights);
  var maxH = Math.max.apply(null, scrollHeights);
  var modelTotal = rowHeight * docLines;
  var scrollHeightError = Math.abs(modelTotal - scroller.scrollHeight) / modelTotal;
  var errors = [];
  for (var s = 0; s < samples.length; s++) {
    if (samples[s].errorRows !== null) errors.push(samples[s].errorRows);
  }
  errors.sort(function (a, b) { return a - b; });
  return {
    docLines: docLines,
    rowHeight: rowHeight,
    mixed: mixed,
    samples: samples,
    scrollHeightSpreadPx: maxH - minH,
    scrollHeightErrorPct: Number((scrollHeightError * 100).toFixed(2)),
    anchorRowErrorP95: errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * 0.95))] : null,
    anchorRowErrorMax: errors.length ? errors[errors.length - 1] : null,
    monotonic: monotonic,
    error: null,
  };
}
`;

// ---- M3 选区完整性探针源码（直刷期间选区丢失，0 容忍）----------------------
// 口径（A6 §2.3 页面探针通道）：
// - 建立真实 DOM 选区（选中可见行内一段文本，参考模型 = 选中文本切片）；
// - 流式纯文本注入驱动直刷路径（dirty 行命令式写 textContent）；
// - 每帧比对 document.getSelection()：rangeCount、anchorNode 归属、所选
//   文本 = 参考模型切片；任一不一致 = 一次「选区中断」事件（lostActive
//   标志去重，恢复一致后重置）；
// - directFlushChunkCount：注入期间「末行文本增长」事件数（直刷 chunk
//   近似口径，MutationObserver characterData 观察末行 token span）；
// - 引擎登记点探测：window.__CRISH_METRICS__.recordSelectionLost 存在则
//   读取差值作补充通道（engineProbe='wired'），否则 pending（待接线）。
// 参数：{ durationMs, tps, selLine, selLen }
export const PAGE_SELECTION_SRC = `
async function pageSelectionProbe(args) {
  var durationMs = args.durationMs || 6000;
  var tps = args.tps || 500;
  var selLine = args.selLine || 3;
  var selLen = args.selLen || 12;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var initLines = [];
  for (var i = 0; i < 100; i++) initLines.push('直刷选区基准第' + i + '行：稳定文本内容，用于选区中断检测。');
  var initText = initLines.join('\\n');
  get().setText(initText);
  var deadline = performance.now() + 10000;
  while (get().getLineCount() !== 100 && performance.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  var scroller = document.querySelector('.editor-scroll-container');
  // 先滚动到底部：使流式追加的脏行（index ≥100）进入视口触发直刷路径；
  // 选区随后建立在视口底部行（index 97→99 跨行），与脏行相邻但不重叠
  // （直刷写目标为脏行自身；选区跨直刷行的前置静态建立不可行——新行
  // 尚未挂载——本探针测「直刷期间既有选区完整性」的代理口径，见 README）。
  // 滚动到底部（目标 = 当前 maxTop）。引擎在文档变更后可能异步复位
  // 滚动位置（实测踩坑：setText 后 2 rAF 内设置 scrollTop 被复位为 0，
  // 且与前一场景文档规模相关）——轮询重试直到读回值稳定在目标附近，
  // 不依赖时序猜测。
  var targetTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var stable = false;
  var scrollRetries = 0;
  while (!stable && scrollRetries < 50) {
    scroller.scrollTop = targetTop;
    await new Promise(function (r) { setTimeout(r, 100); });
    stable = Math.abs(scroller.scrollTop - targetTop) < 2;
    scrollRetries++;
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { requestAnimationFrame(r); });
  // 轮询等待目标行挂载（虚拟化滚动更新是异步的，固定帧数等待间歇性
  // 失败——上次全档跑实测 index 97 行 2 帧后仍未挂载，踩坑记录）；
  // 5s 超时仍未挂载则如实标记探针失效。
  var rowEl = null;
  var mountDeadline = performance.now() + 5000;
  while (!rowEl && performance.now() < mountDeadline) {
    rowEl = scroller.querySelector('[data-index="' + selLine + '"]');
    if (!rowEl) await new Promise(function (r) { setTimeout(r, 50); });
  }
  var refText = null;
  if (rowEl) {
    var range = document.createRange();
    range.selectNodeContents(rowEl);
    var len = Math.min(selLen, range.endOffset - range.startOffset);
    var startOff = Math.floor((range.endOffset - range.startOffset) / 2) - Math.floor(len / 2);
    if (startOff < 0) startOff = 0;
    var r2 = document.createRange();
    r2.setStart(rowEl, startOff);
    r2.setEnd(rowEl, startOff + len);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r2);
    refText = sel.toString();
  }
  var flushChunks = 0;
  var mountedRows = 0;
  var lastRowCount = -1;
  var lastTailLen = -1;
  // 直刷 chunk 判定（A6 §2.3：store.getLine(lastIdx) 未变而 DOM token span
  // textContent 增长）：帧采样对比「视口内最后一个 data-token-start span
  // 的文本长度」——增长即一次直刷写。不用 MutationObserver 观察全容器
  // （流式渲染下回调风暴会饿死主线程，实测卡死，教训）。
  var lostCount = 0;
  var lostActive = false;
  var lostDiag = [];
  // 口径（A6 §2.3「每直刷 chunk 后快照比对」）：
  // 仅在「直刷写（token span 文本增长）之后」的帧验证选区——虚拟化卸载
  // 视口外行导致的选区失效是滚动/卸载的正常语义，不属于直刷破坏，
  // 不得计入丢失（防误报）；直刷写后选区若损坏才记一次中断。
  var check = function () {
    var rows = scroller.querySelectorAll('[data-index]');
    var rowCount = rows.length;
    if (lastRowCount < 0) lastRowCount = rowCount;
    if (rowCount > lastRowCount) mountedRows += rowCount - lastRowCount;
    lastRowCount = rowCount;
    var tailLen = 0;
    if (rows.length > 0) {
      var lastRowEl = rows[rows.length - 1];
      var span = lastRowEl.querySelector('[data-token-start]');
      if (span && span.firstChild && span.firstChild.nodeType === 3) tailLen = span.firstChild.textContent.length;
    }
    var sinceFlush = 0;
    if (lastTailLen >= 0 && tailLen > lastTailLen) { flushChunks++; sinceFlush = 1; }
    lastTailLen = tailLen;
    if (sinceFlush <= 0) return;
    var sel2 = window.getSelection();
    var txt = null;
    var rangeCount = sel2 ? sel2.rangeCount : 0;
    if (sel2 && sel2.rangeCount === 1) txt = sel2.toString();
    var anchorInDoc = sel2 && sel2.anchorNode ? (sel2.anchorNode.parentNode ? sel2.anchorNode.parentNode.ownerDocument === document : false) : false;
    var ok = txt === refText && anchorInDoc;
    if (!ok) {
      if (!lostActive) {
        lostCount++;
        lostActive = true;
        lostDiag.push({
          flushIndex: flushChunks,
          rangeCount: rangeCount,
          anchorInDoc: anchorInDoc,
          textMatch: txt === refText,
          txtLen: txt === null ? -1 : txt.length,
          refLen: refText === null ? -1 : refText.length,
        });
      }
    } else {
      lostActive = false;
    }
  };
  var engineBefore = null;
  var engineProbe = 'pending';
  try {
    if (typeof window.__CRISH_METRICS__.recordSelectionLost === 'function') {
      engineBefore = 0;
      engineProbe = 'wired';
    }
  } catch (e) {}
  var buf = '';
  var bufActive = false;
  var rafId = null;
  var t0 = performance.now();
  var stepMs = 1000 / tps;
  var injected = 0;
  var stopped = false;
  var injectTimer = setInterval(function () {
    if (stopped) { clearInterval(injectTimer); return; }
    var now = performance.now();
    var target = Math.floor((now - t0) / stepMs);
    while (injected < target) {
      buf += '新流入行内容追加' + injected + '，填充直刷热路径。';
      injected++;
      if (injected % 4 === 0) buf += '\\n';
    }
    if (now - t0 >= durationMs) {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      if (buf) { get().appendText(buf); buf = ''; }
    }
  }, 1);
  await new Promise(function (resolve) {
    var step = function () {
      if (buf && !bufActive) {
        bufActive = true;
        var c = buf;
        buf = '';
        rafId = requestAnimationFrame(function () {
          get().appendText(c);
          bufActive = false;
        });
      }
      check();
      if (!stopped) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  get().flushStreamTail();
  var engineLost = null;
  if (engineProbe === 'wired') {
    try { engineLost = window.__CRISH_METRICS__.recordSelectionLost - engineBefore; } catch (e) {}
  }
  return {
    refText: refText,
    selectionLostCount: lostCount,
    lostDiagnostics: lostDiag,
    engineSelectionLost: engineLost,
    engineProbe: engineProbe,
    directFlushChunkCount: flushChunks,
    mountedRows: mountedRows,
    lossRate: flushChunks > 0 ? Number((lostCount / flushChunks).toFixed(4)) : null,
    textMatch: get().verifyConsistency(),
    error: refText === null ? '目标行未挂载，选区未建立（探针失效）' : null,
  };
}
`;

// ---- M4 补全闪烁探针源码（完成态切换存量行节点身份比对，0 容忍）------------
// 口径（A6 §2.4）：
// - 流式收口（= streamEnd 语义，flushStreamTail）前一帧快照窗口内
//   每行 [data-index] → element 节点身份；
// - 收口后两帧再快照；remountedCount = 存量行中 oldEl !== newEl 数
//   （理想 0——同一节点仅样式/类切换，软渲染视觉稳定化验收面）；
// - MutationObserver 统计收口窗口 addedNodes 总数与「流式新增行数」
//   （addedNodes 中带 data-index 且不在快照中的 = 新行；允许挂载，禁止
//   存量行重建——A6 §2.4 完成帧新增节点 ≤ 实际新增行数）。
// 参数：{ injectMs, tps, initLines }
export const PAGE_COMPLETION_SRC = `
async function pageCompletionProbe(args) {
  var injectMs = args.injectMs || 4000;
  var tps = args.tps || 500;
  var initLines = args.initLines || 2000;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var arr = new Array(initLines);
  for (var i = 0; i < initLines; i++) arr[i] = '完成态基准第' + i + '行：软渲染切换观察目标。';
  var initText = arr.join('\\n');
  get().setText(initText);
  var deadline = performance.now() + 30000;
  while (get().getLineCount() !== initLines && performance.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  var scroller = document.querySelector('.editor-scroll-container');
  // 滚动到底部（同 PAGE_SELECTION_SRC 口径：引擎文档变更后异步复位滚动，
  // 轮询重试直到稳定，不依赖时序猜测）
  var targetTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var stable = false;
  var scrollRetries = 0;
  while (!stable && scrollRetries < 50) {
    scroller.scrollTop = targetTop;
    await new Promise(function (r) { setTimeout(r, 100); });
    stable = Math.abs(scroller.scrollTop - targetTop) < 2;
    scrollRetries++;
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { requestAnimationFrame(r); });
  var words = ['流式','注入','完成','闪烁','检测','基准','补全','渲染'];
  var w = 0;
  var buf = '';
  var bufActive = false;
  var rafId = null;
  var t0 = performance.now();
  var stepMs = 1000 / tps;
  var injected = 0;
  var stopped = false;
  var injectTimer = setInterval(function () {
    if (stopped) { clearInterval(injectTimer); return; }
    var now = performance.now();
    var target = Math.floor((now - t0) / stepMs);
    while (injected < target) {
      buf += words[w++ % words.length];
      injected++;
      if (injected % 8 === 0) buf += '\\n';
    }
    if (now - t0 >= injectMs) {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      if (buf) { get().appendText(buf); buf = ''; }
    }
  }, 1);
  await new Promise(function (resolve) {
    var step = function () {
      if (buf && !bufActive) {
        bufActive = true;
        var c = buf;
        buf = '';
        rafId = requestAnimationFrame(function () {
          get().appendText(c);
          bufActive = false;
        });
      }
      if (!stopped) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  var snapBefore = {};
  var rowsBefore = scroller.querySelectorAll('[data-index]');
  for (var b = 0; b < rowsBefore.length; b++) {
    var elB = rowsBefore[b];
    snapBefore[elB.getAttribute('data-index')] = elB;
  }
  var addedNodesTotal = 0;
  var mo = null;
  try {
    mo = new MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var nodes = muts[m].addedNodes;
        for (var n = 0; n < nodes.length; n++) {
          if (nodes[n].nodeType === 1) addedNodesTotal++;
        }
      }
    });
    mo.observe(scroller, { subtree: true, childList: true });
  } catch (e) {}
  get().flushStreamTail();
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { requestAnimationFrame(r); });
  if (mo) { try { mo.disconnect(); } catch (e) {} }
  var snapAfter = {};
  var rowsAfter = scroller.querySelectorAll('[data-index]');
  var addedRows = 0;
  for (var a = 0; a < rowsAfter.length; a++) {
    var elA = rowsAfter[a];
    var idxA = elA.getAttribute('data-index');
    snapAfter[idxA] = elA;
    if (!(idxA in snapBefore)) addedRows++;
  }
  var remountedCount = 0;
  var remounted = [];
  for (var idx in snapBefore) {
    if (!(idx in snapAfter)) continue;
    if (snapBefore[idx] !== snapAfter[idx]) { remountedCount++; remounted.push(idx); }
  }
  return {
    remountedCount: remountedCount,
    remountedIndexes: remounted.slice(0, 10),
    addedNodesTotal: addedNodesTotal,
    addedRows: addedRows,
    addedNodesWithinBudget: addedNodesTotal <= addedRows + 2,
    injectedTokens: injected,
    textMatch: get().verifyConsistency(),
    error: null,
  };
}
`;

// ---- M5 内存曲线探针源码（堆曲线 + GC 后稳态 + 循环泄漏门禁）----------------
// 口径（A6 §2.5 / G9）：
// - 每轮：注入 durationMs → 空闲 idleMs（堆 1s 采样取空闲最小值 = GC 后稳态）；
// - rounds 轮后稳态增量 = (末轮空闲 min - 首轮空闲 min) / 首轮空闲 min；
// - 堆采样 1s 间隔（performance.memory，非 Chromium 环境 null 降级）；
// - 强制 GC 由 runner 侧 CDP HeapProfiler.collectGarbage 执行（防串扰），
//   页面内不再自行触发（浏览器无页面级 collectGarbage API）。
// 参数：{ scenario, durationMs, idleMs, tps, rounds }
export const PAGE_MEMORY_SRC = `
async function pageMemoryCycle(args) {
  var scenario = args.scenario || 'plain';
  var durationMs = args.durationMs || 30000;
  var idleMs = args.idleMs || 3000;
  var tps = args.tps || 500;
  var rounds = args.rounds || 3;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var heapSupported = false;
  try { if (performance.memory && performance.memory.usedJSHeapSize) heapSupported = true; } catch (e) {}
  var sampleHeap = function () {
    if (!heapSupported) return null;
    try { return performance.memory.usedJSHeapSize / 1048576; } catch (e) { return null; }
  };
  var createTokenGen = eval('(' + ${JSON.stringify(GEN_SRC)} + ')');
  var roundResults = [];
  var streamTail = '';
  var runInjection = function (tokens) {
    var buf = '';
    var bufActive = false;
    var rafId = null;
    var t0 = performance.now();
    var stepMs = 1000 / tps;
    var injected = 0;
    var stopped = false;
    return new Promise(function (resolve) {
      var injectTimer = setInterval(function () {
        if (stopped) { clearInterval(injectTimer); return; }
        var now = performance.now();
        var target = Math.floor((now - t0) / stepMs);
        while (injected < target) {
          var t = tokens();
          buf += t;
          streamTail += t;
          injected++;
        }
        if (now - t0 >= durationMs) {
          stopped = true;
          if (rafId !== null) cancelAnimationFrame(rafId);
          rafId = null;
          if (buf) { get().appendText(buf); buf = ''; }
          resolve(injected);
        }
      }, 1);
    });
  };
  for (var round = 0; round < rounds; round++) {
    var curve = [];
    var heapTimer = null;
    if (heapSupported) {
      heapTimer = setInterval(function () {
        var v = sampleHeap();
        if (v !== null) curve.push(v);
      }, 1000);
    }
    var startMB = sampleHeap();
    var gen = createTokenGen(scenario);
    var injectedCount = await runInjection(gen);
    if (heapTimer) clearInterval(heapTimer);
    var endMB = sampleHeap();
    var idleMin = null;
    if (heapSupported) {
      idleMin = endMB;
      var idleUntil = performance.now() + idleMs;
      while (performance.now() < idleUntil) {
        var v = sampleHeap();
        if (v !== null && v < idleMin) idleMin = v;
        await new Promise(function (r) { setTimeout(r, 200); });
      }
    }
    var peakMB = curve.length ? Math.max.apply(null, curve) : null;
    if (peakMB !== null && endMB !== null && endMB > peakMB) peakMB = endMB;
    roundResults.push({
      round: round + 1,
      startMB: startMB !== null ? Number(startMB.toFixed(1)) : null,
      peakMB: peakMB !== null ? Number(peakMB.toFixed(1)) : null,
      endMB: endMB !== null ? Number(endMB.toFixed(1)) : null,
      idleMinMB: idleMin !== null ? Number(idleMin.toFixed(1)) : null,
      growthMB: (startMB !== null && endMB !== null) ? Number((endMB - startMB).toFixed(1)) : null,
      injectedTokens: injectedCount,
    });
  }
  get().flushStreamTail();
  var r0 = roundResults[0];
  var rLast = roundResults[roundResults.length - 1];
  var steadyGrowthPct = null;
  if (rounds >= 2 && r0.idleMinMB !== null && rLast.idleMinMB !== null && r0.idleMinMB > 0) {
    steadyGrowthPct = Number(((rLast.idleMinMB - r0.idleMinMB) / r0.idleMinMB * 100).toFixed(2));
  }
  return {
    heapSupported: heapSupported,
    rounds: roundResults,
    steadyGrowthPct: steadyGrowthPct,
    textMatch: get().verifyConsistency(),
    error: null,
  };
}
`;

// ---- M6 表格流式探针源码（列宽定型计数，首采定档）--------------------------
// 口径（A6 §2.6，W3-3 更新）：
// - 计数来源优先引擎侧登记点 window.__CRISH_TABLE_SETTLE__（W3-3 接线：
//   src/core/tableSettle.ts，MarkdownEngine 三处 setTableWidths 调用点
//   recordTableWidthSettle）——引擎权威计数，无需页面侧包装；旧构建
//   （无该钩子）回退包装 window.__CRISH_TABLE_STORE__ 的
//   setColumnWidth/setTableWidths（zustand setState 替换 action，原闭包
//   行为不变——纯页面侧计数）；
// - perTableSettles = 每表调用次数 - 1（首次定型 = 首挂载，之后每次修正
//   计一次「定型修正」）；
// - 表格 DOM 宽度变化 >1px 次数（MutationObserver attribute style）；
// - 注入期间每 2s 滚动到文档中部（首个表格块保持在视口附近）。
// 参数：{ durationMs, tps, initLines }
export const PAGE_TABLE_SRC = `
async function pageTableStream(args) {
  var durationMs = args.durationMs || 20000;
  var tps = args.tps || 500;
  var initLines = args.initLines || 2000;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  var arr = new Array(initLines);
  for (var i = 0; i < initLines; i++) arr[i] = '表格流式前置文档第' + i + '行：稳定正文内容。';
  var initText = arr.join('\\n');
  get().setText(initText);
  var deadline = performance.now() + 30000;
  while (get().getLineCount() !== initLines && performance.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 15); });
  }
  await new Promise(function (r) { requestAnimationFrame(r); });
  var settleCounts = {};
  var tableStore = window.__CRISH_TABLE_STORE__;
  var origCW = tableStore.getState().setColumnWidth;
  var origTW = tableStore.getState().setTableWidths;
  try {
    tableStore.setState({
      setColumnWidth: function (tid, ci, w) {
        var rec = settleCounts[tid] || { calls: 0 };
        rec.calls++;
        settleCounts[tid] = rec;
        return origCW(tid, ci, w);
      },
      setTableWidths: function (tid, ws) {
        var rec = settleCounts[tid] || { calls: 0 };
        rec.calls++;
        settleCounts[tid] = rec;
        return origTW(tid, ws);
      },
    });
  } catch (e) {
    return { error: '表格 store 包装失败：' + e.message, settleCounts: {}, widthChanges: 0, injectedTokens: 0, injectedRows: 0, textMatch: false };
  }
  var widthChanges = 0;
  var mo = null;
  try {
    mo = new MutationObserver(function (muts) {
      for (var m = 0; m < muts.length; m++) {
        var mt = muts[m];
        if (mt.type === 'attributes' && mt.attributeName === 'style') {
          var el = mt.target;
          var cur = el;
          var inTable = false;
          while (cur && cur !== document.body) {
            if (cur.classList && (cur.classList.contains('line-table') || cur.classList.contains('line-table-row') || cur.classList.contains('line-table-separator'))) { inTable = true; break; }
            cur = cur.parentElement;
          }
          if (inTable) widthChanges++;
        }
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
  } catch (e) {}
  var createTokenGen = eval('(' + ${JSON.stringify(GEN_SRC)} + ')');
  var gen = createTokenGen('table');
  var buf = '';
  var bufActive = false;
  var rafId = null;
  var injectedRows = 0;
  var t0 = performance.now();
  var stepMs = 1000 / tps;
  var injected = 0;
  var stopped = false;
  var scroller = document.querySelector('.editor-scroll-container');
  // 尾部跟随：表格行追加在文档末尾，滚动到末尾使表格块持续进入视口
  // 渲染（TableStore.setColumnWidth 在表格渲染路径调用——视口外不渲染
  // 即不计数，实测踩坑：视口固定中部时 tableCount=0）
  var midTimer = setInterval(function () {
    if (stopped) { clearInterval(midTimer); return; }
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  }, 2000);
  var injectTimer = setInterval(function () {
    if (stopped) { clearInterval(injectTimer); return; }
    var now = performance.now();
    var target = Math.floor((now - t0) / stepMs);
    while (injected < target) {
      var t = gen();
      if (t.charAt(0) === '|') injectedRows++;
      buf += t;
      injected++;
    }
    if (now - t0 >= durationMs) {
      stopped = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = null;
      if (buf) { get().appendText(buf); buf = ''; }
      if (midTimer) clearInterval(midTimer);
    }
  }, 1);
  await new Promise(function (resolve) {
    var step = function () {
      if (buf && !bufActive) {
        bufActive = true;
        var c = buf;
        buf = '';
        rafId = requestAnimationFrame(function () {
          get().appendText(c);
          bufActive = false;
        });
      }
      if (!stopped) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
  get().flushStreamTail();
  if (mo) { try { mo.disconnect(); } catch (e) {} }
  // W3-3：计数来源优先引擎登记点（window.__CRISH_TABLE_SETTLE__ 只读钩子，
  // 见 src/core/tableSettle.ts）——引擎侧三处 setTableWidths 调用点登记，
  // 无需页面包装；旧构建（钩子缺失）回退包装计数 settleCounts。
  var engineSettles = null;
  if (typeof window.__CRISH_TABLE_SETTLE__ !== 'undefined' &&
      window.__CRISH_TABLE_SETTLE__ &&
      window.__CRISH_TABLE_SETTLE__.perTable) {
    engineSettles = window.__CRISH_TABLE_SETTLE__.perTable;
  }
  var perTable = {};
  var maxCorrections = 0;
  var tableCount = 0;
  var source = engineSettles || settleCounts;
  for (var tid in source) {
    // 引擎登记值为原始计数（数字）；包装计数形状为 { calls: n }
    var calls = engineSettles ? source[tid] : source[tid].calls;
    var corrections = Math.max(0, calls - 1);
    perTable[tid] = { calls: calls, settles: corrections };
    if (corrections > maxCorrections) maxCorrections = corrections;
    tableCount++;
  }
  return {
    tableCount: tableCount,
    perTableSettles: perTable,
    maxTableSettles: maxCorrections,
    widthChanges: widthChanges,
    injectedTokens: injected,
    injectedTableRows: injectedRows,
    textMatch: get().verifyConsistency(),
    tableWidthKeys: Object.keys(tableStore.getState().tableWidths || {}).length,
    settleSource: engineSettles ? 'engine' : 'wrapper',
    error: null,
  };
}
`;

// ---- 矩阵流式注入探针源码（M1 + M2c 滚动并发 + chunk + 文本一致性）---------
// 结构（复用 R3-D 骨架，A6 §3.2 矩阵「滚动中注入」轴）：
//  1. setText(initText) 重置并等待落定；
//  2. 注入调度：setInterval(1ms) + 时间戳驱动 500tps，token 经内联
//     StreamBuffer（rAF 合并）→ 每帧 1 chunk → appendText；
//  3. 帧采样 rAF 循环：帧间隔（M1 帧率）+ JS 段近似（M1a）+
//     longtask 观察（M1c）+ 堆 1s 采样（M5 曲线附加）+ chunk 计时；
//  4. rampPx > 0 时开启 M2c：每帧 scrollTop += rampPx 匀速滚动并发，
//     anchorDelta vs actualDelta 相对脱节检测（与 PAGE_RAMP_SCROLL 同口径）；
//  5. durationMs 后停止 → flushStreamTail（= streamEnd 语义）→ 校验
//     （文本模型一致 / verifyConsistency）。
// 参数：{ scenario, initText, durationMs, tps, rampPx, relTolPx, jumpTolPx }
export const PAGE_STREAM_SRC = `
async function pageStream(args) {
  var scenario = args.scenario || 'plain';
  var initText = args.initText || '';
  var durationMs = args.durationMs || 10000;
  var tps = args.tps || 500;
  var rampPx = args.rampPx || 0;
  var relTolPx = args.relTolPx || 2;
  var jumpTolPx = args.jumpTolPx || 8;
  var store = window.__CRISH_SESSION_STORE__;
  var get = function () { return store.getState(); };
  // 空 initText = 保持当前文档（矩阵场景在 buildDoc 构造的文档上追加流式
  // 内容——setText('') 会触发宿主「空文档」分支卸载 MarkdownEngine，
  // 导致滚动容器消失，实测踩坑）；非空时重置并等待落定。
  if (initText.length > 0) {
    var initLines = initText.split('\\n').length;
    get().setText(initText);
    var deadline = performance.now() + 30000;
    while (get().getLineCount() !== initLines && performance.now() < deadline) {
      await new Promise(function (r) { setTimeout(r, 15); });
    }
    await new Promise(function (r) { requestAnimationFrame(r); });
  } else {
    // 文本一致性参考模型：注入前快照当前文档全文
    initText = get().getText();
  }
  var createTokenGen = eval('(' + ${JSON.stringify(GEN_SRC)} + ')');
  var gen = createTokenGen(scenario);
  var modelStream = '';
  var tokenCount = 0;
  var buf = '';
  var rafId = null;
  var bufActive = false;
  var chunkMs = [];
  var push = function (t) {
    if (!t) return;
    buf += t;
    if (!bufActive) {
      bufActive = true;
      rafId = requestAnimationFrame(function () {
        var c = buf;
        buf = '';
        bufActive = false;
        rafId = null;
        var t0 = performance.now();
        get().appendText(c);
        chunkMs.push(performance.now() - t0);
      });
    }
  };
  var flushBuf = function () {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    bufActive = false;
    if (buf) {
      var c = buf;
      buf = '';
      var t0 = performance.now();
      get().appendText(c);
      chunkMs.push(performance.now() - t0);
    }
  };
  var longTasks = [];
  var ltObserver = null;
  try {
    ltObserver = new PerformanceObserver(function (list) {
      var entries = list.getEntries();
      for (var i = 0; i < entries.length; i++) longTasks.push(entries[i].duration);
    });
    ltObserver.observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  var heapSamples = [];
  var heapTimer = null;
  var heapStartMB = null;
  try {
    heapStartMB = performance.memory.usedJSHeapSize / 1048576;
    heapTimer = setInterval(function () {
      try { heapSamples.push(performance.memory.usedJSHeapSize / 1048576); } catch (e) {}
    }, 1000);
  } catch (e) {}
  var scroller = document.querySelector('.editor-scroll-container');
  var maxTop = Math.max(1, scroller.scrollHeight - scroller.clientHeight);
  var intervals = [];
  var jsPhaseMs = [];
  var last = null;
  var prevTop = scroller.scrollTop;
  var anchorIdx = -1;
  var anchorTop = 0;
  var relDetachCount = 0;
  var maxRelErrPx = 0;
  var jumpCount = 0;
  var maxJumpErrPx = 0;
  var freezeFrames = 0;
  var anchorSamples = 0;
  var anchorSwitchFrames = 0;
  var stopped = false;
  var t0 = performance.now();
  var stepMs = 1000 / tps;
  var injected = 0;
  var injectTimer = setInterval(function () {
    if (stopped) { clearInterval(injectTimer); return; }
    var now = performance.now();
    var target = Math.floor((now - t0) / stepMs);
    while (injected < target) {
      var t = gen();
      push(t);
      modelStream += t;
      tokenCount++;
      injected++;
    }
    if (now - t0 >= durationMs) {
      stopped = true;
      if (heapTimer) clearInterval(heapTimer);
      flushBuf();
    }
  }, 1);
  await new Promise(function (resolve) {
    var frameStep = function () {
      var now = performance.now();
      if (last !== null) intervals.push(now - last);
      last = now;
      var tt0 = performance.now();
      if (rampPx > 0) {
        var prev = prevTop;
        scroller.scrollTop = Math.min(scroller.scrollTop + rampPx, maxTop);
        var actualDelta = scroller.scrollTop - prev;
        prevTop = scroller.scrollTop;
        // 锚点行跟踪：优先沿用上一帧锚点行（按 data-index 定位），其滚出
        // 视口（rect.bottom ≤ 0 / rect.top ≥ 视口高）或已卸载时才切换。
        // 锚点选「视口垂直中部行」而非首可见行——ramp 120px/帧 下行高
        // 28px 的首可见行 1 帧即滚出视口 → 恒切换 → 零采样（首跑实测
        // anchorSamples=0，suite/README.md 异常登记 ②，与
        // PAGE_RAMP_SCROLL_SRC 同口径修复）。
        var anchorEl = null;
        if (anchorIdx >= 0) {
          anchorEl = scroller.querySelector('[data-index="' + anchorIdx + '"]');
          if (anchorEl) {
            var rKeep = anchorEl.getBoundingClientRect();
            if (rKeep.bottom <= 0 || rKeep.top >= scroller.clientHeight) anchorEl = null;
          }
        }
        if (!anchorEl) {
          var els = scroller.querySelectorAll('[data-index]');
          var midY = scroller.clientHeight / 2;
          var bestEl = null;
          var bestDist = Infinity;
          for (var i = 0; i < els.length; i++) {
            var r = els[i].getBoundingClientRect();
            if (r.bottom <= 0 || r.top >= scroller.clientHeight) continue;
            var c = (r.top + r.bottom) / 2;
            var d = c >= midY ? c - midY : midY - c;
            if (d < bestDist) { bestDist = d; bestEl = els[i]; }
          }
          anchorEl = bestEl;
          if (anchorEl) anchorSwitchFrames++;
        }
        if (anchorEl) {
          var idx = parseInt(anchorEl.getAttribute('data-index'), 10);
          var top = anchorEl.getBoundingClientRect().top;
          if (idx === anchorIdx) {
            var anchorDelta = anchorTop - top;
            anchorSamples++;
            var relErr = Math.abs(anchorDelta - actualDelta);
            if (relErr > relTolPx) relDetachCount++;
            if (relErr > maxRelErrPx) maxRelErrPx = relErr;
            var jumpErr = Math.abs(actualDelta - rampPx);
            if (jumpErr > jumpTolPx) jumpCount++;
            if (jumpErr > maxJumpErrPx) maxJumpErrPx = jumpErr;
            if (actualDelta < 2) freezeFrames++;
          }
          anchorIdx = idx;
          anchorTop = top;
        }
      }
      jsPhaseMs.push(performance.now() - tt0);
      if (!stopped) requestAnimationFrame(frameStep);
      else resolve();
    };
    requestAnimationFrame(frameStep);
  });
  flushBuf();
  get().flushStreamTail();
  await new Promise(function (r) { requestAnimationFrame(r); });
  await new Promise(function (r) { setTimeout(r, 50); });
  if (ltObserver) { try { ltObserver.disconnect(); } catch (e) {} }
  var s = get();
  var finalText = s.getText();
  var expected = initText + modelStream;
  var textMatch = finalText === expected;
  var heapEndMB = null;
  var heapPeakMB = heapSamples.length ? Math.max.apply(null, heapSamples) : null;
  try { heapEndMB = performance.memory.usedJSHeapSize / 1048576; } catch (e) {}
  var ltTotalMs = 0;
  var ltMaxMs = 0;
  for (var i = 0; i < longTasks.length; i++) { ltTotalMs += longTasks[i]; if (longTasks[i] > ltMaxMs) ltMaxMs = longTasks[i]; }
  var sorted = intervals.slice().sort(function (a, b) { return a - b; });
  return {
    scenario: scenario,
    injectedTokens: tokenCount,
    textMatch: textMatch,
    consistency: s.verifyConsistency(),
    frames: {
      count: intervals.length,
      p50: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.5))] : NaN,
      p95: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] : NaN,
      p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : NaN,
      mean: intervals.length ? intervals.reduce(function (a, b) { return a + b; }, 0) / intervals.length : NaN,
      over16_7: intervals.filter(function (v) { return v > 16.7; }).length,
      over33_3: intervals.filter(function (v) { return v > 33.3; }).length,
    },
    jsPhaseMs: jsPhaseMs,
    ramp: (rampPx > 0) ? {
      anchorSamples: anchorSamples,
      anchorSwitchFrames: anchorSwitchFrames,
      relDetachCount: relDetachCount,
      maxRelErrPx: Number(maxRelErrPx.toFixed(2)),
      jumpCount: jumpCount,
      maxJumpErrPx: Number(maxJumpErrPx.toFixed(2)),
      freezeFrames: freezeFrames,
    } : null,
    longTasks: {
      count: longTasks.length,
      totalMs: Number(ltTotalMs.toFixed(2)),
      maxMs: Number(ltMaxMs.toFixed(2)),
    },
    heap: {
      startMB: heapStartMB !== null ? Number(heapStartMB.toFixed(1)) : null,
      peakMB: heapPeakMB !== null ? Number(heapPeakMB.toFixed(1)) : null,
      endMB: heapEndMB !== null ? Number(heapEndMB.toFixed(1)) : null,
    },
    chunkMs: {
      count: chunkMs.length,
      p50: (function (a) { if (!a.length) return NaN; var x = a.slice().sort(function (p, q) { return p - q; }); return x[Math.min(x.length - 1, Math.floor(x.length * 0.5))]; })(chunkMs),
      p95: (function (a) { if (!a.length) return NaN; var x = a.slice().sort(function (p, q) { return p - q; }); return x[Math.min(x.length - 1, Math.floor(x.length * 0.95))]; })(chunkMs),
    },
    error: null,
  };
}
`;

// ---- 页面函数源码索引（runner/scenarios 统一取用）---------------------------
// 每个条目：{ name: 页面函数名, src: 源码字符串 }；经
// new Function(src + '\nreturn ' + name + ';')() 实例化（final-verify 同款）。
export const PAGE_FUNCS = [
  { name: 'pageBuildDoc', src: PAGE_BUILD_DOC_SRC },
  { name: 'pageRampScroll', src: PAGE_RAMP_SCROLL_SRC },
  { name: 'pageM2bConsistency', src: PAGE_M2B_SRC },
  { name: 'pageStream', src: PAGE_STREAM_SRC },
  { name: 'pageSelectionProbe', src: PAGE_SELECTION_SRC },
  { name: 'pageCompletionProbe', src: PAGE_COMPLETION_SRC },
  { name: 'pageMemoryCycle', src: PAGE_MEMORY_SRC },
  { name: 'pageTableStream', src: PAGE_TABLE_SRC },
];

/**
 * 实例化全部页面函数（在 runner/scenarios 侧调用一次，复用实例）。
 * 返回 { pageBuildDoc, pageRampScroll, ... }；实例化失败即抛错（语法
 * 校验点：node --check 只查本文件外壳，页面函数语法在此实例化时暴露）。
 */
export function instantiatePageFuncs() {
  const fns = {};
  for (const { name, src } of PAGE_FUNCS) {
    fns[name] = new Function(src + '\nreturn ' + name + ';')();
  }
  return fns;
}
