import { Lexer } from 'marked';

/**
 * Opening HTML tag pattern.
 * Allows letters, numbers, hyphens, and colons so custom tags like <ai-thinking>
 * are tracked across blank-line interruptions.
 */
const openingTagPattern = /<([A-Za-z][\w:-]*)[\s>/]/;

/**
 * HTML void elements (self-closing tags) per HTML5 specification.
 */
const voidElements = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function getOpenTagPattern(tagName: string): RegExp {
  const normalizedTag = tagName.toLowerCase();
  return new RegExp(`<${normalizedTag}(?=[\\s>/])[^>]*>`, 'gi');
}

function getCloseTagPattern(tagName: string): RegExp {
  const normalizedTag = tagName.toLowerCase();
  return new RegExp(`</${normalizedTag}(?=[\\s>])[^>]*>`, 'gi');
}

/**
 * Counts non-self-closing open tags of a given tag name in a block.
 * Self-closing tags (e.g. `<div />`) and void elements (`<img>`, `<br>`, etc.) return 0.
 */
export function countNonSelfClosingOpenTags(
  block: string,
  tagName: string
): number {
  if (voidElements.has(tagName.toLowerCase())) {
    return 0;
  }
  const matches = block.match(getOpenTagPattern(tagName));
  if (!matches) {
    return 0;
  }
  let count = 0;
  for (const match of matches) {
    if (!match.trimEnd().endsWith('/>')) {
      count += 1;
    }
  }
  return count;
}

/**
 * Counts closing tags of a given tag name in a block.
 */
export function countClosingTags(block: string, tagName: string): number {
  const matches = block.match(getCloseTagPattern(tagName));
  return matches ? matches.length : 0;
}

/**
 * Counts non-overlapping occurrences of double dollar signs `$$` in a string.
 */
export function countDoubleDollars(str: string): number {
  let count = 0;
  for (let i = 0; i < str.length - 1; i += 1) {
    if (str[i] === '$' && str[i + 1] === '$') {
      count += 1;
      i += 1; // Skip next character
    }
  }
  return count;
}

/**
 * Splits cumulative Markdown text into syntax-independent Block strings.
 *
 * Handles:
 * 1. HTML block state machine: keeps multiline/nested HTML tags in a single block.
 * 2. LaTeX math block ($$) merging: keeps multiline math blocks together and handles Setext heading confusion.
 * 3. Code block boundary tracking: avoids misinterpreting $$ inside code blocks as math.
 */
export function parseMarkdownIntoBlocks(markdown: string): string[] {
  if (!markdown) {
    return [];
  }

  const tokens = Lexer.lex(markdown, { gfm: true });

  const mergedBlocks: string[] = [];
  const htmlStack: string[] = [];
  let previousTokenWasCode = false;

  for (const token of tokens) {
    const currentBlock = token.raw;
    const mergedBlocksLen = mergedBlocks.length;

    // Check if we're inside an HTML block
    if (htmlStack.length > 0) {
      // We're inside an HTML block, merge with the previous block
      const lastIndex = mergedBlocksLen - 1;
      const prev = mergedBlocks[lastIndex];
      if (prev !== undefined) {
        mergedBlocks[lastIndex] = prev + currentBlock;
      } else {
        mergedBlocks.push(currentBlock);
      }

      // Track nested opening and closing tags of the same type
      const trackedTag = htmlStack[htmlStack.length - 1];
      if (trackedTag) {
        const newOpenTags = countNonSelfClosingOpenTags(currentBlock, trackedTag);
        const newCloseTags = countClosingTags(currentBlock, trackedTag);

        for (let i = 0; i < newOpenTags; i += 1) {
          htmlStack.push(trackedTag);
        }
        for (let i = 0; i < newCloseTags; i += 1) {
          if (
            htmlStack.length > 0 &&
            htmlStack[htmlStack.length - 1] === trackedTag
          ) {
            htmlStack.pop();
          }
        }
      }
      continue;
    }

    // Check if this is an opening HTML block tag
    if (token.type === 'html' && token.block) {
      const openingTagMatch = currentBlock.match(openingTagPattern);
      if (openingTagMatch && openingTagMatch[1]) {
        const tagName = openingTagMatch[1];
        // Count how many tags remain unclosed within this block
        const openTags = countNonSelfClosingOpenTags(currentBlock, tagName);
        const closeTags = countClosingTags(currentBlock, tagName);
        if (openTags > closeTags) {
          htmlStack.push(tagName);
        }
      }
    }

    // Math block merging logic ($$)
    // If previous block has unclosed math (odd number of $$), merge current block into it.
    // Skip if previous block was a code block (code blocks can contain $$ as shell syntax).
    if (mergedBlocksLen > 0 && !previousTokenWasCode) {
      const previousBlock = mergedBlocks[mergedBlocksLen - 1];
      if (previousBlock !== undefined) {
        const prevDollarCount = countDoubleDollars(previousBlock);

        if (prevDollarCount % 2 === 1) {
          mergedBlocks[mergedBlocksLen - 1] = previousBlock + currentBlock;
          continue;
        }
      }
    }

    mergedBlocks.push(currentBlock);

    // Track if this token was a code block (for next iteration), ignoring space tokens
    if (token.type !== 'space') {
      previousTokenWasCode = token.type === 'code';
    }
  }

  return mergedBlocks;
}
