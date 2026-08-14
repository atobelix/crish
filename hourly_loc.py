import subprocess
import datetime
from collections import defaultdict

now = datetime.datetime.now()
today_str = now.strftime("%Y-%m-%d")

# git log --since="YYYY-MM-DDT00:00:00"
cmd_log = ['git', 'log', f'--since={today_str}T00:00:00', '--format=%H|%cI']

try:
    log_out = subprocess.check_output(cmd_log, text=True, encoding='utf-8').strip()
except subprocess.CalledProcessError:
    log_out = ""

hourly_stats = defaultdict(lambda: {'add': 0, 'del': 0})

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
    for commit_line in commits:
        if not commit_line: continue
        commit_hash, date_str = commit_line.split('|')
        dt = datetime.datetime.fromisoformat(date_str)
        hour_key = f"{dt.hour:02d}:00-{dt.hour+1:02d}:00"
        
        cmd_diff = ['git', 'show', '--numstat', '--format=', commit_hash]
        diff_out = subprocess.check_output(cmd_diff, text=True, encoding='utf-8', errors='ignore')
        parse_numstat(diff_out, hourly_stats[hour_key])

# unstaged and uncommitted changes (index + working tree)
hour_key_now = f"{now.hour:02d}:00-{now.hour+1:02d}:00"

try:
    diff_index = subprocess.check_output(['git', 'diff', '--cached', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_numstat(diff_index, hourly_stats[hour_key_now])
    
    diff_working = subprocess.check_output(['git', 'diff', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_numstat(diff_working, hourly_stats[hour_key_now])
except Exception:
    pass

import json
print(json.dumps(dict(hourly_stats)))
