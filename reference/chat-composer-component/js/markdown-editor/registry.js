/**
 * markdown-editor/registry.js — BlockType 注册表（可扩展）
 * 最小实现：register / get / list / slashCommands
 * editor 仍可使用内置 SLASH_COMMANDS；本表供 blocks/* 与 slash 合并扩展。
 */
(function () {
  'use strict';

  /** @type {Object.<string, object>} */
  var byType = Object.create(null);

  /**
   * @param {{
   *   type: string,
   *   toMarkdown?: function,
   *   fromMatch?: function,
   *   renderRead?: function,
   *   renderEdit?: function,
   *   slash?: { title?: string, aliases?: string[], section?: string, id?: string, level?: number, callout?: string }
   * }} def
   */
  function register(def) {
    if (!def || !def.type) {
      throw new Error('MdxRegistry.register: def.type required');
    }
    byType[def.type] = def;
    return def;
  }

  function get(type) {
    if (!type) return null;
    return byType[type] || null;
  }

  function list() {
    var out = [];
    for (var k in byType) {
      if (Object.prototype.hasOwnProperty.call(byType, k)) out.push(byType[k]);
    }
    return out;
  }

  /**
   * 已注册块上的 slash 元数据（可与 editor 内置 SLASH_COMMANDS 合并）
   * @returns {Array<object>}
   */
  function slashCommands() {
    var cmds = [];
    var items = list();
    for (var i = 0; i < items.length; i++) {
      var def = items[i];
      if (!def.slash) continue;
      var s = def.slash;
      cmds.push({
        id: s.id || def.type,
        title: s.title || def.type,
        aliases: s.aliases || [],
        section: s.section || '扩展',
        type: def.type,
        level: s.level,
        callout: s.callout,
      });
    }
    return cmds;
  }

  function clear() {
    byType = Object.create(null);
  }

  window.MdxRegistry = {
    register: register,
    get: get,
    list: list,
    slashCommands: slashCommands,
    clear: clear,
  };
})();
