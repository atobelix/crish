/**
 * Markdown 轻量工具：仅 escape / 思考占位剥离，无 highlight / 全量渲染依赖。
 * Chat 行静态路径应从此入口引用，避免拖入 codeHighlight 重模块。
 */

/** HTML 属性/正文转义；null/非字符串安全降级 */
export function escapeHtml(s: string): string {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 本轮/本回合 + 可选修饰 + 总结|小结|回顾 */
const RE_ROUND_SUMMARY_ZH =
  '本(?:轮|回合)(?:工作|内容|完成)?(?:总结|小结|回顾)';
/** Round / Session / Turn summary */
const RE_ROUND_SUMMARY_EN = '(?:Round|Session|Turn)\\s+summary';

/**
 * 去掉首尾空行/BOM，但保留行尾有意义空格（如 `- ` 空列表项），
 * 避免 String.trim 把最后一项 `-\s` 吃成裸 `-` 导致匹配失败。
 */
function softTrimMarkdown(s: string): string {
  return s.replace(/^[\s\ufeff]+/, '').replace(/(?:\r?\n[ \t]*)+$/g, '');
}

/**
 * 去掉模型常夹带的「正在思考…」占位与「本轮总结」类噪音标题。
 * 仅剥独立标题行（可含冒号/装饰括号/分隔点），不吞掉正文段落。
 */
export function stripThoughtPlaceholders(text: string): string {
  if (text == null || text === '') return '';
  const source = typeof text === 'string' ? text : String(text);
  if (!source.trim()) return '';
  const zh = RE_ROUND_SUMMARY_ZH;
  const en = RE_ROUND_SUMMARY_EN;
  return softTrimMarkdown(
    source
      .replace(/^(正在思考中[….\s]{0,50}|正在处理[….\s]{0,50}){1,50}/gm, '')
      // heading：## 本轮总结 / ## 本轮工作总结 · / ## 本回合小结：
      .replace(new RegExp(`^#{1,6}\\s*${zh}\\s*[:：·.\\-—–]*\\s*$`, 'gm'), '')
      // 粗体：**本轮总结** / **本轮总结：**
      .replace(
        new RegExp(
          `^\\*{1,2}\\s*${zh}\\s*[:：]?\\s*\\*{1,2}\\s*[:：·.\\-—–]*\\s*$`,
          'gm'
        ),
        ''
      )
      // 【本轮总结】 / [本轮小结]
      .replace(
        new RegExp(`^[\\[【]\\s*${zh}\\s*[\\]】]\\s*[:：·.\\-—–]*\\s*$`, 'gm'),
        ''
      )
      // 裸行
      .replace(new RegExp(`^${zh}\\s*[:：·.\\-—–]*\\s*$`, 'gm'), '')
      // 英文 Round / Session / Turn summary 标题行
      .replace(new RegExp(`^#{1,6}\\s*${en}\\s*[:：·.\\-—–]*\\s*$`, 'gim'), '')
      .replace(
        new RegExp(
          `^\\*{1,2}\\s*${en}\\s*[:：]?\\s*\\*{1,2}\\s*[:：·.\\-—–]*\\s*$`,
          'gim'
        ),
        ''
      )
      .replace(new RegExp(`^${en}\\s*[:：·.\\-—–]*\\s*$`, 'gim'), '')
      .replace(/\n{3,}/g, '\n\n')
  );
}
