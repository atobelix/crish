---
name: chinese-encoding-guard
description: 在包含中文注释、中文字符串或历史编码问题的项目中工作时使用。首次进入项目、准备写入中文、需要排查乱码、或需要统一中文注释时，先用此技能确认编码状态、选择安全写入方式，并在修改后回读校验。
---

# 中文编码护栏

## 适用时机

- 首次进入包含中文源码的项目。
- 准备新增或修改中文注释、中文文档字符串、中文提示语。
- 仓库里出现“终端显示像乱码”和“文件内容真的坏了”难以区分的情况。
- 需要统一中文注释规范，避免中英混写。

## 首次检查流程

1. 先运行 `scripts/check_chinese_text.py <路径>`，检查文件是否能按 `utf-8` 或 `utf-8-sig` 正常解码。
2. 对可疑文件，优先读取原始字节再判断，不要只看 `Get-Content` 的输出。
3. 区分两类问题：
   - 文件内容损坏：脚本会给出 `repair_candidates` 或 `private_use_chars` 等告警。
   - 终端显示异常：文件解码正常，但终端输出不可靠。

## 安全写入方式

- 首选 `apply_patch` 修改源码中的中文内容。
- 不要用 shell 重定向、here-string、`echo >> 文件` 这类方式直接写中文源码。
- 如果必须通过 shell 生成中文文件，必须显式指定 `UTF-8` 编码，并优先使用无 BOM 的写法。
- PowerShell 兜底写法：

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
```

- 如果只是查看输出，可以临时设置：

```powershell
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
```

这只能改善显示，不能替代回读校验。

## 注释规范

- 注释和文档字符串统一使用中文。
- 不写中英混合句子。
- 注释里优先使用中文术语，不直接写裸英文短语。

## git 中文 commit 防乱码流程

1. 不要在 shell 命令行或 here-string 中直接写中文提交信息。
2. 使用 Python 写入 UTF-8 无 BOM 的 commit message 文件。
3. 提交时显式指定：`git -c i18n.commitEncoding=utf-8 commit -F <msg_file>`。
