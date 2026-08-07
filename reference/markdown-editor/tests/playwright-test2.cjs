const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:5173/');
  await page.waitForSelector('.editor-container');
  await page.evaluate(() => {
    window.__CRISH_SESSION_STORE__.getState().setText('#   多空格标题测试');
  });
  await page.waitForTimeout(500);
  
  const res = await page.evaluate(() => {
    const container = document.querySelector('.editor-container');
    const pos = 11; // end of line
    
    // Simulate what CursorLayer does:
    const tokenElements = container.querySelectorAll('[data-token-start]');
    let targetElement = null;
    let offsetInToken = 0;
    
    for (let i = 0; i < tokenElements.length; i++) {
        const el = tokenElements[i];
        const start = parseInt(el.getAttribute('data-token-start') || '0', 10);
        const length = parseInt(el.getAttribute('data-token-length') || '0', 10);
        if (pos >= start && pos < start + length) {
            targetElement = el; offsetInToken = pos - start; break;
        }
        if (pos === start + length) {
            targetElement = el; offsetInToken = length;
        }
    }
    
    if (!targetElement) return "no target element";
    
    // We replicate findNodeAndOffset:
    function findNodeAndOffset(node, targetOffset) {
        if (node.nodeType === Node.TEXT_NODE) {
            const len = node.nodeValue?.length || 0;
            if (targetOffset <= len) return { textNode: node, localOffset: targetOffset };
            return null;
        }
        let currentOffset = targetOffset;
        for (let i = 0; i < node.childNodes.length; i++) {
            const child = node.childNodes[i];
            if (child.nodeType === Node.ELEMENT_NODE) {
                const el = child;
                if (el.classList.contains('syntax-content') || el.hasAttribute('data-ignore-measure') || el.classList.contains('katex') || el.classList.contains('math-preview')) {
                    continue;
                }
            }
            if (child.nodeType === Node.TEXT_NODE) {
                const len = child.nodeValue?.length || 0;
                if (currentOffset <= len) return { textNode: child, localOffset: currentOffset };
                currentOffset -= len;
            } else {
                const result = findNodeAndOffset(child, currentOffset);
                if (result) return result;
                // getRawTextLength logic: (simplified)
                function getRawTextLength(n) {
                  if (n.nodeType === Node.TEXT_NODE) return n.nodeValue.length;
                  if (n.nodeType === Node.ELEMENT_NODE && n.classList.contains('syntax-content')) return 0;
                  let sum = 0;
                  for (let c of n.childNodes) sum += getRawTextLength(c);
                  return sum;
                }
                currentOffset -= getRawTextLength(child);
            }
        }
        return null;
    }
    
    const result = findNodeAndOffset(targetElement, offsetInToken);
    
    let rect = null;
    let fallback = false;
    if (result) {
        const range = document.createRange();
        range.setStart(result.textNode, result.localOffset);
        range.setEnd(result.textNode, result.localOffset);
        rect = range.getBoundingClientRect();
    } else {
        fallback = true;
        rect = targetElement.getBoundingClientRect();
    }
    
    const trueSpanRect = targetElement.getBoundingClientRect();
    
    return {
        targetHtml: targetElement.outerHTML,
        offsetInToken,
        resultFound: !!result,
        textNodeValue: result ? result.textNode.nodeValue : null,
        localOffset: result ? result.localOffset : null,
        rectLeft: rect.left,
        rectRight: rect.right,
        fallback,
        trueSpanRight: trueSpanRect.right
    };
  });
  
  console.log("Evaluation Result:", res);
  await browser.close();
})();
