/**
 * tool-presentation.js
 * 对齐 apps/crish-desktop 的 toolCardPresenter / timelineNormalizer 核心逻辑（精简版）。
 * 供 reference 对话流 demo 使用，避免「虚构 intent」与真实后端脱节。
 *
 * 真实数据形状：
 *   MessageToolCall { id, name, arguments, status, output?, explanation?, diffs?, startedAt?, completedAt? }
 *   ToolRenderItem  = { kind:'single', tc } | { kind:'group', id, tools, label }
 *   status          = running | success | error | pending_approval
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*  helpers                                                            */
  /* ------------------------------------------------------------------ */

  function basename(p) {
    if (!p) return '';
    var s = String(p).replace(/\\/g, '/');
    var parts = s.split('/');
    return parts[parts.length - 1] || s;
  }

  function clip(text, max) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + '…';
  }

  function parseArgs(raw) {
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    var s = String(raw).trim();
    if (!s) return {};
    try {
      if (s.charAt(0) === '{') return JSON.parse(s);
    } catch (e) { /* ignore */ }
    return { _raw: s };
  }

  function extractPath(args) {
    var a = parseArgs(args);
    var keys = ['path', 'file_path', 'filePath', 'targetFile', 'target_file', 'filename', 'file'];
    for (var i = 0; i < keys.length; i++) {
      var v = a[keys[i]];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    if (typeof a.command === 'string') return a.command.trim();
    if (typeof a.pattern === 'string') return a.pattern.trim();
    if (typeof a.query === 'string') return a.query.trim();
    if (typeof a.url === 'string') return a.url.trim();
    if (typeof a._raw === 'string') return a._raw;
    return '';
  }

  function extractCommand(args) {
    var a = parseArgs(args);
    if (typeof a.command === 'string') return a.command.trim();
    if (typeof a.cmd === 'string') return a.cmd.trim();
    return extractPath(args);
  }

  function isShellName(name) {
    var n = (name || '').toLowerCase();
    return (
      n === 'shell' ||
      n === 'bash' ||
      n === 'run_command' ||
      n === 'run_terminal_cmd' ||
      n.includes('shell') ||
      n.includes('bash') ||
      n.includes('exec') ||
      n.includes('powershell') ||
      n.includes('terminal')
    );
  }

  function isEditName(name) {
    var n = (name || '').toLowerCase();
    return (
      n.includes('write') ||
      n.includes('edit') ||
      n.includes('patch') ||
      n.includes('replace') ||
      n.includes('apply') ||
      n === 'search_replace' ||
      n === 'write_file' ||
      n === 'create_file' ||
      n === 'write_to_file' ||
      n === 'replace_file_content' ||
      n === 'multi_replace_file_content'
    );
  }

  function isReadName(name) {
    var n = (name || '').toLowerCase();
    return n.includes('read') || n.includes('view') || n.includes('cat') || n === 'open_file';
  }

  function isListName(name) {
    var n = (name || '').toLowerCase();
    return n.includes('list') || n.includes('glob') || n.includes('dir') || n === 'ls';
  }

  function isSearchName(name) {
    var n = (name || '').toLowerCase();
    // 注意：search_replace 是编辑工具，不能算搜索
    if (isEditName(n)) return false;
    return (
      n.includes('grep') ||
      n === 'search' ||
      n.includes('codebase_search') ||
      n.includes('find') ||
      n === 'rg' ||
      n === 'grep_search'
    );
  }

  function isPlaceholderOutput(raw) {
    var t = String(raw || '').trim();
    if (!t) return true;
    if (/^(完成|成功|ok|done|success)$/i.test(t)) return true;
    if (t === '（无输出）' || t === '(no output)') return true;
    return false;
  }

  function isTrivialOutput(raw) {
    var t = String(raw || '').trim();
    if (!t) return true;
    if (t.length < 3) return true;
    if (/^completed?\.?$/i.test(t)) return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  labels — 对齐 toolHumanLabel / toolLabelFromArgs                   */
  /* ------------------------------------------------------------------ */

  function isGenericExplanationSpam(text) {
    var t = text.trim();
    if (!t) return true;
    if (/^(正在)?(查看|浏览|修改|搜索|访问|读取|写入|列出|创建|运行)(文件|目录|代码|网络|内容|命令|工具)?$/.test(t)) {
      return true;
    }
    if (/^正在?(查看|浏览|修改|搜索|访问|读取|写入|运行)\s+\S{1,80}$/.test(t)) return true;
    if (/^(创建目录|列出目录|列出目录内容|运行命令|运行终端命令|查看文件内容|查看文件|修改文件|写入文件|切换工作目录)(\s+\S+)?$/.test(t)) {
      return true;
    }
    if (/^正在?(创建目录|列出目录|查看文件|修改文件|写入文件|运行命令|访问网络)\b/.test(t) && t.length < 24) {
      return true;
    }
    return false;
  }

  function isHumanExplanation(text, toolName) {
    var t = text.trim();
    if (!t || t === toolName || t === '需要确认') return false;
    if (t.charAt(0) === '{' || t.charAt(0) === '[') return false;
    if (/^[\w./\\:-]+\s+[\w./\\:-]+/.test(t) && !/[\u4e00-\u9fff]/.test(t)) return false;
    if (/[\u4e00-\u9fff]/.test(t)) return t.length >= 2 && t.length <= 240;
    if (/^[A-Za-z]/.test(t) && t.length >= 6 && t.length <= 160 && !/[\\/]{2,}/.test(t)) {
      if (/^(ls|cd|cat|mkdir|rm|cp|mv|git|npm|pnpm|yarn)\b/i.test(t)) return false;
      return true;
    }
    return false;
  }

  function toolLabelFromArgs(tc) {
    var name = (tc.name || 'tool').toLowerCase();
    var cmd = extractCommand(tc.arguments || '');
    var path = extractPath(tc.arguments || '');

    if (isShellName(name)) {
      if (!cmd) return '运行终端命令';
      // 轻量 humanize（对齐常见 shell 模式）
      if (/^(pwd|ls|dir)\b/i.test(cmd)) return '浏览目录';
      if (/^cat\b|^type\b|^Get-Content\b/i.test(cmd)) {
        var f = cmd.split(/\s+/)[1];
        return f ? '查看 ' + basename(f) : '查看文件';
      }
      if (/^tsc\b/i.test(cmd)) return '类型检查';
      if (/^vitest\b|^npm\s+test\b|^pnpm\s+test\b/i.test(cmd)) return '单元测试';
      if (/^git\s+status\b/i.test(cmd)) return '查看 Git 状态';
      if (/^git\s+diff\b/i.test(cmd)) return '查看 Git 差异';
      var short = cmd.replace(/\s+/g, ' ').trim();
      return short.length > 48 ? '运行 ' + short.slice(0, 47) + '…' : '运行 ' + short;
    }

    if (isEditName(name)) {
      var isWrite =
        /\bwrite\b/.test(name) ||
        name.includes('create') ||
        name === 'write_file' ||
        name === 'create_file' ||
        name === 'write_to_file';
      if (isWrite && !name.includes('edit') && !name.includes('patch') && !name.includes('replace')) {
        return path ? '写入 ' + basename(path) : '写入文件';
      }
      return path ? '修改 ' + basename(path) : '修改文件';
    }

    if (isReadName(name)) {
      return path ? '查看 ' + basename(path) : '查看文件';
    }
    if (isListName(name)) {
      if (path && path !== '.' && path !== './') {
        var shortP = path.length > 36 ? '…' + path.slice(-34) : path;
        return '浏览 ' + shortP;
      }
      return '浏览目录';
    }
    if (isSearchName(name)) {
      var a = parseArgs(tc.arguments || '');
      var q = (a.pattern || a.query || path || '').trim();
      if (q && q.length < 40) return '搜索 ' + q;
      return '搜索代码';
    }
    if (name.includes('web') || name.includes('fetch') || name.includes('http')) {
      if (path && /^https?:\/\//i.test(path)) {
        try {
          var host = new URL(path).hostname;
          return host ? '访问 ' + host : '访问网络';
        } catch (e) { /* fallthrough */ }
      }
      return '访问网络';
    }
    if (name === 'run_subagent' || name.includes('subagent')) {
      var exp = (tc.explanation || '').trim();
      if (exp) return '协作子任务：' + clip(exp, 40);
      return '启动协作子任务';
    }

    if (path) {
      var b = basename(path);
      if (b && b.length < 48) return '处理 ' + b;
    }
    var pretty = (tc.name || '工具').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
    return pretty ? '调用 ' + pretty : '调用工具';
  }

  function toolHumanLabel(tc) {
    var exp = (tc.explanation || '').trim();
    var name = tc.name || '';
    var expLooksLikeRawCmd =
      /^(powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh)\b/i.test(exp) ||
      (/^[\w./\\:-]+\s+/.test(exp) && exp.length > 48 && !/[\u4e00-\u9fff]/.test(exp));

    if (exp && !expLooksLikeRawCmd && !isGenericExplanationSpam(exp) && isHumanExplanation(exp, name)) {
      return clip(exp, 80);
    }
    if (
      exp &&
      !expLooksLikeRawCmd &&
      /[\u4e00-\u9fff]/.test(exp) &&
      exp.length >= 8 &&
      !isGenericExplanationSpam(exp)
    ) {
      return clip(exp.replace(/^正在/, ''), 80);
    }
    return clip(toolLabelFromArgs(tc), 80);
  }

  /** 动词前缀（用于摘要行结构化） */
  function toolVerb(tc) {
    var name = (tc.name || '').toLowerCase();
    if (isEditName(name)) {
      if (/\bwrite\b/.test(name) || name.includes('create') || name === 'write_file' || name === 'write_to_file') {
        return '写入';
      }
      return '修改';
    }
    if (isReadName(name)) return '查看';
    if (isListName(name)) return '浏览';
    if (isSearchName(name)) return '搜索';
    if (isShellName(name)) return '运行';
    if (name.includes('web') || name.includes('fetch')) return '访问';
    if (name.includes('subagent')) return '协作';
    return '';
  }

  function toolObjectLabel(tc) {
    var path = extractPath(tc.arguments || '');
    var name = (tc.name || '').toLowerCase();
    if (isShellName(name)) {
      var cmd = extractCommand(tc.arguments || '');
      return cmd ? clip(cmd.replace(/\s+/g, ' '), 56) : '';
    }
    if (isEditName(name) || isReadName(name) || isListName(name)) {
      if (!path) return '';
      // 目录保留相对路径；文件用 basename
      if (/[\\/]$/.test(path) || isListName(name)) {
        return path.length > 36 ? '…' + path.slice(-34) : path;
      }
      return basename(path) || path;
    }
    if (isSearchName(name)) {
      var a = parseArgs(tc.arguments || '');
      return (a.pattern || a.query || path || '').trim();
    }
    if (path) return basename(path) || path;
    return '';
  }

  function isFilePathTool(tc) {
    var name = (tc.name || '').toLowerCase();
    return isReadName(name) || isEditName(name) || isListName(name);
  }

  /* ------------------------------------------------------------------ */
  /*  expand / inspect / result                                          */
  /* ------------------------------------------------------------------ */

  function toolHasExpandableBody(tc) {
    if (!tc) return false;
    if (tc.status === 'running' || tc.status === 'pending_approval') return false;
    // Search / list: no in-stream expand (and never open right panel)
    var name = (tc.name || '').toLowerCase();
    if (isSearchName(name)) return false;
    if (isListName(name)) return false;
    if (tc.diffs && tc.diffs.length > 0) return true;
    if (tc.diffStat && (tc.diffStat.add || tc.diffStat.del)) return true;
    var raw = tc.output || '';
    if (isPlaceholderOutput(raw) || isTrivialOutput(raw)) return false;
    var t = String(raw).trim();
    if (t.length < 8) return false;
    // Prefer multi-line or long substance (edit / shell / read)
    return t.indexOf('\n') >= 0 || t.length > 40;
  }

  function isInspectTool(tc) {
    if (!tc || tc.status === 'pending_approval') return false;
    var n = (tc.name || '').toLowerCase();
    if (isEditName(n)) return false;
    if (isShellName(n)) {
      var cmd = extractCommand(tc.arguments || '').toLowerCase();
      if (/^(pwd|ls|dir|cat|type|head|tail|git\s+status|git\s+diff|git\s+log|echo|whoami|hostname)\b/.test(cmd)) {
        return true;
      }
      if (/\b(rm|del|move|copy|set-content|out-file|write|install|npm\s+i|mkdir)\b/i.test(cmd)) {
        return false;
      }
      // 默认 shell 视作可检查类（与 desktop 一致偏 inspect）
      return true;
    }
    return (
      n.includes('read') ||
      n.includes('grep') ||
      n.includes('search') ||
      n.includes('list') ||
      n.includes('glob') ||
      n.includes('stat')
    );
  }

  /**
   * 是否有「实质可展示结果」。
   * desktop 当前实现会把纯 success 也算 displayable，导致 inspect 几乎无法成组；
   * reference 按设计注释语义：仅 expandable body 算实质结果，无输出的 inspect 可组折叠。
   */
  function toolHasDisplayableResult(tc) {
    if (!tc) return false;
    if (tc.status === 'running' || tc.status === 'pending_approval') return false;
    return toolHasExpandableBody(tc);
  }

  function toolResultPreview(tc, max) {
    max = max || 56;
    if (!tc || tc.status === 'running' || tc.status === 'pending_approval') return '';
    var raw = String(tc.output || '').trim();
    if (!raw || isPlaceholderOutput(raw) || isTrivialOutput(raw)) return '';
    var line = raw.split('\n').find(function (l) { return l.trim(); }) || raw;
    return clip(line, max);
  }

  function formatDiffStat(tc) {
    if (!tc) return null;
    if (tc.diffStat && (tc.diffStat.add != null || tc.diffStat.del != null)) {
      return { add: tc.diffStat.add || 0, del: tc.diffStat.del || 0 };
    }
    if (typeof tc.diff === 'string') {
      var m = tc.diff.match(/\+(\d+)\s*[−\-]\s*(\d+)/);
      if (m) return { add: +m[1], del: +m[2] };
    }
    if (tc.diffs && tc.diffs.length) {
      var add = 0;
      var del = 0;
      for (var i = 0; i < tc.diffs.length; i++) {
        add += tc.diffs[i].additions || tc.diffs[i].add || 0;
        del += tc.diffs[i].deletions || tc.diffs[i].del || 0;
      }
      if (add || del) return { add: add, del: del };
    }
    return null;
  }

  function durationLabel(tc) {
    if (!tc || !tc.startedAt) return '';
    var end = tc.completedAt || (tc.status === 'running' ? Date.now() : 0);
    if (!end) return '';
    var sec = (end - tc.startedAt) / 1000;
    if (sec < 0.1) return '';
    return sec.toFixed(1) + 's';
  }

  function toolStatusZh(status) {
    switch (status) {
      case 'running': return '运行中';
      case 'success': return '完成';
      case 'error': return '失败';
      case 'pending_approval': return '待确认';
      default: return '待命';
    }
  }

  /* ------------------------------------------------------------------ */
  /*  grouping — 对齐 buildToolRenderItems                               */
  /* ------------------------------------------------------------------ */

  function buildToolRenderItems(toolCalls) {
    var visible = (toolCalls || []).filter(Boolean);
    var out = [];
    var buf = [];

    function flush() {
      if (!buf.length) return;
      if (buf.length === 1) {
        out.push({ kind: 'single', tc: buf[0] });
      } else {
        var last = buf[buf.length - 1];
        out.push({
          kind: 'group',
          id: 'grp-' + buf[0].id,
          tools: buf.slice(),
          label: toolHumanLabel(last) + ' · ' + buf.length + ' 步',
        });
      }
      buf = [];
    }

    for (var i = 0; i < visible.length; i++) {
      var tc = visible[i];
      if (tc.status === 'pending_approval') {
        flush();
        out.push({ kind: 'single', tc: tc });
        continue;
      }
      // inspect + 无实质输出（含 running）：进组缓冲
      // inspect + 有可展开输出：单独成行，避免组折叠藏结果
      if (isInspectTool(tc) && !toolHasDisplayableResult(tc)) {
        buf.push(tc);
      } else {
        flush();
        out.push({ kind: 'single', tc: tc });
      }
    }
    flush();
    return out;
  }

  window.ToolPresentation = {
    basename: basename,
    clip: clip,
    parseArgs: parseArgs,
    extractPath: extractPath,
    extractCommand: extractCommand,
    isShellName: isShellName,
    isEditName: isEditName,
    isReadName: isReadName,
    isListName: isListName,
    isSearchName: isSearchName,
    isFilePathTool: isFilePathTool,
    toolHumanLabel: toolHumanLabel,
    toolLabelFromArgs: toolLabelFromArgs,
    toolVerb: toolVerb,
    toolObjectLabel: toolObjectLabel,
    toolHasExpandableBody: toolHasExpandableBody,
    isInspectTool: isInspectTool,
    toolHasDisplayableResult: toolHasDisplayableResult,
    toolResultPreview: toolResultPreview,
    formatDiffStat: formatDiffStat,
    durationLabel: durationLabel,
    toolStatusZh: toolStatusZh,
    buildToolRenderItems: buildToolRenderItems,
  };
}());
