/**
 * markdown-editor/ui/slash-menu.js — slash 命令表 + 过滤 + 渲染
 * 导出 window.MdxSlashMenu
 *
 * 与 editor 解耦：命令定义、filter、HTML 渲染在此；run 仍由 editor 调 model。
 */
(function () {
  'use strict';

  /** 内置 slash 命令（W6 含 image / toc） */
  var BUILTIN_COMMANDS = [
    { id: 'paragraph', title: '正文', aliases: ['text', 'p', '段落'], section: '基础', type: 'paragraph' },
    { id: 'h1', title: '标题 1', aliases: ['h1', 'heading1'], section: '基础', type: 'heading', level: 1 },
    { id: 'h2', title: '标题 2', aliases: ['h2'], section: '基础', type: 'heading', level: 2 },
    { id: 'h3', title: '标题 3', aliases: ['h3'], section: '基础', type: 'heading', level: 3 },
    { id: 'h4', title: '标题 4', aliases: ['h4', 'heading4'], section: '基础', type: 'heading', level: 4 },
    { id: 'h5', title: '标题 5', aliases: ['h5', 'heading5'], section: '基础', type: 'heading', level: 5 },
    { id: 'h6', title: '标题 6', aliases: ['h6', 'heading6'], section: '基础', type: 'heading', level: 6 },
    { id: 'bullet', title: '无序列表', aliases: ['ul', 'list', '列表'], section: '列表', type: 'bullet_item' },
    { id: 'ordered', title: '有序列表', aliases: ['ol', 'numbered'], section: '列表', type: 'ordered_item' },
    { id: 'task', title: '待办', aliases: ['todo', 'task', '任务'], section: '列表', type: 'task_item' },
    { id: 'quote', title: '引用', aliases: ['quote', '引用'], section: '基础', type: 'quote' },
    { id: 'code', title: '代码块', aliases: ['code', '代码'], section: '基础', type: 'code' },
    { id: 'math', title: '公式块', aliases: ['math', 'latex', '公式', 'equation'], section: '高级', type: 'math' },
    { id: 'mermaid', title: 'Mermaid 图', aliases: ['mermaid', 'diagram', '图表', 'flowchart'], section: '高级', type: 'code', lang: 'mermaid' },
    { id: 'table', title: '表格', aliases: ['table', '表'], section: '高级', type: 'table' },
    { id: 'divider', title: '分割线', aliases: ['hr', 'divider', '分割'], section: '基础', type: 'divider' },
    { id: 'callout', title: '高亮提示', aliases: ['callout', 'tip', '提示'], section: '高级', type: 'callout', callout: 'tip' },
    { id: 'image', title: '图片', aliases: ['image', 'img', '图片', '图'], section: '媒体', type: 'image' },
    { id: 'toc', title: '目录', aliases: ['toc', '目录', '大纲'], section: '结构', type: 'toc' },
    { id: 'file', title: '文件引用', aliases: ['file', '文件'], section: '高级', type: 'file_chip' },
  ];

  function esc(s) {
    if (window.MdxUtil && window.MdxUtil.esc) return window.MdxUtil.esc(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * 合并 registry 扩展命令（去重 by id）
   */
  function allCommands() {
    var list = BUILTIN_COMMANDS.slice();
    var seen = Object.create(null);
    list.forEach(function (c) {
      seen[c.id] = true;
    });
    if (window.MdxRegistry && typeof window.MdxRegistry.slashCommands === 'function') {
      var extra = window.MdxRegistry.slashCommands() || [];
      for (var i = 0; i < extra.length; i++) {
        var c = extra[i];
        if (!c || !c.id || seen[c.id]) continue;
        seen[c.id] = true;
        list.push(c);
      }
    }
    return list;
  }

  function filterCommands(q, commands) {
    commands = commands || allCommands();
    q = (q || '').trim().toLowerCase();
    if (!q) return commands.slice();
    return commands.filter(function (cmd) {
      if ((cmd.title || '').toLowerCase().indexOf(q) >= 0) return true;
      return (cmd.aliases || []).some(function (a) {
        return String(a).toLowerCase().indexOf(q) >= 0;
      });
    });
  }

  function findCommand(cmdId, commands) {
    commands = commands || allCommands();
    for (var i = 0; i < commands.length; i++) {
      if (commands[i].id === cmdId) return commands[i];
    }
    return null;
  }

  /**
   * 渲染 slash 面板 HTML
   * @param {{ query: string, index: number }} state
   * @returns {{ html: string, list: Array }}
   */
  function render(state) {
    state = state || {};
    var list = filterCommands(state.query);
    var index = state.index | 0;
    if (index >= list.length) index = Math.max(0, list.length - 1);
    if (!list.length) {
      return {
        html:
          '<div class="mdx-slash__empty">未找到相关命令<div class="mdx-slash__hint">试试「标题」「图片」「目录」「表格」</div></div>',
        list: list,
        index: 0,
      };
    }
    var sections = {};
    var order = [];
    list.forEach(function (c) {
      var sec = c.section || '其他';
      if (!sections[sec]) {
        sections[sec] = [];
        order.push(sec);
      }
      sections[sec].push(c);
    });
    var html = '';
    var flatIndex = 0;
    order.forEach(function (sec) {
      html += '<div class="mdx-slash__section">' + esc(sec) + '</div>';
      sections[sec].forEach(function (cmd) {
        var active = flatIndex === index;
        html +=
          '<button type="button" role="option" class="mdx-slash__item' +
          (active ? ' is-active' : '') +
          '" data-cmd="' +
          esc(cmd.id) +
          '" data-idx="' +
          flatIndex +
          '">' +
          '<span class="mdx-slash__title">' +
          esc(cmd.title) +
          '</span></button>';
        flatIndex++;
      });
    });
    return { html: html, list: list, index: index };
  }

  /**
   * 根据 slash 命令构造块 patch（不含 id）
   */
  function patchForCommand(cmd) {
    if (!cmd) return null;
    var Schema = window.MdxSchema;
    var Image = window.MdxBlocksImage;
    var Toc = window.MdxBlocksToc;

    var patch = { type: cmd.type, text: '' };
    if (cmd.level) patch.level = cmd.level;
    if (cmd.callout) patch.callout = cmd.callout;
    if (cmd.type === 'task_item') patch.checked = false;
    if (cmd.type === 'code') {
      patch.text = '';
      patch.lang = '';
    }
    if (cmd.type === 'table') {
      patch.rows = [
        ['列 1', '列 2', '列 3'],
        ['', '', ''],
        ['', '', ''],
      ];
      patch.hasHeader = true;
      patch.align = ['left', 'left', 'left'];
      patch.text = '';
      if (Schema && Schema.rowsToCells) {
        patch.cells = Schema.rowsToCells(patch.rows);
      }
    }
    if (cmd.type === 'file_chip') {
      patch.path = 'src/example.ts';
      patch.text = 'src/example.ts';
    }
    if (cmd.type === 'callout') {
      patch.text = '提示\n在此填写内容';
      if (!patch.callout) patch.callout = 'tip';
    }
    if (cmd.type === 'image') {
      if (Image && Image.createEmpty) {
        var empty = Image.createEmpty();
        patch.src = empty.src;
        patch.alt = empty.alt;
        patch.title = empty.title || '';
        patch.caption = empty.caption || '';
        patch.text = '';
      } else {
        patch.src = '';
        patch.alt = '';
        patch.text = '';
      }
    }
    if (cmd.type === 'toc') {
      if (Toc && Toc.createEmpty) {
        var t = Toc.createEmpty();
        patch.minLevel = t.minLevel;
        patch.maxLevel = t.maxLevel;
        patch.text = '';
      } else {
        patch.text = '';
      }
    }
    return patch;
  }

  window.MdxSlashMenu = {
    BUILTIN_COMMANDS: BUILTIN_COMMANDS,
    allCommands: allCommands,
    filterCommands: filterCommands,
    findCommand: findCommand,
    render: render,
    patchForCommand: patchForCommand,
  };
})();
