// Scratch script to test regex logic
const text = "**未闭合的加粗、*未闭合的斜体、~~未闭合的删除线。";
let i = 0;
while (i < text.length) {
    const char = text[i];
    let runLen = 0;
    while (i + runLen < text.length && text[i + runLen] === char) runLen++;
    console.log(`Char: ${char}, RunLen: ${runLen}`);
    i += runLen;
}
