/**
 * Markdown 轻量工具：仅思考占位剥离，无 highlight / 全量渲染依赖。
 * Chat 行静态路径应从此入口引用，避免拖入 codeHighlight 重模块。
 */

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
 * 仅去掉文档头部空白/BOM：须先于行锚定占位正则执行，
 * 否则 `\uFEFF## 本轮总结` 等首行占位因 `^#` 匹配失败而残留。
 */
function softTrimMarkdownHead(s: string): string {
  return s.replace(/^[\s\ufeff]+/, '');
}

/** 占位剥离管道（不含文档级 trim）：行锚定正则 + 空行折叠。 */
function applyThoughtPlaceholderStrips(source: string): string {
  const zh = RE_ROUND_SUMMARY_ZH;
  const en = RE_ROUND_SUMMARY_EN;
  return (
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

/**
 * 去掉模型常夹带的「正在思考…」占位与「本轮总结」类噪音标题。
 * 仅剥独立标题行（可含冒号/装饰括号/分隔点），不吞掉正文段落。
 *
 * N6 结果缓存（08-detail 3.3）：complete 后同一输入会在 onComplete /
 * 渲染路径重复 strip——同输入免重跑。
 * 有界 Map（条目 + 估算字节双上限），避免大文本（100KB 级）缓存膨胀。
 */
const STRIP_CACHE_MAX_ENTRIES = 64;
const STRIP_CACHE_MAX_BYTES = 1024 * 1024;
const stripCache = new Map<string, string>();
let stripCacheBytes = 0;

function stripCacheSet(source: string, result: string): void {
  if (
    stripCache.size >= STRIP_CACHE_MAX_ENTRIES ||
    stripCacheBytes >= STRIP_CACHE_MAX_BYTES
  ) {
    stripCache.clear();
    stripCacheBytes = 0;
  }
  stripCache.set(source, result);
  stripCacheBytes += source.length + result.length;
}

export function stripThoughtPlaceholders(text: string): string {
  if (text == null || text === '') return '';
  const source = typeof text === 'string' ? text : String(text);
  if (!source.trim()) return '';
  const cached = stripCache.get(source);
  if (cached !== undefined) return cached;
  // 头部（BOM/前导空白）先于占位正则剥离（doc-start 前缀不变式）
  const result = softTrimMarkdown(
    applyThoughtPlaceholderStrips(softTrimMarkdownHead(source))
  );
  stripCacheSet(source, result);
  return result;
}

/**
 * 判定一段文本是否仅为无实质内容的思考占位符（如「正在处理…」、「正在思考中...」等）。
 */
export function isThoughtPlaceholder(text: string | null | undefined): boolean {
  if (!text) return true;
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (/^正在(处理|思考中)[….\s]*$/.test(trimmed)) return true;
  return stripThoughtPlaceholders(trimmed).trim().length === 0;
}
