const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
    const html = `
    <!DOCTYPE html>
    <html>
    <body>
      <div id="container" style="position: absolute; top: 0; left: 0; width: 100px;">
        <div id="child" style="margin-top: 50px; height: 20px; background: red;"></div>
      </div>
    </body>
    </html>
    `;
    fs.writeFileSync('C:\\Software\\conex\\test-margin.html', html);
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.goto('file://C:/Software/conex/test-margin.html');
    const box = await page.evaluate(() => document.getElementById('container').getBoundingClientRect());
    console.log(box);
    await browser.close();
})();
