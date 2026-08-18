/**
 * markdown-editor/model.js — Doc + Block + History (flat Block[] + indent)
 * 工厂 / 迁移委托 MdxSchema（schema.js 须先于本文件加载）
 */
(function () {
  'use strict';

  function S() {
    if (!window.MdxSchema) {
      throw new Error('MdxSchema missing — load schema.js before model.js');
    }
    return window.MdxSchema;
  }

  function createBlock(partial) {
    return S().createBlock(partial);
  }

  function emptyDoc() {
    return S().emptyDoc();
  }

  function cloneDoc(doc) {
    return S().cloneDoc(doc);
  }

  function migrate(doc) {
    return S().migrate(doc);
  }

  function findIndex(doc, id) {
    var blocks = doc.blocks || [];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].id === id) return i;
    }
    return -1;
  }

  function createModel(initialDoc) {
    // 入口统一 migrate 到 Doc v2
    var doc = initialDoc ? migrate(initialDoc) : emptyDoc();
    if (!doc.blocks || !doc.blocks.length) doc = emptyDoc();

    var undoStack = [];
    var redoStack = [];
    var listeners = [];
    var MAX_HIST = 100;
    // 打字合并：同一 mergeKey 在时间窗内只入栈一次（撤销回到本组输入前）
    var lastMergeKey = null;
    var lastMergeAt = 0;
    var MERGE_WINDOW_MS = 1000;

    function emit(reason) {
      for (var i = 0; i < listeners.length; i++) {
        try {
          listeners[i](doc, reason);
        } catch (e) {
          console.error('[mdx model]', e);
        }
      }
    }

    function snapshot() {
      return cloneDoc(doc);
    }

    /**
     * @param {{ mergeKey?: string|null }} [opts]
     * mergeKey 相同时在 MERGE_WINDOW_MS 内跳过重复入栈
     */
    function pushHistory(opts) {
      opts = opts || {};
      var key = opts.mergeKey != null ? String(opts.mergeKey) : '';
      var now = Date.now();
      if (
        key &&
        key === lastMergeKey &&
        now - lastMergeAt < MERGE_WINDOW_MS &&
        undoStack.length > 0
      ) {
        lastMergeAt = now;
        return false;
      }
      undoStack.push(snapshot());
      if (undoStack.length > MAX_HIST) undoStack.shift();
      redoStack.length = 0;
      lastMergeKey = key || null;
      lastMergeAt = now;
      return true;
    }

    function clearMergeKey() {
      lastMergeKey = null;
      lastMergeAt = 0;
    }

    function getDoc() {
      return doc;
    }

    function getBlocks() {
      return doc.blocks;
    }

    function setDoc(next, opts) {
      opts = opts || {};
      if (!opts.silentHistory) {
        pushHistory();
        clearMergeKey();
      }
      doc = migrate(next);
      if (!doc.blocks.length) doc.blocks = [createBlock({ type: 'paragraph', text: '' })];
      emit(opts.reason || 'setDoc');
    }

    function replaceBlocks(blocks, opts) {
      opts = opts || {};
      if (opts.addToHistory !== false) {
        pushHistory({ mergeKey: opts.mergeKey });
        if (!opts.mergeKey) clearMergeKey();
      }
      doc.blocks = (blocks || []).map(function (b) {
        return createBlock(b);
      });
      if (!doc.blocks.length) doc.blocks.push(createBlock({ type: 'paragraph', text: '' }));
      doc.version = S().VERSION;
      emit(opts.reason || 'replace');
    }

    function updateBlock(id, patch, opts) {
      opts = opts || {};
      var idx = findIndex(doc, id);
      if (idx < 0) return false;
      if (opts.addToHistory !== false) {
        pushHistory({ mergeKey: opts.mergeKey });
        if (!opts.mergeKey) clearMergeKey();
      }
      // 经 createBlock 归一化（表格 rows↔cells 同步等）
      var base = Object.assign({}, doc.blocks[idx]);
      var p = patch || {};
      // 仅更新 rows 时丢弃旧 cells，避免 createBlock 优先 cells 导致 rows 无效
      if (p.rows != null && p.cells == null) delete base.cells;
      if (p.cells != null && p.rows == null) delete base.rows;
      var merged = Object.assign({}, base, p);
      if (p.id == null) merged.id = doc.blocks[idx].id;
      var cur = createBlock(merged);
      doc.blocks[idx] = cur;
      emit(opts.reason || 'update');
      return true;
    }

    function insertBlock(index, block, opts) {
      opts = opts || {};
      if (opts.addToHistory !== false) {
        pushHistory({ mergeKey: opts.mergeKey });
        clearMergeKey();
      }
      var b = createBlock(block);
      var i = Math.max(0, Math.min(index, doc.blocks.length));
      doc.blocks.splice(i, 0, b);
      emit(opts.reason || 'insert');
      return b;
    }

    function removeBlock(id, opts) {
      opts = opts || {};
      var idx = findIndex(doc, id);
      if (idx < 0) return false;
      if (doc.blocks.length === 1) {
        // keep one empty paragraph
        if (opts.addToHistory !== false) {
          pushHistory();
          clearMergeKey();
        }
        doc.blocks[0] = createBlock({ type: 'paragraph', text: '' });
        emit('clear-last');
        return true;
      }
      if (opts.addToHistory !== false) {
        pushHistory();
        clearMergeKey();
      }
      doc.blocks.splice(idx, 1);
      emit(opts.reason || 'remove');
      return true;
    }

    /**
     * 批量删除（一步 undo）
     * @param {string[]} ids
     */
    function removeBlocks(ids, opts) {
      opts = opts || {};
      if (!ids || !ids.length) return false;
      var set = Object.create(null);
      var n = 0;
      for (var i = 0; i < ids.length; i++) {
        if (ids[i] && !set[ids[i]]) {
          set[ids[i]] = true;
          n++;
        }
      }
      if (!n) return false;
      if (opts.addToHistory !== false) {
        pushHistory();
        clearMergeKey();
      }
      var next = [];
      for (var j = 0; j < doc.blocks.length; j++) {
        if (!set[doc.blocks[j].id]) next.push(doc.blocks[j]);
      }
      if (!next.length) {
        next = [createBlock({ type: 'paragraph', text: '' })];
      }
      doc.blocks = next;
      doc.version = S().VERSION;
      emit(opts.reason || 'multi-remove');
      return true;
    }

    function moveBlock(from, to, opts) {
      opts = opts || {};
      if (from === to || from < 0 || to < 0) return false;
      if (from >= doc.blocks.length) return false;
      if (opts.addToHistory !== false) {
        pushHistory();
        clearMergeKey();
      }
      var item = doc.blocks.splice(from, 1)[0];
      var t = to > from ? to - 1 : to;
      t = Math.max(0, Math.min(t, doc.blocks.length));
      doc.blocks.splice(t, 0, item);
      emit(opts.reason || 'move');
      return true;
    }

    function undo() {
      if (!undoStack.length) return false;
      clearMergeKey();
      redoStack.push(snapshot());
      doc = undoStack.pop();
      emit('undo');
      return true;
    }

    function redo() {
      if (!redoStack.length) return false;
      clearMergeKey();
      undoStack.push(snapshot());
      doc = redoStack.pop();
      emit('redo');
      return true;
    }

    function onChange(fn) {
      listeners.push(fn);
      return function () {
        listeners = listeners.filter(function (f) {
          return f !== fn;
        });
      };
    }

    return {
      getDoc: getDoc,
      getBlocks: getBlocks,
      setDoc: setDoc,
      replaceBlocks: replaceBlocks,
      updateBlock: updateBlock,
      insertBlock: insertBlock,
      removeBlock: removeBlock,
      removeBlocks: removeBlocks,
      moveBlock: moveBlock,
      findIndex: function (id) {
        return findIndex(doc, id);
      },
      undo: undo,
      redo: redo,
      onChange: onChange,
      createBlock: createBlock,
      snapshot: snapshot,
      clearMergeKey: clearMergeKey,
    };
  }

  window.MdxModel = {
    createBlock: createBlock,
    emptyDoc: emptyDoc,
    cloneDoc: cloneDoc,
    migrate: migrate,
    createModel: createModel,
  };
})();
