import { performance } from 'perf_hooks';
import { MarkdownParser } from './src/core/parser';

function profile() {
    const text = '$'.repeat(500000);
    
    console.log("Profiling single long line (500k characters)...");
    
    const startParseLine = performance.now();
    const node = MarkdownParser.parseLine(text, 0, 'none');
    const endParseLine = performance.now();
    
    console.log(`parseLine took: ${(endParseLine - startParseLine).toFixed(2)} ms`);
}

profile();
