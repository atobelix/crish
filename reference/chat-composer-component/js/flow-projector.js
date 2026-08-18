/**
 * flow-projector.js
 * Phase 0–1 叙事投影层：MessageToolCall[] / demo blocks → FlowNode 树。
 * 依赖（可选）：window.ToolPresentation（tool-presentation.js）
 * 规格：CONVERSATION_FLOW_SPEC.md §4 / §5 / §10
 */
(function () {
  'use strict';

  var DEFAULT_PURPOSE_WINDOW_MS = 30000;

  function tp() {
    return window.ToolPresentation || {};
  }

  function clip(text, max) {
    var T = tp();
    if (typeof T.clip === 'function') return T.clip(text, max);
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + '…';
  }

  function basename(p) {
    var T = tp();
    if (typeof T.basename === 'function') return T.basename(p);
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/');
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function extractPath(args) {
    var T = tp();
    if (typeof T.extractPath === 'function') return T.extractPath(args);
    return '';
  }

  function extractCommand(args) {
    var T = tp();
    if (typeof T.extractCommand === 'function') return T.extractCommand(args);
    return '';
  }

  function toolHumanLabel(tc) {
    var T = tp();
    if (typeof T.toolHumanLabel === 'function') return T.toolHumanLabel(tc);
    return (tc && tc.name) || '工具';
  }

  function toolVerbBase(tc) {
    var T = tp();
    if (typeof T.toolVerb === 'function') {
      var v = T.toolVerb(tc);
      if (v) return v;
    }
    return inferVerbFromName(tc && tc.name);
  }

  function toolObjectLabel(tc) {
    var T = tp();
    if (typeof T.toolObjectLabel === 'function') return T.toolObjectLabel(tc);
    return extractPath(tc && tc.arguments) || '';
  }

  function formatDiffStat(tc) {
    var T = tp();
    if (typeof T.formatDiffStat === 'function') return T.formatDiffStat(tc);
    if (tc && tc.diffStat) return tc.diffStat;
    return null;
  }

  function toolHasExpandableBody(tc) {
    var T = tp();
    if (typeof T.toolHasExpandableBody === 'function') return T.toolHasExpandableBody(tc);
    return Boolean(tc && tc.output && String(tc.output).trim());
  }

  function isShellName(name) {
    var T = tp();
    if (typeof T.isShellName === 'function') return T.isShellName(name);
    var n = (name || '').toLowerCase();
    return n === 'shell' || n === 'bash' || n.includes('shell') || n.includes('terminal') || n === 'run_terminal_cmd';
  }

  function isEditName(name) {
    var T = tp();
    if (typeof T.isEditName === 'function') return T.isEditName(name);
    var n = (name || '').toLowerCase();
    return n.includes('edit') || n.includes('write') || n.includes('replace') || n === 'search_replace';
  }

  function isReadName(name) {
    var T = tp();
    if (typeof T.isReadName === 'function') return T.isReadName(name);
    var n = (name || '').toLowerCase();
    return n.includes('read') || n.includes('view') || n === 'open_file';
  }

  function isSearchName(name) {
    var T = tp();
    if (typeof T.isSearchName === 'function') return T.isSearchName(name);
    var n = (name || '').toLowerCase();
    if (isEditName(n)) return false;
    return n.includes('grep') || n.includes('search') || n === 'rg';
  }

  function isListName(name) {
    var T = tp();
    if (typeof T.isListName === 'function') return T.isListName(name);
    var n = (name || '').toLowerCase();
    return n.includes('list') || n.includes('glob') || n.includes('dir');
  }

  function isGenericExplanationSpam(text) {
    var T = tp();
    if (typeof T.isGenericExplanationSpam === 'function') return T.isGenericExplanationSpam(text);
    var t = String(text || '').trim();
    if (!t) return true;
    if (/^(正在)?(查看|浏览|修改|搜索|访问|读取|写入|列出|创建|运行)(文件|目录|代码|网络|内容|命令|工具)?$/.test(t)) {
      return true;
    }
    if (/^正在?(查看|浏览|修改|搜索|访问|读取|写入|运行)\s+\S{1,80}$/.test(t)) return true;
    if (/^(创建目录|列出目录|列出目录内容|运行命令|运行终端命令|查看文件内容|查看文件|修改文件|写入文件|切换工作目录)(\s+\S+)?$/.test(t)) {
      return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  kind / verb tense                                                  */
  /* ------------------------------------------------------------------ */

  function inferVerbFromName(name) {
    var n = (name || '').toLowerCase();
    if (isEditName(n)) {
      if (/\bwrite\b/.test(n) || n.includes('create') || n === 'write_file') return '写入';
      return '修改';
    }
    if (isReadName(n)) return '查看';
    if (isListName(n)) return '浏览';
    if (isSearchName(n)) return '搜索';
    if (isShellName(n)) return '运行';
    if (n.includes('web') || n.includes('fetch')) return '访问';
    if (n.includes('subagent')) return '协作';
    return '处理';
  }

  function verbFamily(verb) {
    var v = String(verb || '');
    // 统一到基础动词族，便于 30s 窗口合并
    if (/查看|读取|read|浏览|list/.test(v)) return 'inspect';
    if (/修改|写入|edit|write|替换/.test(v)) return 'edit';
    if (/搜索|grep|search/.test(v)) return 'search';
    if (/运行|执行|shell|test|类型/.test(v)) return 'shell';
    if (/访问|网络|fetch/.test(v)) return 'web';
    if (/协作|subagent/.test(v)) return 'subagent';
    return v || 'other';
  }

  function tensedVerb(baseVerb, status) {
    var base = baseVerb || '处理';
    if (status === 'running') {
      if (base.indexOf('正在') === 0) return base;
      return '正在' + base;
    }
    if (status === 'error') {
      // 错误态仍用完成式动词 + status 表达失败，避免「正在」误导
      return pastVerb(base);
    }
    return pastVerb(base);
  }

  function pastVerb(base) {
    var b = String(base || '').replace(/^正在/, '');
    var map = {
      查看: '已查看',
      运行: '已运行',
      修改: '已修改',
      搜索: '已搜索',
      浏览: '已浏览',
      写入: '已写入',
      访问: '已访问',
      协作: '已协作',
      处理: '已处理',
      读取: '已查看',
      执行: '已运行',
    };
    if (map[b]) return map[b];
    if (b.indexOf('已') === 0) return b;
    return '已' + b;
  }

  function actionKind(tc) {
    var name = (tc && tc.name) || '';
    var n = name.toLowerCase();
    if (n.includes('skill') || (tc && tc.skillId)) return 'skill';
    if (n.includes('mcp') || (tc && tc.mcpServer)) return 'mcp';
    if (isEditName(name)) return 'edit';
    if (isShellName(name)) return 'shell';
    if (isSearchName(name)) return 'search';
    if (isReadName(name) || isListName(name)) return 'file';
    return 'other';
  }

  /* ------------------------------------------------------------------ */
  /*  purpose key / normalize                                            */
  /* ------------------------------------------------------------------ */

  function simpleHash(str) {
    var s = String(str || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0;
    }
    return 'p-' + (h >>> 0).toString(36);
  }

  /**
   * normalizePurpose：去「正在」、丢 spam、截断 80 字。
   */
  function normalizePurpose(raw) {
    var t = String(raw || '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t) return '';
    t = t.replace(/^正在/, '');
    if (isGenericExplanationSpam(t) || isGenericExplanationSpam('正在' + t)) {
      return '';
    }
    // 去掉过短的模板噪声
    if (t.length < 2) return '';
    return clip(t, 80);
  }

  function resolvePrimary(tc) {
    if (!tc) return '执行工具调用';
    if (tc.purposePrimary && String(tc.purposePrimary).trim()) {
      return clip(String(tc.purposePrimary).trim().replace(/^正在/, ''), 80);
    }
    var fromExp = normalizePurpose(tc.explanation);
    if (fromExp) return fromExp;
    var human = toolHumanLabel(tc);
    var normHuman = normalizePurpose(human) || human;
    return clip(normHuman || '执行工具调用', 80);
  }

  function purposeKeyFor(tc) {
    if (tc && tc.purposeId && String(tc.purposeId).trim()) {
      return String(tc.purposeId).trim();
    }
    var primary =
      (tc && tc.purposePrimary && String(tc.purposePrimary).trim()) ||
      normalizePurpose(tc && tc.explanation) ||
      normalizePurpose(toolHumanLabel(tc)) ||
      toolHumanLabel(tc) ||
      (tc && tc.name) ||
      'tool';
    return simpleHash(normalizePurpose(primary) || primary);
  }

  function toolTimeMs(tc) {
    if (!tc) return 0;
    if (typeof tc.startedAt === 'number') return tc.startedAt;
    if (typeof tc.completedAt === 'number') return tc.completedAt;
    return 0;
  }

  function shouldMergeIntoCurrent(current, tc, purposeKey, windowMs) {
    if (!current) return false;
    // 显式 purposeId / 相同 hash key → 合并
    if (current.purposeKey === purposeKey) return true;

    // 启发式：同动词族 + 时间窗 + 归一化说明一致（无显式 purposeId 时）
    if (tc.purposeId || current.explicitId) return false;

    var baseVerb = toolVerbBase(tc);
    var fam = verbFamily(baseVerb);
    if (fam !== current.verbFamily) return false;

    var t = toolTimeMs(tc);
    var lastT = current.lastTime || current.firstTime || 0;
    if (t && lastT && Math.abs(t - lastT) > windowMs) return false;

    var normA = normalizePurpose(tc.purposePrimary || tc.explanation || toolHumanLabel(tc));
    var normB = normalizePurpose(current.primary);
    if (normA && normB && normA === normB) return true;

    return false;
  }

  function aggregatePurposeStatus(actions) {
    if (!actions || !actions.length) return 'success';
    var hasRunning = false;
    var hasError = false;
    var hasSuccess = false;
    for (var i = 0; i < actions.length; i++) {
      var s = actions[i].status;
      if (s === 'running') hasRunning = true;
      else if (s === 'error') hasError = true;
      else if (s === 'success') hasSuccess = true;
    }
    if (hasRunning) return 'running';
    if (hasError && hasSuccess) return 'partial';
    if (hasError) return 'error';
    return 'success';
  }

  /* ------------------------------------------------------------------ */
  /*  ActionNode                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Build ActionNode from one tool call (uses ToolPresentation when present).
   */
  function toActionNode(tc) {
    if (!tc) {
      return {
        id: 'unknown',
        toolName: 'tool',
        verb: '已处理',
        objectLabel: '',
        status: 'success',
        kind: 'other',
        expandable: false,
      };
    }

    var name = tc.name || 'tool';
    var base = toolVerbBase(tc);
    var path = extractPath(tc.arguments || '') || undefined;
    var command = isShellName(name) ? extractCommand(tc.arguments || '') || undefined : undefined;
    // 非 shell 也保留 command 供展开（若 extractCommand 有值且不同于 path）
    if (!command) {
      var cmd = extractCommand(tc.arguments || '');
      if (cmd && isShellName(name)) command = cmd;
    }
    if (isShellName(name)) {
      command = extractCommand(tc.arguments || '') || command;
    }

    var kind = actionKind(tc);
    // Search patterns must not be treated as openable project paths
    var resolvedPath = path;
    if (kind === 'search') {
      resolvedPath = undefined;
    }

    var node = {
      id: tc.id || 'tc-' + simpleHash(name + String(path || '')),
      toolName: name,
      verb: tensedVerb(base, tc.status),
      objectLabel: toolObjectLabel(tc) || '',
      status: tc.status || 'success',
      kind: kind,
      expandable: toolHasExpandableBody(tc),
    };

    if (resolvedPath) node.path = resolvedPath;
    // Keep pattern for search in objectLabel only
    if (kind === 'search' && path && !node.objectLabel) {
      node.objectLabel = path;
    }
    if (command) node.command = command;
    if (tc.output != null) node.output = tc.output;
    var ds = formatDiffStat(tc);
    if (ds) node.diffStat = ds;
    if (tc.skillId) node.skillId = tc.skillId;
    if (tc.mcpServer) node.mcpServer = tc.mcpServer;
    if (typeof tc.startedAt === 'number') node.startedAt = tc.startedAt;
    if (typeof tc.completedAt === 'number') node.completedAt = tc.completedAt;
    if (tc.explanation) node.explanation = tc.explanation;
    if (tc.turnId) node.turnId = tc.turnId;
    if (tc.parallelGroupId) node.parallelGroupId = tc.parallelGroupId;

    return node;
  }

  /* ------------------------------------------------------------------ */
  /*  pending_approval                                                   */
  /* ------------------------------------------------------------------ */

  /**
   * Extract pending_approval tools — NOT in purpose tree (SPEC §5.4).
   */
  function extractPendingApprovals(toolCalls) {
    var list = toolCalls || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var tc = list[i];
      if (!tc || tc.status !== 'pending_approval') continue;
      var cmd = extractCommand(tc.arguments || '') || '';
      out.push({
        id: tc.id || 'approval-' + i,
        summary: toolHumanLabel(tc) || tc.explanation || tc.name || '需要确认',
        command: cmd,
        risk: tc.risk,
        toolName: tc.name || 'tool',
        toolCall: tc,
      });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /*  projectPurposes                                                    */
  /* ------------------------------------------------------------------ */

  /**
   * Project MessageToolCall[] → PurposeNode[] (SPEC §5.3)
   * options: { purposeWindowMs?: number } default 30000
   */
  function projectPurposes(toolCalls, options) {
    var opts = options || {};
    var windowMs =
      typeof opts.purposeWindowMs === 'number' ? opts.purposeWindowMs : DEFAULT_PURPOSE_WINDOW_MS;
    var list = toolCalls || [];
    var purposes = [];
    var current = null;
    // turnId → parallelGroupId 分配
    var turnGroupMap = {};
    var groupSeq = 0;

    function flush() {
      if (!current) return;
      current.status = aggregatePurposeStatus(current.actions);
      if (current.secondary && !current.secondary.length) delete current.secondary;
      purposes.push({
        kind: 'purpose',
        id: current.id,
        primary: current.primary,
        secondary: current.secondary,
        status: current.status,
        actions: current.actions,
      });
      current = null;
    }

    function startPurpose(tc, purposeKey) {
      var primary = resolvePrimary(tc);
      var base = toolVerbBase(tc);
      var nodeId =
        purposeKey.indexOf('purpose-') === 0 || purposeKey.indexOf('p-') === 0
          ? purposeKey
          : 'purpose-' + purposeKey;
      current = {
        id: nodeId,
        purposeKey: purposeKey,
        explicitId: Boolean(tc.purposeId),
        primary: primary,
        secondary: [],
        actions: [],
        verbFamily: verbFamily(base),
        firstTime: toolTimeMs(tc),
        lastTime: toolTimeMs(tc),
        status: 'success',
      };
      if (tc.purposeSecondary) {
        current.secondary.push(String(tc.purposeSecondary));
      }
    }

    for (var i = 0; i < list.length; i++) {
      var tc = list[i];
      if (!tc) continue;
      if (tc.status === 'pending_approval') continue;

      var purposeKey = purposeKeyFor(tc);

      if (!current || !shouldMergeIntoCurrent(current, tc, purposeKey, windowMs)) {
        flush();
        startPurpose(tc, purposeKey);
      } else {
        // 已有 current：补充 secondary
        if (tc.purposeSecondary) {
          var sec = String(tc.purposeSecondary);
          if (current.secondary.indexOf(sec) === -1) current.secondary.push(sec);
        }
        // 若当前 primary 是弱 humanize，而新 tool 有更强 purposePrimary，可升级
        if (tc.purposePrimary && String(tc.purposePrimary).trim()) {
          var stronger = clip(String(tc.purposePrimary).trim().replace(/^正在/, ''), 80);
          if (stronger && stronger.length >= (current.primary || '').length) {
            current.primary = stronger;
          }
        }
      }

      var action = toActionNode(tc);

      // 并行：同 turnId 标记 parallelGroupId
      if (tc.turnId) {
        if (!turnGroupMap[tc.turnId]) {
          groupSeq += 1;
          turnGroupMap[tc.turnId] = 'pg-' + groupSeq;
        }
        action.parallelGroupId = turnGroupMap[tc.turnId];
      }

      current.actions.push(action);
      var t = toolTimeMs(tc);
      if (t) current.lastTime = t;
    }

    flush();
    return purposes;
  }

  /* ------------------------------------------------------------------ */
  /*  projectMessage / conversation                                      */
  /* ------------------------------------------------------------------ */

  var _idSeq = 0;
  function nextId(prefix) {
    _idSeq += 1;
    return (prefix || 'n') + '-' + _idSeq;
  }

  function parseElapsedMs(elapsed) {
    if (elapsed == null) return undefined;
    if (typeof elapsed === 'number') return elapsed;
    var s = String(elapsed).trim();
    var m = s.match(/^([\d.]+)\s*s$/i);
    if (m) return Math.round(parseFloat(m[1]) * 1000);
    var n = parseFloat(s);
    if (!isNaN(n)) return n;
    return undefined;
  }

  function normalizeTraces(traces) {
    if (!traces) return [];
    // 已是 string[][]
    if (Array.isArray(traces) && traces.length && Array.isArray(traces[0])) {
      return traces.slice(0, 3).map(function (col) {
        return (col || []).map(String);
      });
    }
    // flat string[] → 单列
    if (Array.isArray(traces)) {
      return [traces.map(String)];
    }
    return [];
  }

  function projectBlocks(blocks, pendingAcc) {
    var nodes = [];
    var list = blocks || [];
    for (var i = 0; i < list.length; i++) {
      var block = list[i];
      if (!block || !block.type) continue;

      if (block.type === 'thinking') {
        nodes.push({
          kind: 'thinking',
          id: block.id || nextId('think'),
          preview: block.preview || '',
          content: block.content || block.text || '',
          elapsedMs: parseElapsedMs(block.elapsed || block.elapsedMs),
          live: Boolean(block.live || block.status === 'running'),
        });
        continue;
      }

      if (block.type === 'text') {
        var tone = 'primary';
        if (block.tone === 'interstitial' || block.context === 'interstitial') tone = 'interstitial';
        else if (block.tone === 'primary' || block.primary === true) tone = 'primary';
        else if (block.context === 'primary') tone = 'primary';
        // 无标记时：短句偏 interstitial，长文 primary
        else if (!block.primary && !block.tone && block.context !== 'primary') {
          var t = block.text || block.content || '';
          tone = t.length < 80 ? 'interstitial' : 'primary';
        }
        nodes.push({
          kind: 'text',
          id: block.id || nextId('text'),
          content: block.text || block.content || '',
          tone: tone,
        });
        continue;
      }

      if (block.type === 'tools') {
        var tools = block.tools || [];
        var approvals = extractPendingApprovals(tools);
        for (var a = 0; a < approvals.length; a++) pendingAcc.push(approvals[a]);
        var purposes = projectPurposes(tools);
        for (var p = 0; p < purposes.length; p++) nodes.push(purposes[p]);
        continue;
      }

      if (block.type === 'purpose') {
        // 已整形的 purpose 块 — 规范化为 purpose 节点
        var actions = [];
        var rawActions = block.actions || block.tools || [];
        for (var j = 0; j < rawActions.length; j++) {
          var item = rawActions[j];
          if (!item) continue;
          // 已是 ActionNode
          if (item.verb && item.toolName && item.kind) {
            actions.push(item);
          } else {
            // MessageToolCall
            if (item.status === 'pending_approval') {
              var pa = extractPendingApprovals([item]);
              for (var k = 0; k < pa.length; k++) pendingAcc.push(pa[k]);
              continue;
            }
            actions.push(toActionNode(item));
          }
        }
        var secondary = block.secondary;
        if (typeof secondary === 'string') secondary = [secondary];
        nodes.push({
          kind: 'purpose',
          id: block.id || nextId('purpose'),
          primary: block.primary || '执行工具调用',
          secondary: secondary && secondary.length ? secondary : undefined,
          status: block.status || aggregatePurposeStatus(actions),
          actions: actions,
        });
        continue;
      }

      if (block.type === 'subagent') {
        var childPending = [];
        var children = projectBlocks(block.blocks || block.children || [], childPending);
        for (var c = 0; c < childPending.length; c++) pendingAcc.push(childPending[c]);
        nodes.push({
          kind: 'subagent',
          id: block.id || nextId('subagent'),
          name: block.name || '子任务',
          status: block.status || 'success',
          elapsedMs: parseElapsedMs(block.elapsed || block.elapsedMs),
          traces: normalizeTraces(block.traces),
          children: children,
        });
        continue;
      }

      if (block.type === 'document' || block.type === 'artifact') {
        nodes.push({
          kind: 'artifact',
          id: block.id || nextId('artifact'),
          title: block.title || block.name || '文档',
          mime: block.mime || 'markdown',
          content: block.content || block.markdown || '',
          // 保留 demo 扩展字段供 notebook 使用
          tag: block.tag,
          tableHeaders: block.tableHeaders,
          tableRows: block.tableRows,
        });
        continue;
      }

      if (block.type === 'composing') {
        nodes.push({
          kind: 'composing',
          id: block.id || nextId('composing'),
          text: block.text || '正在生成…',
        });
        continue;
      }

      if (block.type === 'task' || block.type === 'plan') {
        var taskPending = [];
        var taskChildren = projectBlocks(block.blocks || block.children || [], taskPending);
        for (var tci = 0; tci < taskPending.length; tci++) pendingAcc.push(taskPending[tci]);

        var normalizedSteps = (block.steps || []).map(function (step, sIdx) {
          var stepKids = [];
          if (step.children || step.blocks) {
            stepKids = projectBlocks(step.children || step.blocks, pendingAcc);
          }
          return {
            id: step.id || String(sIdx + 1),
            title: step.title,
            status: step.status,
            children: stepKids,
          };
        });

        nodes.push({
          kind: 'plan',
          id: block.id || nextId('plan'),
          title: block.title || block.name || '执行计划',
          status: block.status || 'running',
          currentStepIndex: typeof block.currentStepIndex === 'number' ? block.currentStepIndex : 0,
          steps: normalizedSteps,
          children: taskChildren,
        });
        continue;
      }

      // divider 等未知类型：跳过
    }
    return nodes;
  }

  /**
   * Project assistant message blocks → FlowNode[] tree.
   * Accepts existing demo blocks + enhanced purpose blocks.
   */
  function projectMessage(msg) {
    _idSeq = 0;
    var pendingApprovals = [];
    if (!msg) return { nodes: [], pendingApprovals: pendingApprovals };

    // user 消息：单 text 节点
    if (msg.role === 'user' || msg.sender === 'user') {
      return {
        nodes: [
          {
            kind: 'text',
            id: msg.id || nextId('user'),
            content: msg.text || msg.content || '',
            tone: 'primary',
          },
        ],
        pendingApprovals: pendingApprovals,
      };
    }

    var blocks = msg.blocks;
    // 兼容扁平 toolCalls（无 blocks）
    if ((!blocks || !blocks.length) && msg.toolCalls && msg.toolCalls.length) {
      blocks = [{ type: 'tools', tools: msg.toolCalls }];
    }

    var nodes = projectBlocks(blocks || [], pendingApprovals);

    // 顶层 thinking / text 字段（无 blocks 时）
    if ((!blocks || !blocks.length) && msg.thinking) {
      nodes.unshift({
        kind: 'thinking',
        id: nextId('think'),
        preview: clip(msg.thinking, 48),
        content: msg.thinking,
        elapsedMs: undefined,
      });
    }
    if ((!msg.blocks || !msg.blocks.length) && msg.text) {
      nodes.push({
        kind: 'text',
        id: nextId('text'),
        content: msg.text,
        tone: 'primary',
      });
    }

    return { nodes: nodes, pendingApprovals: pendingApprovals };
  }

  /**
   * Project full conversation.
   */
  function projectConversation(conversation) {
    var messages = [];
    var pendingApprovals = [];
    var list = conversation || [];

    // 支持 { conversation: [...] } 或 数组
    if (!Array.isArray(list) && list && Array.isArray(list.conversation)) {
      if (Array.isArray(list.pendingApprovals)) {
        pendingApprovals = pendingApprovals.concat(list.pendingApprovals);
      }
      list = list.conversation;
    }

    for (var i = 0; i < list.length; i++) {
      var msg = list[i];
      var projected = projectMessage(msg);
      messages.push({
        id: msg.id || nextId('msg'),
        role: msg.role || msg.sender || 'assistant',
        time: msg.time,
        status: msg.status,
        nodes: projected.nodes,
        // 保留原始 user text 便于渲染
        text: msg.role === 'user' || msg.sender === 'user' ? msg.text || msg.content : undefined,
      });
      for (var j = 0; j < projected.pendingApprovals.length; j++) {
        pendingApprovals.push(projected.pendingApprovals[j]);
      }
    }

    // 按 id 去重（预置 DemoData.pendingApprovals 与从 tool 抽出可能重叠；优先保留带 toolCall 的）
    var byId = {};
    var order = [];
    for (var u = 0; u < pendingApprovals.length; u++) {
      var item = pendingApprovals[u];
      var key = (item && item.id) || 'idx-' + u;
      if (!byId[key]) {
        byId[key] = item;
        order.push(key);
      } else if (item && item.toolCall && !(byId[key] && byId[key].toolCall)) {
        byId[key] = item;
      }
    }
    var unique = order.map(function (k) {
      return byId[k];
    });

    return { messages: messages, pendingApprovals: unique };
  }

  /* ------------------------------------------------------------------ */
  /*  export                                                             */
  /* ------------------------------------------------------------------ */

  window.FlowProjector = {
    projectPurposes: projectPurposes,
    toActionNode: toActionNode,
    extractPendingApprovals: extractPendingApprovals,
    projectMessage: projectMessage,
    projectConversation: projectConversation,
    // 内部辅助（便于单测 / 调试）
    normalizePurpose: normalizePurpose,
    resolvePrimary: resolvePrimary,
  };
})();
