const fs = require('fs');

['part7', 'part8', 'part9'].forEach((name) => {
  const file = './scripts/analysis13_parts/' + name + '.js';
  let content = fs.readFileSync(file, 'utf8');
  // First character ` after export const ... = `
  const startIdx = content.indexOf('`');
  const endIdx = content.lastIndexOf('`');
  const header = content.substring(0, startIdx + 1);
  const footer = content.substring(endIdx);
  let body = content.substring(startIdx + 1, endIdx);
  // Replace unescaped backticks: not preceded by backslash
  body = body.replace(/(?<!\\)`/g, '\\`');
  // Also check if any ${...} exists that shouldn't be interpolated
  // none of our text needs JS interpolation
  body = body.replace(/\${/g, '\\${');
  fs.writeFileSync(file, header + body + footer, 'utf8');
  console.log('Fixed', name);
});
