import fs from 'fs';
import path from 'path';

const componentFiles = JSON.parse(fs.readFileSync('scripts/component-files-list.json', 'utf8'));

console.log(`Found ${componentFiles.length} files to scan.`);

// Group files by component area
const groups = {
  main_interface: [],
  card_panel: [],
  settings: [],
  modals: [],
  other: []
};

for (const file of componentFiles) {
  const norm = file.replace(/\\/g, '/');
  if (norm.includes('Settings') || norm.includes('settings') || norm.includes('Mcp') || norm.includes('Skill') || norm.includes('Model')) {
    groups.settings.push(norm);
  } else if (norm.includes('Card') || norm.includes('card') || norm.includes('Panel') || norm.includes('panel')) {
    groups.card_panel.push(norm);
  } else if (norm.includes('Modal') || norm.includes('Dialog') || norm.includes('Menu') || norm.includes('QuickOpen') || norm.includes('Wizard') || norm.includes('Toast') || norm.includes('Trap') || norm.includes('Ribbon')) {
    groups.modals.push(norm);
  } else if (norm.includes('Workspace') || norm.includes('Sidebar') || norm.includes('Chat') || norm.includes('Chrome')) {
    groups.main_interface.push(norm);
  } else {
    groups.other.push(norm);
  }
}

console.log('Group counts:', {
  main_interface: groups.main_interface.length,
  card_panel: groups.card_panel.length,
  settings: groups.settings.length,
  modals: groups.modals.length,
  other: groups.other.length
});
