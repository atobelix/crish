# CommonMark 官方测试套件（tests/cmspec）

本目录存放 CommonMark 官方规范的测试用例提取物，作为 markdown-editor 引擎
的 CommonMark 符合度门禁数据源。

## 来源与版本

| 项目 | 内容 |
| --- | --- |
| 规范版本 | CommonMark Spec 0.31.2 |
| 获取来源 | <https://spec.commonmark.org/0.31.2/spec.txt> |
| 获取日期 | 2026-08-09 |
| 文件说明 | `spec.txt` 为官方规范原文（含全部 652 个 example 用例），未做任何改动 |

## 双源核对（可复核性）

入库的 `spec.txt` 与 GitHub `commonmark/commonmark-spec` 仓库 0.31.2 tag 的
`spec.txt`（<https://raw.githubusercontent.com/commonmark/commonmark-spec/0.31.2/spec.txt>）
做了逐字节比对：GitHub 版开头含 pandoc YAML front matter（`title/author/version...`
共 6 行，以 `...` 显式结束），其正文与本站版仅差一个前导空行，其余**逐字节一致**。

| 源 | SHA-256 |
| --- | --- |
| spec.commonmark.org/0.31.2/spec.txt（入库） | `bfef4ddc97276b6ab6c2a28ace48478e35b1c50e60cde9f517ab8ab030aa3b82` |
| GitHub tag 0.31.2 spec.txt（含 front matter） | `257c41ad946f7a1414a499aca402a1aa8fdac3678532266611348c1cf54f4b80` |

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `spec.txt` | 官方规范原文（原始下载内容） |
| `spec.sha256` | `spec.txt` 的 SHA-256 校验值（十六进制小写，无换行） |
| `examples.json` | 提取产物：652 条用例数组，元素为 `{ n, markdown, html }` |
| `../extract-cm-spec.mjs` | 提取器脚本（`scripts/extract-cm-spec.mjs`） |

## 校验信息

`spec.txt` 的 SHA-256（与 `spec.sha256` 内容一致，十六进制小写、无换行）：

```
bfef4ddc97276b6ab6c2a28ace48478e35b1c50e60cde9f517ab8ab030aa3b82
```

校验命令：

```sh
# Linux / macOS
sha256sum tests/cmspec/spec.txt

# Windows PowerShell
Get-FileHash -Algorithm SHA256 tests/cmspec/spec.txt
```

## 提取方式

运行提取器（在仓库根目录执行）：

```sh
node scripts/extract-cm-spec.mjs
```

提取逻辑与官方 `commonmark/commonmark-spec` 仓库 `test/spec_tests.py:88-131`
保持一致（32 反引号 + `example` 进入用例块、`.` 分隔 markdown 与 html、
`→` 替换为制表符、编号自 1 连续递增）。提取器内置断言：用例数必须为 652，
否则中止并报错。

## 抽查样例

用例 #1（第一个用例，制表符转义展示为 `→`）：

```
→foo→baz→→bim
.

<pre><code>foo→baz→→bim
</code></pre>
```

提取后 `examples.json[0]`：

```json
{
  "n": 1,
  "markdown": "\tfoo\tbaz\t\tbim\n",
  "html": "<pre><code>foo\tbaz\t\tbim\n</code></pre>\n"
}
```

用例 #652（最后一个用例）：

```
Multiple     spaces
```

提取后 `examples.json[651]`：

```json
{
  "n": 652,
  "markdown": "Multiple     spaces\n",
  "html": "<p>Multiple     spaces</p>\n"
}
```
