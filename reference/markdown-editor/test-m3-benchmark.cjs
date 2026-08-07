const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
    console.log("Starting M3 Extreme Stability & Benchmark Test...");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    
    // Catch Vite logs
    page.on('console', msg => {
        if (msg.type() === 'error') {
            console.error('PAGE ERROR:', msg.text());
        }
    });
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));

    await page.goto('http://localhost:5173');
    
    console.log("Waiting for app to load...");
    await page.waitForSelector('.editor-container', { timeout: 30000 });
    
    // Test 1: Typing insertion loop
    console.log("-----------------------------------------");
    console.log("Test 1: High Frequency Typing Stress Test");
    let latencies = [];
    let start, end;
    for (let i = 0; i < 50; i++) {
        start = performance.now();
        await page.keyboard.type('a');
        end = performance.now();
        latencies.push(end - start);
    }
    
    // Average Latency
    const avgLatency = latencies.reduce((a,b) => a+b, 0) / latencies.length;
    console.log(`Average end-to-end keystroke latency: ${avgLatency.toFixed(2)} ms`);
    if (avgLatency > 50) {
        console.error("FAIL: Keystroke latency exceeds 50ms!");
        process.exit(1);
    }

    // Verify AST Cache usage
    const metrics = await page.evaluate(() => window.__CRISH_METRICS__.getCacheStats());
    console.log("AST Cache Stats:", metrics);
    if (metrics.hits === 0) {
        console.error("FAIL: AST Cache is not being hit! Caching failed!");
        process.exit(1);
    }

    // Test 2: Verify zero drift
    console.log("-----------------------------------------");
    console.log("Test 2: Zero Drift Verification");
    const isConsistent = await page.evaluate(() => window.__CRISH_METRICS__.verifyConsistency());
    if (!isConsistent) {
        console.error("FAIL: Drift detected in lineOffsets!");
        process.exit(1);
    }
    console.log("PASS: No drift detected in offsets.");

    // Test 3: Large deletion
    console.log("-----------------------------------------");
    console.log("Test 3: Deletion Offset Repair");
    await page.evaluate(() => {
        const store = window.__CRISH_SESSION_STORE__.getState();
        store.setSelection(100, 2000);
    });
    start = performance.now();
    await page.keyboard.press('Backspace');
    end = performance.now();
    console.log(`Large deletion end-to-end latency: ${(end - start).toFixed(2)} ms`);
    
    const isConsistentAfterDel = await page.evaluate(() => window.__CRISH_METRICS__.verifyConsistency());
    if (!isConsistentAfterDel) {
        console.error("FAIL: Drift detected after large deletion!");
        process.exit(1);
    }
    console.log("PASS: Offsets repaired perfectly after large deletion.");

    console.log("ALL TESTS PASSED SUCCESSFULLY.");
    await browser.close();
    process.exit(0);
})();
