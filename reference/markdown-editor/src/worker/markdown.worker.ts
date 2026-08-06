import { MarkdownParser } from '../core/parser';

// Listen for messages from the main thread
self.onmessage = (e: MessageEvent) => {
    const { text, reqId } = e.data;
    if (typeof text === 'string') {
        const t0 = performance.now();
        const ast = MarkdownParser.parse(text);
        const t1 = performance.now();
        
        console.log(`[Worker] Parsed ${text.length} chars in ${(t1 - t0).toFixed(2)}ms, generated ${ast.lines.length} lines.`);
        
        // Post the result back
        self.postMessage({ reqId, ast });
    }
};
