/**
 * 模型 explanation 意图说明可读性与废话过滤。
 */

/** 是否像「人能读」的说明（非命令、非 JSON）——优先作摘要行 */
export function isHumanExplanation(text: string, toolName: string): boolean {
  const t = text.trim();
  if (
    !t ||
    t === toolName ||
    t === '需要确认' ||
    t.startsWith('{') ||
    t.startsWith('[')
  )
    return false;
  if (
    /^(powershell|pwsh|cmd(?:\.exe)?|bash|sh|zsh)\b/i.test(t) ||
    /^I will run\b/i.test(t)
  )
    return false;
  if (toolName && t.toLowerCase().startsWith(toolName.toLowerCase()))
    return false;
  if (/^[\w./\\:-]+\s+[\w./\\:-]+/.test(t) && !/[\u4e00-\u9fff]/.test(t))
    return false;
  if (/[\u4e00-\u9fff]/.test(t)) return t.length >= 2 && t.length <= 240;
  if (
    /^[A-Za-z]/.test(t) &&
    t.length >= 6 &&
    t.length <= 160 &&
    !/[\\/]{2,}/.test(t)
  ) {
    return !/^(ls|cd|cat|mkdir|rm|cp|mv|git|npm|pnpm|yarn)\b/i.test(t);
  }
  return false;
}

/** 模型 explanation 若只是动作模板（运行命令/查看文件…），丢弃，再回退 args */
export function isGenericExplanationSpam(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (
    /^(正在)?(查看|浏览|修改|搜索|访问|读取|写入|列出|创建|运行)(文件|目录|代码|网络|内容|命令|工具)?$/.test(
      t
    )
  )
    return true;
  if (/^正在?(查看|浏览|修改|搜索|访问|读取|写入|运行)\s+\S{1,80}$/.test(t))
    return true;
  if (
    /^(创建目录|列出目录|列出目录内容|运行命令|运行终端命令|查看文件内容|查看文件|修改文件|写入文件|切换工作目录)(\s+\S+)?$/.test(
      t
    )
  )
    return true;
  if (
    /^正在?(创建目录|列出目录|查看文件|修改文件|写入文件|运行命令|访问网络)\b/.test(
      t
    ) &&
    t.length < 24
  )
    return true;
  return /^使用工具处理\s+\S+$/.test(t) || /^调用\s+[\w\s.-]+$/.test(t);
}
