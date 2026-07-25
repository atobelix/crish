import fs from 'fs';
import path from 'path';

// Load list of all component files
const componentFiles = JSON.parse(fs.readFileSync('scripts/component-files-list.json', 'utf8'));

// Helper to inspect files and find classNames and event handlers
function inspectFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const relPath = filePath.replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  const componentName = fileName.replace(/\.tsx$/, '').replace(/\.jsx$/, '');

  const elements = [];

  // Regex to match JSX elements with event listeners or classNames or attributes
  // Match tags like <button, <div, <input, <select, <a, <span, etc.
  const tagRegex = /<([a-zA-Z0-9.]+)\s+([^>]*?)>/g;
  let match;

  while ((match = tagRegex.exec(content)) !== null) {
    const tagName = match[1];
    const attrsStr = match[2];

    // Check if this tag has event handlers
    const events = [];
    const eventMatches = attrsStr.matchAll(/on(Click|MouseDown|PointerDown|KeyDown|ContextMenu|MouseOver|MouseEnter|MouseLeave|DoubleClick|Change|Submit|Focus|Blur)\s*=\s*/g);
    for (const em of eventMatches) {
      events.push('on' + em[1]);
    }

    // Extract className
    let classNames = [];
    const classMatch = attrsStr.match(/className\s*=\s*(?:{([^}]+)}|"([^"]+)"|'([^']+)')/);
    if (classMatch) {
      const clsVal = classMatch[2] || classMatch[3] || classMatch[1];
      if (clsVal) {
        // extract static string parts or css modules
        const clsParts = clsVal.match(/[\w-]+/g) || [];
        classNames = clsParts.filter(c => c !== 'styles' && c !== 'clsx' && c !== 'cn' && c !== 'true' && c !== 'false');
      }
    }

    // Extract aria-label, title, role, data-attributes, type, placeholder
    const ariaLabel = attrsStr.match(/aria-label\s*=\s*(?:"([^"]+)"|'([^']+)'|{([^}]+)})/);
    const title = attrsStr.match(/title\s*=\s*(?:"([^"]+)"|'([^']+)'|{([^}]+)})/);
    const role = attrsStr.match(/role\s*=\s*(?:"([^"]+)"|'([^']+)'|{([^}]+)})/);
    const dataTab = attrsStr.match(/data-[\w-]+\s*=\s*(?:"([^"]+)"|'([^']+)'|{([^}]+)})/);
    const placeholder = attrsStr.match(/placeholder\s*=\s*(?:"([^"]+)"|'([^']+)'|{([^}]+)})/);

    if (events.length > 0 || classNames.length > 0 || ariaLabel || title || role || dataTab) {
      elements.push({
        tagName,
        events: Array.from(new Set(events)),
        classNames,
        ariaLabel: ariaLabel ? (ariaLabel[1] || ariaLabel[2] || ariaLabel[3]) : null,
        title: title ? (title[1] || title[2] || title[3]) : null,
        role: role ? (role[1] || role[2] || role[3]) : null,
        placeholder: placeholder ? (placeholder[1] || placeholder[2] || placeholder[3]) : null,
        attrsRaw: attrsStr.slice(0, 150)
      });
    }
  }

  return {
    filePath: relPath,
    componentName,
    elements
  };
}

const fileInspections = componentFiles.map(inspectFile);
fs.writeFileSync('scripts/inspections-output.json', JSON.stringify(fileInspections, null, 2));
console.log(`Inspected ${fileInspections.length} components.`);
