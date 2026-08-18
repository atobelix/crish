/**
 * markdown-editor/parse.js — Markdown string → flat Block[]
 */
(function () {
  'use strict';

  var createBlock = function (p) {
    if (window.MdxSchema) return window.MdxSchema.createBlock(p);
    return window.MdxModel.createBlock(p);
  };

  function docVersion() {
    return (window.MdxSchema && window.MdxSchema.VERSION) || 2;
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:\-|]+\|[\s|:\-]+\|?\s*$/.test(line);
  }

  function splitRow(line) {
    var s = line.trim();
    if (s.charAt(0) === '|') s = s.slice(1);
    if (s.charAt(s.length - 1) === '|') s = s.slice(0, -1);
    return s.split('|').map(function (c) {
      return c.trim();
    });
  }

  /**
   * 解析 GFM 表分隔行对齐：`:---` 左 / `:---:` 中 / `---:` 右 / `---` 左
   * @param {string} line 分隔行原文
   * @returns {string[]} 'left' | 'center' | 'right'
   */
  function parseAlignRow(line) {
    return splitRow(line).map(function (cell) {
      var s = String(cell || '').trim();
      var leftColon = s.charAt(0) === ':';
      var rightColon = s.length > 0 && s.charAt(s.length - 1) === ':';
      if (leftColon && rightColon) return 'center';
      if (rightColon) return 'right';
      return 'left'; // --- 或 :---（GFM 左对齐）
    });
  }

  /** 将 align 截断/补 left 到与表头列数一致 */
  function normalizeAlign(align, cols) {
    var a = (align || []).slice(0, cols);
    while (a.length < cols) a.push('left');
    return a;
  }

  function listMatch(line) {
    // indent + marker
    var m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) return null;
    var spaces = m[1].replace(/\t/g, '  ').length;
    var indent = Math.min(6, Math.floor(spaces / 2));
    var marker = m[2];
    var rest = m[3];
    var ordered = /^\d+\.$/.test(marker);
    // task?
    var tm = rest.match(/^\[([ xX])\]\s+(.*)$/);
    if (tm) {
      return {
        type: 'task_item',
        indent: indent,
        checked: tm[1].toLowerCase() === 'x',
        text: tm[2],
      };
    }
    return {
      type: ordered ? 'ordered_item' : 'bullet_item',
      indent: indent,
      text: rest,
    };
  }

  function parse(md) {
    var raw = String(md == null ? '' : md).replace(/\r\n/g, '\n');
    if (!raw.trim()) {
      return { version: docVersion(), blocks: [createBlock({ type: 'paragraph', text: '' })] };
    }

    var lines = raw.split('\n');
    var blocks = [];
    var i = 0;

    while (i < lines.length) {
      var line = lines[i];

      // math block: $$ … $$（独占行开闭；或单行 $$…$$）
      var mathSingle = line.match(/^\s*\$\$([^$]+(?:\$[^$]+)*)\$\$\s*$/);
      if (mathSingle) {
        blocks.push(
          createBlock({
            type: 'math',
            text: mathSingle[1].trim(),
          })
        );
        i++;
        continue;
      }
      if (/^\s*\$\$\s*$/.test(line)) {
        var mbuf = [];
        i++;
        while (i < lines.length && !/^\s*\$\$\s*$/.test(lines[i])) {
          mbuf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // closing $$
        blocks.push(
          createBlock({
            type: 'math',
            text: mbuf.join('\n').replace(/^\n+/, '').replace(/\n+$/, ''),
          })
        );
        continue;
      }

      // fenced code（```mermaid 存为 code+lang=mermaid，读态由 MdxBlocksMermaid 特判）
      var fence = line.match(/^```([\w-]*)\s*$/);
      if (fence) {
        var lang = fence[1] || '';
        var buf = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          buf.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++; // closing fence
        blocks.push(
          createBlock({
            type: 'code',
            text: buf.join('\n'),
            lang: lang,
          })
        );
        continue;
      }

      // thematic break
      if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line) && line.replace(/\s/g, '').length >= 3) {
        blocks.push(createBlock({ type: 'divider' }));
        i++;
        continue;
      }

      // heading
      var hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        blocks.push(
          createBlock({
            type: 'heading',
            level: hm[1].length,
            text: hm[2].replace(/\s+#+\s*$/, ''),
          })
        );
        i++;
        continue;
      }

      // table（header + 分隔行对齐 + body）
      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        var header = splitRow(line);
        // 读分隔行 :-- / :--: / --: 写入 align，避免 serialize/渲染丢失
        var align = normalizeAlign(parseAlignRow(lines[i + 1]), header.length);
        i += 2;
        var rows = [header];
        while (i < lines.length && lines[i].indexOf('|') >= 0 && lines[i].trim()) {
          if (isTableSep(lines[i])) {
            i++;
            continue;
          }
          rows.push(splitRow(lines[i]));
          i++;
        }
        // normalize col count
        var cols = header.length;
        rows = rows.map(function (r) {
          var rr = r.slice(0, cols);
          while (rr.length < cols) rr.push('');
          return rr;
        });
        // createBlock 会同步 rows → cells（v2），并保留 align[]
        blocks.push(
          createBlock({
            type: 'table',
            rows: rows,
            hasHeader: true,
            text: '',
            align: align,
          })
        );
        continue;
      }

      // callout: > [!TIP] title   or ::: tip title
      var calloutStart = line.match(/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION|INFO)\]\s*(.*)$/i);
      if (calloutStart) {
        var ctype = calloutStart[1].toLowerCase();
        if (ctype === 'info') ctype = 'note';
        var title = calloutStart[2] || '';
        var cbuf = [];
        i++;
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          cbuf.push(lines[i].replace(/^\s*>\s?/, ''));
          i++;
        }
        blocks.push(
          createBlock({
            type: 'callout',
            callout: ctype,
            text: (title ? title + '\n' : '') + cbuf.join('\n'),
          })
        );
        continue;
      }

      var colonCall = line.match(/^:::\s*(tip|note|warning|important|caution)\s*(.*)$/i);
      if (colonCall) {
        var ct2 = colonCall[1].toLowerCase();
        var t2 = colonCall[2] || '';
        var cbuf2 = [];
        i++;
        while (i < lines.length && !/^:::\s*$/.test(lines[i])) {
          cbuf2.push(lines[i]);
          i++;
        }
        if (i < lines.length) i++;
        blocks.push(
          createBlock({
            type: 'callout',
            callout: ct2,
            text: (t2 ? t2 + '\n' : '') + cbuf2.join('\n'),
          })
        );
        continue;
      }

      // blockquote (simple single/multi)
      if (/^\s{0,3}>\s?/.test(line)) {
        var qbuf = [];
        while (i < lines.length && /^\s{0,3}>\s?/.test(lines[i])) {
          qbuf.push(lines[i].replace(/^\s{0,3}>\s?/, ''));
          i++;
        }
        blocks.push(createBlock({ type: 'quote', text: qbuf.join('\n') }));
        continue;
      }

      // list / task
      var lm = listMatch(line);
      if (lm) {
        blocks.push(createBlock(lm));
        i++;
        continue;
      }

      // exclusive file chip line [[file:path|label]]
      var fileOnly = line.match(/^\s*\[\[file:([^\]|]+)(?:\|([^\]]+))?\]\]\s*$/);
      if (fileOnly) {
        blocks.push(
          createBlock({
            type: 'file_chip',
            path: fileOnly[1].trim(),
            text: (fileOnly[2] || fileOnly[1]).trim(),
          })
        );
        i++;
        continue;
      }

      // TOC: @[toc] or <!-- conex:toc -->
      var tocParsed =
        window.MdxBlocksToc && window.MdxBlocksToc.parseMdLine
          ? window.MdxBlocksToc.parseMdLine(line)
          : null;
      if (
        tocParsed ||
        /^\s*@\[toc\]\s*$/i.test(line) ||
        /^\s*<!--\s*conex:toc\s*-->\s*$/i.test(line)
      ) {
        blocks.push(createBlock({ type: 'toc', text: '' }));
        i++;
        continue;
      }

      // standalone GFM image: ![alt](url "title")
      var imgParsed =
        window.MdxBlocksImage && window.MdxBlocksImage.parseMdLine
          ? window.MdxBlocksImage.parseMdLine(line)
          : null;
      if (!imgParsed) {
        var imgM = line.match(
          /^\s*!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*\)\s*$/
        );
        if (imgM) {
          var rawSrc = (imgM[2] || '').trim();
          var safeOk =
            !window.MdxBlocksImage ||
            !window.MdxBlocksImage.isSafeSrc ||
            window.MdxBlocksImage.isSafeSrc(rawSrc);
          if (safeOk) {
            imgParsed = {
              type: 'image',
              src: rawSrc,
              alt: imgM[1] || '',
              title: imgM[3] != null ? imgM[3] : imgM[4] != null ? imgM[4] : '',
            };
            if (imgParsed.title) imgParsed.caption = imgParsed.title;
          }
        }
      }
      if (imgParsed && imgParsed.type === 'image') {
        blocks.push(
          createBlock({
            type: 'image',
            src: imgParsed.src || '',
            alt: imgParsed.alt || '',
            text: imgParsed.alt || '',
            title: imgParsed.title || '',
            caption: imgParsed.caption || imgParsed.title || '',
          })
        );
        i++;
        continue;
      }

      // blank
      if (!line.trim()) {
        // skip consecutive blanks (don't create empty paras between)
        i++;
        continue;
      }

      // paragraph (merge consecutive non-special lines)
      var pbuf = [line];
      i++;
      while (i < lines.length) {
        var n = lines[i];
        if (!n.trim()) break;
        if (/^```/.test(n)) break;
        if (/^\s*\$\$/.test(n)) break;
        if (/^#{1,6}\s/.test(n)) break;
        if (listMatch(n)) break;
        if (/^\s{0,3}>/.test(n)) break;
        if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(n)) break;
        if (n.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) break;
        if (/^:::\s*/.test(n)) break;
        if (/^\s*@\[toc\]\s*$/i.test(n)) break;
        if (/^\s*<!--\s*conex:toc\s*-->\s*$/i.test(n)) break;
        if (/^\s*!\[/.test(n) && /\]\(/.test(n)) break;
        if (/^\s*\[\[file:/.test(n)) break;
        pbuf.push(n);
        i++;
      }
      blocks.push(createBlock({ type: 'paragraph', text: pbuf.join('\n') }));
    }

    if (!blocks.length) {
      blocks.push(createBlock({ type: 'paragraph', text: '' }));
    }

    return { version: docVersion(), blocks: blocks };
  }

  window.MdxParse = { parse: parse };
})();
