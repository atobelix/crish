/**
 * Node smoke tests for schema migrate + parse ↔ serialize roundtrip.
 * Run: node tests/markdown-editor/roundtrip.test.js
 *
 * Load order mirrors index.js comment:
 *   util → schema → model → parse → serialize → registry
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '../..');
const ctx = {
  console,
  window: {},
  Date,
  Math,
  JSON,
  Array,
  Object,
  String,
  Number,
  Boolean,
  parseInt,
  parseFloat,
  isNaN,
  Infinity,
  setTimeout,
  clearTimeout,
};
ctx.window = ctx;
vm.createContext(ctx);

function load(rel) {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  vm.runInContext(code, ctx);
}

load('js/markdown-editor/util.js');
load('js/markdown-editor/schema.js');
load('js/markdown-editor/model.js');
load('js/markdown-editor/blocks/image.js');
load('js/markdown-editor/blocks/toc.js');
load('js/markdown-editor/blocks/mermaid.js');
load('js/markdown-editor/blocks/math.js');
load('js/markdown-editor/parse.js');
load('js/markdown-editor/serialize.js');
load('js/markdown-editor/registry.js');
// re-register after registry exists
if (ctx.window.MdxBlocksMath && ctx.window.MdxBlocksMath.register) ctx.window.MdxBlocksMath.register();
if (ctx.window.MdxBlocksMermaid && ctx.window.MdxBlocksMermaid.register) ctx.window.MdxBlocksMermaid.register();
load('js/markdown-editor/ui/slash-menu.js');
load('js/markdown-editor/table/selection.js');
load('js/markdown-editor/table/merge.js');

const parse = ctx.window.MdxParse.parse;
const serialize = ctx.window.MdxSerialize.serialize;
const Schema = ctx.window.MdxSchema;
const Model = ctx.window.MdxModel;
const Registry = ctx.window.MdxRegistry;
const TableSel = ctx.window.MdxTableSelection;
const TableMerge = ctx.window.MdxTableMerge;
const BlocksMath = ctx.window.MdxBlocksMath;
const BlocksMermaid = ctx.window.MdxBlocksMermaid;
const MdxUtil = ctx.window.MdxUtil;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error('FAIL:', msg);
  }
}

function normalize(md) {
  return String(md || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ---------- schema-migrate ---------- */

(function schemaMigrateTests() {
  const migrated = Schema.migrate({
    version: 1,
    blocks: [{ type: 'paragraph', text: 'a' }],
  });
  assert(migrated.version === 2, 'migrate({version:1,...}) → version 2');
  assert(migrated.blocks.length === 1, 'migrate keeps one block');
  assert(migrated.blocks[0].type === 'paragraph', 'migrate paragraph type');
  assert(migrated.blocks[0].text === 'a', 'migrate text a');
  assert(migrated.blocks[0].indent === 0, 'migrate fills indent 0');
  assert(!!migrated.blocks[0].id, 'migrate assigns id');

  const noVer = Schema.migrate({
    blocks: [{ type: 'heading', level: 2, text: 'H' }],
  });
  assert(noVer.version === 2, 'migrate missing version → 2');

  const tableRowsOnly = Schema.migrate({
    version: 1,
    blocks: [
      {
        type: 'table',
        rows: [
          ['A', 'B'],
          ['1', '2'],
        ],
        hasHeader: true,
      },
    ],
  });
  const tb = tableRowsOnly.blocks[0];
  assert(tb.rows && tb.rows[0][0] === 'A', 'table rows preserved');
  assert(tb.cells && tb.cells[0][0].text === 'A', 'table rows → cells sync');

  const unknown = Schema.migrate({
    blocks: [{ type: 'not_a_real_type', text: 'x' }],
  });
  assert(unknown.blocks[0].type === 'paragraph', 'unknown type → paragraph');
  assert(
    unknown.blocks[0].meta && unknown.blocks[0].meta.unknownType === 'not_a_real_type',
    'unknown type kept in meta'
  );

  const empty = Schema.migrate(null);
  assert(empty.version === 2 && empty.blocks.length === 1, 'migrate null → emptyDoc v2');
})();

/* ---------- model createModel migrate + undo API ---------- */

(function modelTests() {
  const model = Model.createModel({
    version: 1,
    blocks: [{ type: 'paragraph', text: 'a' }],
  });
  assert(model.getDoc().version === 2, 'createModel migrates to v2');
  assert(model.getBlocks()[0].text === 'a', 'createModel keeps text');

  model.updateBlock(model.getBlocks()[0].id, { text: 'b' });
  assert(model.getBlocks()[0].text === 'b', 'updateBlock');
  assert(model.undo(), 'undo works');
  assert(model.getBlocks()[0].text === 'a', 'undo restores');
  assert(model.redo(), 'redo works');
  assert(model.getBlocks()[0].text === 'b', 'redo restores');
})();

/* ---------- registry ---------- */

(function registryTests() {
  assert(typeof Registry.register === 'function', 'registry.register');
  assert(Registry.list().length === 0, 'registry starts empty');
  Registry.register({
    type: 'custom_demo',
    slash: { title: '自定义', aliases: ['custom'], section: '扩展' },
  });
  assert(Registry.get('custom_demo').type === 'custom_demo', 'registry.get');
  assert(Registry.slashCommands().length === 1, 'registry.slashCommands');
  assert(Registry.slashCommands()[0].title === '自定义', 'slash title');
  Registry.clear();
  assert(Registry.list().length === 0, 'registry.clear');
})();

/* ---------- md roundtrip ---------- */

const fixtures = [
  {
    name: 'heading+para',
    md: '# 标题\n\n正文段落。\n',
  },
  {
    name: 'lists',
    md: '- 甲\n- 乙\n\n1. 一\n1. 二\n',
  },
  {
    name: 'task',
    md: '- [ ] 待办\n- [x] 已完成\n',
  },
  {
    name: 'code',
    md: '```js\nconst a = 1;\n```\n',
  },
  {
    name: 'table',
    md: '| 模块 | 变更 |\n| --- | --- |\n| a.ts | +1 |\n',
  },
  {
    name: 'quote',
    md: '> 引用一行\n',
  },
  {
    name: 'divider',
    md: '上\n\n---\n\n下\n',
  },
  {
    name: 'callout',
    md: '> [!TIP] 提示\n> 内容\n',
  },
  {
    name: 'file chip',
    md: '[[file:src/a.ts]]\n',
  },
  {
    name: 'file chip labeled',
    md: '[[file:docs/design.md|设计说明]]\n',
  },
  {
    name: 'image gfm',
    md: '![示意图](assets/icons/image.svg "title")\n',
  },
  {
    name: 'image plain',
    md: '![alt](https://example.com/a.png)\n',
  },
  {
    name: 'toc block',
    md: '@[toc]\n',
  },
  {
    name: 'inline marks',
    md: '这是 **粗体** 与 `code` 以及 [链接](https://example.com)。\n',
  },
  {
    name: 'empty',
    md: '',
  },
  {
    name: 'mixed chinese',
    md: '## 重构说明\n\n- 连接池\n- 背压\n\n```ts\ntype X = number;\n```\n',
  },
];

fixtures.forEach(function (fx) {
  const doc = parse(fx.md);
  assert(doc && Array.isArray(doc.blocks) && doc.blocks.length > 0, fx.name + ' parses');
  assert(doc.version === 2, fx.name + ' parse version=2');
  const out = serialize(doc);
  const doc2 = parse(out);
  const out2 = serialize(doc2);
  // structural stability: second roundtrip equals first serialize
  assert(
    normalize(out) === normalize(out2),
    fx.name + ' stable serialize: ' + JSON.stringify(out) + ' vs ' + JSON.stringify(out2)
  );
});

// table parse has rows + cells
(function tableShape() {
  const doc = parse('| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  const t = doc.blocks.find(function (b) {
    return b.type === 'table';
  });
  assert(!!t, 'table block exists');
  assert(t.rows && t.rows[0][0] === 'A', 'table rows primary');
  assert(t.cells && t.cells[1][1].text === '2', 'table cells synced');
  const md = serialize(doc);
  assert(md.indexOf('| A | B |') >= 0 || md.indexOf('| A | B |') >= 0, 'serialize table head');
})();

// W6 image / toc / file_chip semantics
(function mediaStructure() {
  const imgDoc = parse('![示意图](https://example.com/a.png "t")\n');
  const img = imgDoc.blocks.find(function (b) {
    return b.type === 'image';
  });
  assert(!!img, 'image block parsed');
  assert(img.src === 'https://example.com/a.png', 'image src');
  assert(img.alt === '示意图', 'image alt');
  assert(img.title === 't' || img.caption === 't', 'image title/caption');
  const imgMd = serialize(imgDoc);
  assert(imgMd.indexOf('![示意图](') >= 0, 'image serialize md');
  assert(imgMd.indexOf('https://example.com/a.png') >= 0, 'image serialize src');

  const tocDoc = parse('# A\n\n@[toc]\n\n## B\n');
  const toc = tocDoc.blocks.find(function (b) {
    return b.type === 'toc';
  });
  assert(!!toc, 'toc block parsed');
  assert(normalize(serialize(tocDoc)).indexOf('@[toc]') >= 0, 'toc serialize @[toc]');

  const fileDoc = parse('[[file:src/a.ts|入口]]\n');
  const fc = fileDoc.blocks.find(function (b) {
    return b.type === 'file_chip';
  });
  assert(!!fc, 'file_chip block');
  assert(fc.path === 'src/a.ts', 'file_chip path');
  assert(fc.text === '入口', 'file_chip label');

  // wiki label inline html
  const wikiHtml = ctx.window.MdxUtil.inlineHtml('见 [[doc:标题|显示名]]');
  assert(wikiHtml.indexOf('data-mdx-doc') >= 0, 'wiki data attr');
  assert(wikiHtml.indexOf('显示名') >= 0, 'wiki label text');

  // image readHtml figure
  const Image = ctx.window.MdxBlocksImage;
  assert(!!Image && typeof Image.readHtml === 'function', 'MdxBlocksImage');
  const rh = Image.readHtml({ type: 'image', src: 'https://x/y.png', alt: 'a', caption: 'c' });
  assert(rh.indexOf('<figure') >= 0 && rh.indexOf('mdx-img') >= 0, 'image figure class');
  assert(rh.indexOf('mdx-image__caption') >= 0, 'image caption');

  // toc items
  const Toc = ctx.window.MdxBlocksToc;
  assert(!!Toc && typeof Toc.buildItems === 'function', 'MdxBlocksToc');
  const items = Toc.buildItems([
    { id: 'h1', type: 'heading', level: 1, text: '你好 World' },
    { id: 'h2', type: 'heading', level: 2, text: '你好 World' },
  ]);
  assert(items.length === 2, 'toc items count');
  assert(items[0].anchor !== items[1].anchor, 'toc anchors unique');
  assert(items[0].anchor.indexOf('你好') >= 0 || items[0].anchor.indexOf('world') >= 0, 'chinese-friendly slug');

  // slash menu has image + toc
  const Slash = ctx.window.MdxSlashMenu;
  assert(!!Slash, 'MdxSlashMenu');
  const cmds = Slash.allCommands();
  assert(
    cmds.some(function (c) {
      return c.id === 'image';
    }),
    'slash has image'
  );
  assert(
    cmds.some(function (c) {
      return c.id === 'toc';
    }),
    'slash has toc'
  );
  const imgPatch = Slash.patchForCommand(cmds.find(function (c) {
    return c.id === 'image';
  }));
  assert(imgPatch && imgPatch.type === 'image', 'slash image patch');
})();

// model move (compat)
const model = Model.createModel(parse('# A\n\n## B\n\npara\n'));
assert(model.getBlocks().length >= 2, 'model has blocks');
model.moveBlock(0, 2);
assert(model.getBlocks()[0].type === 'heading', 'move keeps types');

// slash conversion shape: update block type
const b0 = model.getBlocks()[0];
model.updateBlock(b0.id, { type: 'bullet_item', text: 'x', level: undefined });
assert(model.getBlocks()[0].type === 'bullet_item', 'update type');

// cloneDoc deep copy independence
const d1 = Schema.cloneDoc(model.getDoc());
d1.blocks[0].text = '__mutated__';
assert(model.getBlocks()[0].text !== '__mutated__', 'cloneDoc is deep');

/* ---------- W3 table selection + merge / GFM expand-blank ---------- */

(function tableSelectionApi() {
  assert(!!TableSel && typeof TableSel.create === 'function', 'MdxTableSelection.create');
  const sel = TableSel.create();
  sel.begin(0, 0);
  sel.extend(1, 2);
  const range = sel.getRange();
  assert(range && range.r0 === 0 && range.c0 === 0 && range.r1 === 1 && range.c1 === 2, 'selection range');
  assert(sel.cellCount() === 6, 'selection cellCount 2x3=6');
  assert(sel.isSelected(1, 1), 'isSelected inside');
  assert(!sel.isSelected(2, 0), 'isSelected outside');
  sel.extendByKey('ArrowRight', { maxR: 5, maxC: 5 });
  assert(sel.getFocus().c === 3, 'extendByKey ArrowRight');
  sel.clear();
  assert(sel.getRange() === null, 'clear selection');
})();

(function tableMergeSplit() {
  assert(!!TableMerge && typeof TableMerge.merge === 'function', 'MdxTableMerge.merge');
  const block = Schema.createBlock({
    type: 'table',
    hasHeader: true,
    cells: [
      [
        { text: 'H1', header: true },
        { text: 'H2', header: true },
        { text: 'H3', header: true },
      ],
      [{ text: 'a' }, { text: 'b' }, { text: 'c' }],
      [{ text: 'd' }, { text: 'e' }, { text: 'f' }],
    ],
  });
  // body 2x2 merge
  const cells = [
    { r: 1, c: 0 },
    { r: 1, c: 1 },
    { r: 2, c: 0 },
    { r: 2, c: 1 },
  ];
  const can = TableMerge.canMerge(block, cells);
  assert(can.ok, 'canMerge 2x2 body');
  const m = TableMerge.merge(block, cells);
  assert(m.ok, 'merge ok');
  assert(block.cells[1][0].rowspan === 2 && block.cells[1][0].colspan === 2, 'anchor rs/cs');
  assert(block.cells[1][0].text === 'a b d e', 'merge join texts');
  assert(block.cells[1][1].covered === true, 'covered flag');
  assert(block.cells[2][0].anchor && block.cells[2][0].anchor.r === 1, 'covered anchor');

  // cloneCells preserves merge
  const cloned = Schema.createBlock(block);
  assert(cloned.cells[1][0].rowspan === 2, 'cloneCells keeps rowspan');
  assert(cloned.cells[1][1].covered === true, 'cloneCells keeps covered');

  // cross-header should fail
  const cross = TableMerge.canMerge(block, [
    { r: 0, c: 0 },
    { r: 1, c: 0 },
  ]);
  assert(!cross.ok && cross.reason === 'cross-header', 'no cross-header merge');

  // GFM expand-blank: covered empty, anchor text only
  const md = serialize({ version: 2, blocks: [block] });
  assert(md.indexOf('| a b d e |') >= 0 || md.indexOf('a b d e') >= 0, 'serialize has anchor text');
  // row2 col0 covered → empty in expand-blank (second body row starts with empty)
  const lines = md.trim().split('\n');
  // header, sep, body1, body2
  assert(lines.length >= 4, 'table has >=4 lines');
  const body2 = lines[3];
  // covered slots blank: first two cells of row2 empty or sparse
  assert(/^\|(\s*\|)/.test(body2) || body2.indexOf('|  |') >= 0 || body2.indexOf('| |') >= 0, 'expand-blank covered empty: ' + body2);

  const sp = TableMerge.split(block, 1, 0);
  assert(sp.ok, 'split ok');
  assert((block.cells[1][0].rowspan || 1) === 1, 'split clears rowspan');
  assert(!block.cells[1][1].covered, 'split clears covered');
  assert(block.cells[1][0].text === 'a b d e', 'content stays on anchor');
})();

/* ---------- W7 math + mermaid ---------- */

(function w7MathMermaid() {
  assert(!!BlocksMath, 'MdxBlocksMath loaded');
  assert(!!BlocksMermaid, 'MdxBlocksMermaid loaded');

  const mmdDoc = parse('```mermaid\ngraph LR\n  A --> B\n```\n');
  const mmd = mmdDoc.blocks[0];
  assert(mmd.type === 'code' && mmd.lang === 'mermaid', 'parse mermaid → code+lang');
  assert(/A\s*-->\s*B/.test(mmd.text || ''), 'mermaid body');
  assert(BlocksMermaid.isMermaidBlock(mmd), 'isMermaidBlock');
  const mmdRead = BlocksMermaid.readHtml(mmd);
  assert(/mdx-mermaid/.test(mmdRead) && /mdx-mermaid-fallback/.test(mmdRead), 'mermaid readHtml fallback');
  assert(!/click to render/i.test(mmdRead), 'mermaid no CTA essay');

  const mathDoc = parse('$$\nE = mc^2\n$$\n');
  const mb = mathDoc.blocks[0];
  assert(mb.type === 'math', 'parse $$ → math');
  assert(/E\s*=\s*mc\^2/.test(mb.text || ''), 'math body');
  const mathSer = serialize(mathDoc);
  assert(/\$\$/.test(mathSer) && /E\s*=\s*mc\^2/.test(mathSer), 'serialize math $$');
  const mathBack = parse(mathSer);
  assert(mathBack.blocks[0].type === 'math', 'math roundtrip type');

  const single = parse('$$a+b$$\n');
  assert(single.blocks[0].type === 'math' && single.blocks[0].text === 'a+b', 'single-line $$');

  const mmdSer = serialize(mmdDoc);
  assert(/```mermaid/.test(mmdSer), 'serialize mermaid fence');

  // type=mermaid still serializes as fence
  const typeMmd = Schema.createBlock({ type: 'mermaid', text: 'graph TD\n  X-->Y' });
  const typeSer = serialize({ version: 2, blocks: [typeMmd] });
  assert(/```mermaid/.test(typeSer), 'type=mermaid → fence');

  const inline = MdxUtil.inlineHtml('energy $E=mc^2$ end');
  assert(/mdx-math-inline/.test(inline), 'inline $math$');
  const money = MdxUtil.inlineHtml('价格 $3 到 $5');
  const mathCount = (money.match(/mdx-math-inline/g) || []).length;
  assert(mathCount === 0, 'currency $ not math: count=' + mathCount);

  assert(!!Registry.get('math'), 'registry math');
  assert(!!Registry.get('mermaid'), 'registry mermaid');
})();

console.log('passed=' + passed + ' failed=' + failed);
process.exit(failed ? 1 : 0);
