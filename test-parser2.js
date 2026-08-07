console.log('Text 4:', JSON.stringify(scanTokens("H<sub>2</sub>O", 0, 0, null), null, 2));
console.log('Text 5:', JSON.stringify(scanTokens("质能等价公式 $E = mc^2$，复数解", 0, 0, null), null, 2));
console.log('Text 6:', JSON.stringify(scanTokens("mc^2$后面一连串都变成上标了呢。", 0, 0, null), null, 2));
