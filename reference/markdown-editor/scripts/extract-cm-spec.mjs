/**
 * extract-cm-spec.mjs —— 从 CommonMark 官方 spec.txt 提取 example 测试用例。
 *
 * 用途：将官方规范（https://spec.commonmark.org/0.31.2/spec.txt）中的
 * example 块解析为结构化 JSON 数组，作为 markdown-editor 引擎的
 * CommonMark 符合度门禁数据源（tests/cmspec/examples.json）。
 *
 * 解析逻辑与官方 spec_tests.py（commonmark/commonmark-spec 仓库
 * test/spec_tests.py:88-131）保持一致：
 *
 *   1. 以 strip 后等于 32 个反引号 + " example" 的行进入用例块；
 *   2. 块内第一个 strip 后为 "." 的行作为 markdown / html 分隔线；
 *   3. 以 strip 后等于 32 个反引号的行结束用例，编号自 1 连续递增；
 *   4. 行尾换行原样保留，最后将 markdown / html 中的 "→" 替换为制表符。
 *
 * 产物格式：tests/cmspec/examples.json —— 数组，元素为
 *   { n: 编号, markdown: 输入原文, html: 期望输出 }。
 *
 * 用法：node scripts/extract-cm-spec.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 当前脚本所在目录（scripts/）
const scriptDir = path.dirname(fileURLToPath(import.meta.url));

// 输入：tests/cmspec/spec.txt（官方规范原文）
const specPath = path.join(scriptDir, '..', 'tests', 'cmspec', 'spec.txt');
// 输出：tests/cmspec/examples.json（提取产物）
const outPath = path.join(scriptDir, '..', 'tests', 'cmspec', 'examples.json');

// 用例块边界的固定标记（官方 spec 使用 32 个反引号）
const FENCE = '`'.repeat(32);

/**
 * 按官方状态机解析 spec.txt，返回用例数组。
 * @param {string} content 以 UTF-8 读取的 spec.txt 全文
 * @returns {{ n: number, markdown: string, html: string }[]}
 */
function extractExamples(content) {
  // 状态：0 正文（用例块外）/ 1 markdown 部分 / 2 html 部分
  let state = 0;
  let n = 0;
  let markdownLines = [];
  let htmlLines = [];
  const examples = [];

  // 逐行扫描（split 后逐行补回换行符，与官方逐行读取语义一致）
  for (const raw of content.split('\n')) {
    const l = raw.trim();

    // 进入用例块：strip 后为 32 反引号 + " example"
    if (l === FENCE + ' example') {
      state = 1;
      markdownLines = [];
      htmlLines = [];
      continue;
    }

    // 结束用例块：仅 html 状态下的 32 反引号单独成行
    if (state === 2 && l === FENCE) {
      state = 0;
      n += 1;
      examples.push({
        n,
        markdown: markdownLines.join('').replaceAll('→', '\t'),
        html: htmlLines.join('').replaceAll('→', '\t'),
      });
      markdownLines = [];
      htmlLines = [];
      continue;
    }

    // 分隔线：strip 后恰为 "."（官方未限制状态，与官方行为保持一致）
    if (l === '.') {
      state = 2;
      continue;
    }

    // 收集 markdown / html 行（保留行尾换行符）
    if (state === 1) {
      markdownLines.push(raw + '\n');
    } else if (state === 2) {
      htmlLines.push(raw + '\n');
    }
  }

  return examples;
}

function main() {
  const content = fs.readFileSync(specPath, 'utf-8');
  const examples = extractExamples(content);

  if (examples.length !== 652) {
    console.error(`[extract-cm-spec] 预期 652 条用例，实际提取 ${examples.length} 条，中止。`);
    process.exit(1);
  }

  // 序列化：缩进 2 空格，末尾换行；JSON 内制表符/换行由 JSON 转义，文件本身为纯 ASCII
  fs.writeFileSync(outPath, JSON.stringify(examples, null, 2) + '\n', 'utf-8');

  // 首尾用例抽查，便于人工复核提取正确性
  const first = examples[0];
  const last = examples[examples.length - 1];
  console.log(`[extract-cm-spec] 提取完成：${examples.length} 条用例`);
  console.log(`  输出文件：${outPath}`);
  console.log(`  用例 #${first.n}：markdown=${JSON.stringify(first.markdown)}`);
  console.log(`  用例 #${last.n}：markdown=${JSON.stringify(last.markdown)}`);
}

main();
