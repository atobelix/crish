import subprocess
import datetime

# From 22:40 yesterday
since_time = "2026-08-11T22:40:00"
cmd_log = ['git', 'log', f'--since={since_time}', '--format=%H']

try:
    log_out = subprocess.check_output(cmd_log, text=True, encoding='utf-8').strip()
except subprocess.CalledProcessError:
    log_out = ""

stats = {'add': 0, 'del': 0}

def is_ignored(path):
    ignored = {'node_modules', 'target', 'dist', '.git', '.turbo', 'scratch', '.agent-outputs', 'test-results', '.firecrawl', 'coverage', '.codex', '.opencode', '.zcode'}
    parts = path.replace('\\', '/').split('/')
    for p in parts:
        if p in ignored:
            return True
    return False

def parse_numstat(output, stat_dict):
    for line in output.split('\n'):
        line = line.strip()
        if not line:
            continue
        parts = line.split('\t')
        if len(parts) >= 3:
            add, delete, path = parts[0], parts[1], parts[2]
            if is_ignored(path): continue
            if path.endswith('package-lock.json') or path.endswith('Cargo.lock') or path.endswith('eslint_report.json') or path.endswith('.db') or path.endswith('.db-shm') or path.endswith('.db-wal'):
                continue
            
            if add != '-':
                stat_dict['add'] += int(add)
            if delete != '-':
                stat_dict['del'] += int(delete)

if log_out:
    commits = log_out.split('\n')
    for commit_hash in commits:
        if not commit_hash: continue
        
        cmd_diff = ['git', 'show', '--numstat', '--format=', commit_hash]
        diff_out = subprocess.check_output(cmd_diff, text=True, encoding='utf-8', errors='ignore')
        parse_numstat(diff_out, stats)

# unstaged and uncommitted changes
try:
    diff_index = subprocess.check_output(['git', 'diff', '--cached', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_numstat(diff_index, stats)
    
    diff_working = subprocess.check_output(['git', 'diff', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_numstat(diff_working, stats)
except Exception:
    pass

import json
print(json.dumps(stats))
