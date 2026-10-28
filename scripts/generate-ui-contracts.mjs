#!/usr/bin/env node
/**
 * scripts/generate-ui-contracts.mjs
 * UI 原子组件契约与 llms.txt 自动化生成器 (P06 · PE-06 / T-P06-02)
 *
 * 遍历 apps/crish-desktop/src/components/ui/ 下各组件 TSX，
 * 通过 TypeScript 编译器 AST 递归提取组件名称、*Props 接口字段、JSDoc 注释与默认值，
 * 自动输出生成 apps/crish-desktop/src/components/ui/llms.txt。
 *
 * 用法：
 *   node scripts/generate-ui-contracts.mjs           # 生成 llms.txt
 *   node scripts/generate-ui-contracts.mjs --check   # 校验 llms.txt 是否与当前源码同步
 */

import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// 自适应路径探测：抽取独立包后优先读取 packages/ui/src，抽取前平滑兼容 apps/crish-desktop/src/components/ui
const UI_PKG_DIR = fs.existsSync(path.resolve(ROOT, 'packages/ui'))
  ? path.resolve(ROOT, 'packages/ui')
  : path.resolve(ROOT, 'apps/crish-desktop/src/components/ui');

const UI_SRC_DIR = fs.existsSync(path.resolve(UI_PKG_DIR, 'src'))
  ? path.resolve(UI_PKG_DIR, 'src')
  : UI_PKG_DIR;

const OUTPUT_LLMS = path.resolve(UI_PKG_DIR, 'llms.txt');

// 核心组件标准代码范例字典
const VERIFIED_EXAMPLES = {
  Button: `import { Button } from '@/components/ui';

export function Example() {
  return (
    <Button variant="primary" size="md" onClick={() => {}}>
      主要操作
    </Button>
  );
}`,
  IconButton: `import { IconButton } from '@/components/ui';
import { PlayIcon } from '@hugeicons/react';

export function Example() {
  return (
    <IconButton aria-label="运行任务" size="md" onClick={() => {}}>
      <PlayIcon />
    </IconButton>
  );
}`,
  Input: `import { Input } from '@/components/ui';

export function Example() {
  return (
    <Input
      variant="default"
      size="md"
      placeholder="请输入内容..."
      clearable
    />
  );
}`,
  Textarea: `import { Textarea } from '@/components/ui';

export function Example() {
  return (
    <Textarea
      size="md"
      placeholder="输入多行文本..."
      rows={4}
    />
  );
}`,
  Field: `import { Field, FieldLabel, FieldControl, FieldHint, Input } from '@/components/ui';

export function Example() {
  return (
    <Field>
      <FieldLabel>用户名</FieldLabel>
      <FieldControl>
        <Input placeholder="请输入用户名" />
      </FieldControl>
      <FieldHint>支持字母与数字</FieldHint>
    </Field>
  );
}`,
  FormItem: `import { FormItem, FieldLabel, FieldControl, Input } from '@/components/ui';

export function Example() {
  return (
    <FormItem label="邮箱">
      <Input placeholder="请输入常用邮箱" />
    </FormItem>
  );
}`,
  Tooltip: `import { Tooltip, Button } from '@/components/ui';

export function Example() {
  return (
    <Tooltip content="操作提示文案">
      <Button variant="ghost">悬停查看</Button>
    </Tooltip>
  );
}`,
  Dialog: `import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  Button,
} from '@/components/ui';

export function Example({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>对话框标题</DialogTitle>
        </DialogHeader>
        <DialogBody>对话框正文内容...</DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={onClose}>确定</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}`,
  ConfirmDialog: `import { ConfirmDialog } from '@/components/ui';

export function Example({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <ConfirmDialog
      open={open}
      title="确认删除"
      description="此操作不可逆，确定继续？"
      confirmText="删除"
      cancelText="取消"
      variant="danger"
      onConfirm={() => onClose()}
      onCancel={() => onClose()}
    />
  );
}`,
  Switch: `import { Switch } from '@/components/ui';

export function Example({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return <Switch checked={checked} onCheckedChange={onChange} size="md" />;
}`,
  SegmentedControl: `import { SegmentedControl } from '@/components/ui';

export function Example({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <SegmentedControl
      value={value}
      onChange={onChange}
      options={[
        { label: '全部', value: 'all' },
        { label: '活跃', value: 'active' },
        { label: '归档', value: 'archived' },
      ]}
    />
  );
}`,
  Badge: `import { Badge } from '@/components/ui';

export function Example() {
  return <Badge tone="accent" size="sm">运行中</Badge>;
}`,
  Slider: `import { Slider } from '@/components/ui';

export function Example({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return <Slider value={value} min={0} max={100} step={1} onChange={onChange} />;
}`,
  Select: `import { Select } from '@/components/ui';

export function Example({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Select
      value={value}
      onChange={onChange}
      options={[
        { label: '选项一', value: 'opt1' },
        { label: '选项二', value: 'opt2' },
      ]}
    />
  );
}`,
  Combobox: `import { Combobox } from '@/components/ui';

export function Example({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <Combobox
      value={value}
      onChange={onChange}
      placeholder="搜索或选择..."
    />
  );
}`,
  Tabs: `import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui';

export function Example() {
  return (
    <Tabs defaultValue="tab1">
      <TabsList>
        <TabsTrigger value="tab1">概览</TabsTrigger>
        <TabsTrigger value="tab2">配置</TabsTrigger>
      </TabsList>
      <TabsContent value="tab1">概览面板内容</TabsContent>
      <TabsContent value="tab2">配置面板内容</TabsContent>
    </Tabs>
  );
}`,
  Card: `import { Card } from '@/components/ui';

export function Example() {
  return (
    <Card padding="md">
      卡片内容区域
    </Card>
  );
}`,
  Row: `import { Row } from '@/components/ui';

export function Example() {
  return (
    <Row height="md" hoverable>
      列表行项目
    </Row>
  );
}`,
  ScrollArea: `import { ScrollArea } from '@/components/ui';

export function Example() {
  return (
    <ScrollArea style={{ maxHeight: 300 }}>
      <div>长列表滚动内容...</div>
    </ScrollArea>
  );
}`,
  DisclosureAffordance: `import { DisclosureAffordance } from '@/components/ui';

export function Example({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <DisclosureAffordance open={open} onClick={onToggle} />;
}`,
  ContextMenu: `import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui';

export function Example() {
  return (
    <ContextMenu>
      <ContextMenuTrigger>右键点击此区域</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => {}}>复制</ContextMenuItem>
        <ContextMenuItem onSelect={() => {}}>粘贴</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}`,
  PreviewCard: `import {
  PreviewCard,
  PreviewCardTrigger,
  PreviewCardContent,
} from '@/components/ui';

export function Example() {
  return (
    <PreviewCard>
      <PreviewCardTrigger>悬停预览</PreviewCardTrigger>
      <PreviewCardContent>预览卡片详情信息</PreviewCardContent>
    </PreviewCard>
  );
}`,
  SmartExpandablePanel: `import { SmartExpandablePanel } from '@/components/ui';

export function Example({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <SmartExpandablePanel open={open} onClose={onClose}>
      面板扩展内容
    </SmartExpandablePanel>
  );
}`,
  SmartModelBadge: `import { SmartModelBadge } from '@/components/ui';

export function Example() {
  return <SmartModelBadge model="claude-3-5-sonnet" />;
}`,
  TabStrip: `import { TabStrip } from '@/components/ui';

export function Example({ activeId, onSelect }: { activeId: string; onSelect: (id: string) => void }) {
  return (
    <TabStrip
      items={[
        { id: '1', title: '标签页 1' },
        { id: '2', title: '标签页 2' },
      ]}
      activeId={activeId}
      onSelect={onSelect}
    />
  );
}`,
  Menu: `import { Menu } from '@/components/ui';

export function Example() {
  return (
    <Menu
      options={[
        { label: '菜单项 1', value: 'item1' },
        { label: '菜单项 2', value: 'item2' },
      ]}
      onSelect={() => {}}
    />
  );
}`,
  AnimatedCounter: `import { AnimatedCounter } from '@/components/ui/AnimatedCounter/AnimatedCounter';

export function Example({ value }: { value: number }) {
  return <AnimatedCounter value={value} />;
}`,
  ColorPicker: `import { ColorPicker } from '@/components/ui/ColorPicker/ColorPicker';

export function Example({ color, onChange }: { color: string; onChange: (c: string) => void }) {
  return <ColorPicker value={color} onChange={onChange} />;
}`,
  TextMorph: `import { TextMorph } from '@/components/ui/TextMorph/TextMorph';

export function Example({ text }: { text: string }) {
  return <TextMorph text={text} />;
}`,
};

/**
 * 递归收集指定目录下所有非测试 TS/TSX 源码文件
 */
function collectSourceFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...collectSourceFiles(fullPath));
      }
    } else if (
      (entry.name.endsWith('.tsx') || (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))) &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.') &&
      !entry.name.includes('.stories.') &&
      !entry.name.includes('.preview.')
    ) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * 从 JSDoc 节点中抽取描述与 @default 标签
 */
function extractJSDocInfo(node) {
  const comments = ts.getJSDocCommentsAndTags(node);
  let description = '';
  let defaultValue = null;

  for (const c of comments) {
    if (ts.isJSDoc(c)) {
      if (typeof c.comment === 'string') {
        description = c.comment;
      } else if (Array.isArray(c.comment)) {
        description = c.comment.map(part => part.text).join('');
      }
    }
    if (c.tags) {
      for (const tag of c.tags) {
        if (tag.tagName.text === 'default') {
          if (typeof tag.comment === 'string') {
            defaultValue = tag.comment.trim();
          } else if (Array.isArray(tag.comment)) {
            defaultValue = tag.comment.map(part => part.text).join('').trim();
          }
        }
      }
    }
  }

  // 辅助检测：如果 JSDoc 注释中包含（默认 'xxx'）或（默认 xxx）
  if (!defaultValue && description) {
    const defaultMatch = description.match(/[（(]默认\s*(?:为\s*)?['"`]?([a-zA-Z0-9_\-.]+)['"`]?[）)]/);
    if (defaultMatch && defaultMatch[1]) {
      defaultValue = `'${defaultMatch[1].trim()}'`;
    }
  }

  return { description, defaultValue };
}

/**
 * 清理 JSDoc 描述字符串，用于 Markdown 表格单元格
 */
function cleanDescription(desc) {
  if (!desc) return '-';
  return desc
    .replace(/\r?\n/g, ' ')
    .replace(/\|/g, '\\|')
    .replace(/\s+/g, ' ')
    .trim() || '-';
}

/**
 * 清理 TypeScript 类型表达式，防止 Markdown 表格解析断裂
 */
function cleanTypeString(typeStr) {
  if (!typeStr) return 'any';
  return typeStr
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 递归收集函数参数中的解构默认值
 */
function extractParamDefaults(rootNode, sourceFile) {
  const defaults = new Map();

  function visit(node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (node.parameters.length > 0) {
        const p0 = node.parameters[0];
        if (ts.isObjectBindingPattern(p0.name)) {
          for (const element of p0.name.elements) {
            const propName = element.propertyName
              ? element.propertyName.getText(sourceFile)
              : element.name.getText(sourceFile);
            if (element.initializer) {
              const val = element.initializer.getText(sourceFile).trim();
              defaults.set(propName, val);
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(rootNode);
  return defaults;
}

/**
 * 解析单个源码文件
 */
export function parseSourceFile(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
    code,
    ts.ScriptTarget.Latest,
    true
  );

  const interfaces = new Map();
  const typeAliases = new Map();
  const components = [];
  const componentDocs = new Map();
  const paramDefaults = extractParamDefaults(sourceFile, sourceFile);

  // 文件顶部 JSDoc 注释
  let fileDoc = '';
  const fileComments = ts.getLeadingCommentRanges(code, 0);
  if (fileComments && fileComments.length > 0) {
    const commentText = code.substring(fileComments[0].pos, fileComments[0].end);
    fileDoc = commentText
      .replace(/^\/\*\*?/, '')
      .replace(/\*\/$/, '')
      .split('\n')
      .map(line => line.replace(/^\s*\*\s?/, '').trim())
      .filter(line => line && !line.startsWith('@'))
      .slice(0, 3)
      .join(' ');
  }

  function visit(node) {
    // 1. 抽取 interface
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.text;
      const propList = [];
      for (const member of node.members) {
        if (ts.isPropertySignature(member)) {
          const propName = member.name.getText(sourceFile);
          const rawType = member.type ? member.type.getText(sourceFile) : 'any';
          const optional = Boolean(member.questionToken);
          const jsDoc = extractJSDocInfo(member);
          const defaultValue = paramDefaults.get(propName) || jsDoc.defaultValue || '-';
          propList.push({
            name: propName,
            rawType,
            optional,
            defaultValue,
            description: cleanDescription(jsDoc.description),
          });
        }
      }
      interfaces.set(name, propList);
    }

    // 2. 抽取 type alias (如 type ButtonProps = ...)
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.text;
      if (ts.isTypeLiteralNode(node.type)) {
        const propList = [];
        for (const member of node.type.members) {
          if (ts.isPropertySignature(member)) {
            const propName = member.name.getText(sourceFile);
            const rawType = member.type ? member.type.getText(sourceFile) : 'any';
            const optional = Boolean(member.questionToken);
            const jsDoc = extractJSDocInfo(member);
            const defaultValue = paramDefaults.get(propName) || jsDoc.defaultValue || '-';
            propList.push({
              name: propName,
              rawType,
              optional,
              defaultValue,
              description: cleanDescription(jsDoc.description),
            });
          }
        }
        interfaces.set(name, propList);
      } else {
        // 保存类型别名定义，便于类型提示展开
        typeAliases.set(name, node.type.getText(sourceFile));
      }
    }

    // 3. 抽取导出的函数组件
    if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text)) {
      const isExp = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExp) {
        const compName = node.name.text;
        components.push(compName);
        const doc = extractJSDocInfo(node);
        if (doc.description) {
          componentDocs.set(compName, doc.description.replace(/\r?\n/g, ' ').trim());
        }
      }
    }

    // 4. 抽取导出的变量组件（React.forwardRef 等）
    if (ts.isVariableStatement(node)) {
      const isExp = node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isExp) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && /^[A-Z]/.test(decl.name.text)) {
            const compName = decl.name.text;
            components.push(compName);
            const doc = extractJSDocInfo(node);
            if (doc.description) {
              componentDocs.set(compName, doc.description.replace(/\r?\n/g, ' ').trim());
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return {
    filePath,
    fileDoc,
    components,
    componentDocs,
    interfaces,
    typeAliases,
  };
}

/**
 * 判断名称是否为合法的 React 组件名称（PascalCase 且含小写字母，排除常量与纯大写定义）
 */
function isValidComponentName(name) {
  if (!name || typeof name !== 'string') return false;
  if (!/^[A-Z]/.test(name)) return false;
  // 排除纯大写常量 (如 DEFAULT_DELAY_SHOW_MS, BASE_UI_DATA_ATTRS)
  if (!/[a-z]/.test(name)) return false;
  // 排除 Context 与 Hook 与非组件
  if (name.endsWith('Context') || name.endsWith('Adapter') || name.endsWith('Engine')) return false;
  return true;
}

/**
 * 主构建逻辑
 */
export function generateContracts() {
  const sourceFiles = collectSourceFiles(UI_SRC_DIR);
  const allInterfaces = new Map();
  const allTypeAliases = new Map();
  const fileDataList = [];

  for (const file of sourceFiles) {
    const data = parseSourceFile(file);
    fileDataList.push(data);
    for (const [name, props] of data.interfaces.entries()) {
      allInterfaces.set(name, props);
    }
    for (const [name, typeDef] of data.typeAliases.entries()) {
      allTypeAliases.set(name, typeDef);
    }
  }

  // 组件清单收敛
  const componentCatalog = [];
  const seenComps = new Set();

  for (const data of fileDataList) {
    for (const compName of data.components) {
      if (seenComps.has(compName)) continue;
      if (!isValidComponentName(compName)) continue;

      seenComps.add(compName);

      // 寻找对应的 Props 接口
      let propsName = `${compName}Props`;
      let propsList = allInterfaces.get(propsName) || [];

      // 兜底匹配：部分组件如 Combobox 使用 ComboboxRootProps
      if (propsList.length === 0) {
        if (allInterfaces.has(`${compName}RootProps`)) {
          propsName = `${compName}RootProps`;
          propsList = allInterfaces.get(propsName);
        } else if (compName === 'SmartExpandablePanel' || compName === 'SmartPanel') {
          propsName = 'SmartPanelProps';
          propsList = allInterfaces.get('SmartPanelProps') || [];
        }
      }

      // 格式化 Props 列表：展开局部联合类型别名
      const formattedProps = propsList.map(p => {
        let typeStr = p.rawType;
        if (allTypeAliases.has(typeStr)) {
          const aliasVal = allTypeAliases.get(typeStr);
          // 若为字面量联合类型，则直接替换为联合值以利于 LLM 识别
          if (aliasVal.includes('|') && aliasVal.length < 120) {
            typeStr = aliasVal;
          }
        }
        return {
          name: p.name,
          type: cleanTypeString(typeStr),
          optional: p.optional,
          defaultValue: p.defaultValue,
          description: p.description,
        };
      });

      // 抽取组件描述
      let description = data.componentDocs.get(compName) || data.fileDoc || `${compName} UI 原子交互基元。`;
      description = cleanDescription(description);

      const relPath = path.relative(ROOT, data.filePath).replace(/\\/g, '/');

      componentCatalog.push({
        name: compName,
        propsName,
        path: relPath,
        description,
        props: formattedProps,
      });
    }
  }

  // 排序：先展示核心常用基元，再按字母顺序排列
  const PRIORITY_ORDER = [
    'Button',
    'IconButton',
    'Input',
    'Textarea',
    'Field',
    'FormItem',
    'Tooltip',
    'Dialog',
    'ConfirmDialog',
    'Switch',
    'SegmentedControl',
    'Badge',
    'Slider',
    'Select',
    'Combobox',
    'Tabs',
    'Card',
    'Row',
    'ScrollArea',
    'DisclosureAffordance',
    'ContextMenu',
    'PreviewCard',
    'SmartExpandablePanel',
    'SmartModelBadge',
    'AnimatedCounter',
    'ColorPicker',
    'TextMorph',
  ];

  componentCatalog.sort((a, b) => {
    const idxA = PRIORITY_ORDER.indexOf(a.name);
    const idxB = PRIORITY_ORDER.indexOf(b.name);
    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return a.name.localeCompare(b.name);
  });

  // 生成 llms.txt 内容
  const dateStr = new Date().toISOString().split('T')[0];
  const lines = [
    '# Conex UI Primitives — Machine-Readable Contract (llms.txt)',
    '# Generated automatically by scripts/generate-ui-contracts.mjs. DO NOT EDIT DIRECTLY.',
    `# Last Updated: ${dateStr}`,
    '',
    '## Quick Index',
  ];

  for (const comp of componentCatalog) {
    if (comp.props && comp.props.length > 0) {
      lines.push(`- ${comp.name}: import { ${comp.name}, type ${comp.propsName} } from '@/components/ui'`);
    } else {
      lines.push(`- ${comp.name}: import { ${comp.name} } from '@/components/ui'`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');

  for (const comp of componentCatalog) {
    lines.push(`## Component: ${comp.name}`);
    lines.push(`Path: ${comp.path}`);
    lines.push(`Description: ${comp.description}`);
    lines.push('');
    lines.push('### Props');

    if (comp.props && comp.props.length > 0) {
      lines.push('| Prop | Type | Default | Required | Description |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      for (const p of comp.props) {
        const reqStr = p.optional ? 'No' : 'Yes';
        lines.push(`| ${p.name} | \`${p.type}\` | ${p.defaultValue} | ${reqStr} | ${p.description} |`);
      }
    } else {
      lines.push('| Prop | Type | Default | Required | Description |');
      lines.push('| :--- | :--- | :--- | :--- | :--- |');
      lines.push(`| - | \`Record<string, unknown>\` | - | No | 继承标准 HTML 或无特定 Props 声明 |`);
    }

    lines.push('');
    lines.push('### Verified Code Example');
    lines.push('```tsx');

    const exampleCode = VERIFIED_EXAMPLES[comp.name] || `import { ${comp.name} } from '@/components/ui';

export function Example() {
  return <${comp.name} />;
}`;

    lines.push(exampleCode);
    lines.push('```');
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  const content = lines.join('\n');
  return { content, componentCatalog };
}

/**
 * 命令行执行入口
 */
function run() {
  const isCheck = process.argv.includes('--check');
  const { content, componentCatalog } = generateContracts();

  if (isCheck) {
    if (!fs.existsSync(OUTPUT_LLMS)) {
      console.error(`[check:ui-contracts] FAIL: 目标契约文件不存在 -> ${OUTPUT_LLMS}`);
      process.exit(1);
    }
    const existing = fs.readFileSync(OUTPUT_LLMS, 'utf8');
    const normalize = s => s.replace(/# Last Updated: [^\n]+/g, '');
    if (normalize(existing) !== normalize(content)) {
      console.error('[check:ui-contracts] FAIL: llms.txt 契约文件与当前 TypeScript 源码不一致！请运行 node scripts/generate-ui-contracts.mjs 更新。');
      process.exit(1);
    }
    console.log('[check:ui-contracts] OK: UI 契约文件与 TypeScript 源码完全一致。');
    process.exit(0);
  }

  fs.writeFileSync(OUTPUT_LLMS, content, 'utf8');
  console.log(`[generate-ui-contracts] 成功提取并生成 ${componentCatalog.length} 个原子组件契约 -> ${OUTPUT_LLMS}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run();
}
