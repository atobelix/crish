const fs = require('fs');
const path = require('path');

function copyFolderSync(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.readdirSync(from).forEach(element => {
    const fromPath = path.join(from, element);
    const toPath = path.join(to, element);
    if (fs.lstatSync(fromPath).isDirectory()) {
      copyFolderSync(fromPath, toPath);
    } else {
      fs.copyFileSync(fromPath, toPath);
    }
  });
}

try {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    console.log('[Migration] LOCALAPPDATA environment variable not found, skip.');
    process.exit(0);
  }

  const targetDir = path.join(localAppData, 'io.github.conex-community.crish', 'EBWebView', 'Default', 'Local Storage');
  
  // 寻找旧的目录
  const sourceFlowbit = path.join(localAppData, 'me.flowbit.crish', 'EBWebView', 'Default', 'Local Storage');
  const sourceChatsync = path.join(localAppData, 'me.flowbit.chatsync', 'EBWebView', 'Default', 'Local Storage');

  let sourceDir = '';
  if (fs.existsSync(sourceFlowbit)) {
    sourceDir = sourceFlowbit;
  } else if (fs.existsSync(sourceChatsync)) {
    sourceDir = sourceChatsync;
  }

  if (sourceDir) {
    // 检查 targetDir 是不是已经有真正的 leveldb 记录了
    const targetLevelDb = path.join(targetDir, 'leveldb');
    let hasRealData = false;
    if (fs.existsSync(targetLevelDb)) {
      const files = fs.readdirSync(targetLevelDb);
      // 如果存在大于 20KB 的 .ldb / .sst 文件，代表新沙盒已经产生了不少用户新会话，我们不强行覆盖
      for (const f of files) {
        if ((f.endsWith('.ldb') || f.endsWith('.sst')) && fs.statSync(path.join(targetLevelDb, f)).size > 20000) {
          hasRealData = true;
          break;
        }
      }
    }

    if (hasRealData) {
      console.log('[Migration] Target already has real conversation data. Skipping auto-migration to prevent overwriting.');
      process.exit(0);
    }

    // 安全重命名备份现有的新空目录，避免冲突
    if (fs.existsSync(targetDir)) {
      const backupDir = targetDir + '_bak_' + Date.now();
      try {
        fs.renameSync(targetDir, backupDir);
        console.log('[Migration] Backed up current empty target storage to:', backupDir);
      } catch (renameErr) {
        console.warn('[Migration] Failed to backup target storage, skipping migration to avoid conflicts:', renameErr);
        process.exit(0);
      }
    }

    console.log('[Migration] Migrating Local Storage database from:', sourceDir);
    copyFolderSync(sourceDir, targetDir);
    console.log('[Migration] Local Storage database migration successfully completed!');
  } else {
    console.log('[Migration] No historical local storage folders found for me.flowbit.crish or me.flowbit.chatsync.');
  }
} catch (e) {
  console.error('[Migration] Critical failure during local storage migration:', e);
}
