import subprocess
import datetime
from collections import defaultdict
import json

cmd_log = ['git', 'log', '--numstat', '--format=COMMIT|%cI']

try:
    log_out = subprocess.check_output(cmd_log, text=True, encoding='utf-8', errors='ignore')
except subprocess.CalledProcessError:
    log_out = ""

daily_stats = defaultdict(lambda: {'add': 0, 'del': 0})

def is_ignored(path):
    ignored = {'node_modules', 'target', 'dist', '.git', '.turbo', 'scratch', '.agent-outputs', 'test-results', '.firecrawl', 'coverage', '.codex', '.opencode', '.zcode'}
    parts = path.replace('\\', '/').split('/')
    for p in parts:
        if p in ignored:
            return True
    return False

current_day = None

for line in log_out.split('\n'):
    line = line.strip()
    if not line:
        continue
    
    if line.startswith('COMMIT|'):
        # Parse date
        date_str = line.split('|')[1]
        try:
            dt = datetime.datetime.fromisoformat(date_str)
            current_day = f"{dt.year:04d}-{dt.month:02d}-{dt.day:02d}"
        except Exception:
            current_day = None
        continue
    
    if current_day is None:
        continue
    
    parts = line.split('\t')
    if len(parts) >= 3:
        add, delete, path = parts[0], parts[1], parts[2]
        if is_ignored(path): continue
        if path.endswith('package-lock.json') or path.endswith('Cargo.lock') or path.endswith('eslint_report.json') or path.endswith('.db') or path.endswith('.db-shm') or path.endswith('.db-wal'):
            continue
        
        if add != '-':
            daily_stats[current_day]['add'] += int(add)
        if delete != '-':
            daily_stats[current_day]['del'] += int(delete)

# Unstaged and uncommitted changes (index + working tree)
now = datetime.datetime.now()
today_key = f"{now.year:04d}-{now.month:02d}-{now.day:02d}"

def parse_diff_numstat(output, stat_dict):
    for line in output.split('\n'):
        line = line.strip()
        if not line: continue
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

try:
    diff_index = subprocess.check_output(['git', 'diff', '--cached', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_diff_numstat(diff_index, daily_stats[today_key])
    
    diff_working = subprocess.check_output(['git', 'diff', '--numstat'], text=True, encoding='utf-8', errors='ignore')
    parse_diff_numstat(diff_working, daily_stats[today_key])
except Exception:
    pass

print(json.dumps(dict(daily_stats)))
