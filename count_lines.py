import os
import json

def is_test_file(path):
    parts = path.split(os.sep)
    if 'tests' in parts or 'test' in parts:
        return True
    if any(path.endswith(s) for s in ['.test.ts', '.spec.ts', '.test.tsx', '.spec.tsx', '.test.js', '.spec.js']):
        return True
    return False

def is_doc_file(path):
    parts = path.split(os.sep)
    if 'docs' in parts:
        return True
    if path.endswith('.md') or path.endswith('.txt'):
        return True
    return False

def get_main_subcat(path):
    parts = path.split(os.sep)
    if 'crates' in parts: return 'main_rust_crates'
    if 'apps' in parts: return 'main_apps'
    if 'packages' in parts: return 'main_packages'
    return 'main_other'

def is_ignored(path):
    ignored = {'node_modules', 'target', 'dist', '.git', '.turbo', 'scratch', '.agent-outputs', 'test-results', '.firecrawl', 'coverage', 'reference', '.codex', '.opencode', '.zcode'}
    parts = path.split(os.sep)
    for p in parts:
        if p in ignored:
            return True
    return False

exts = {'.js', '.jsx', '.ts', '.tsx', '.rs', '.css', '.html', '.md', '.txt', '.json', '.toml', '.yml', '.yaml'}

stats = {
    'docs': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
    'test': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
    'main_rust_crates': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
    'main_apps': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
    'main_packages': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
    'main_other': {'code': 0, 'comment': 0, 'blank': 0, 'files': 0},
}

def analyze_file(filepath):
    ext = os.path.splitext(filepath)[1].lower()
    if ext not in exts:
        return
    
    if is_doc_file(filepath):
        category = 'docs'
    elif is_test_file(filepath):
        category = 'test'
    else:
        category = get_main_subcat(filepath)
        
    code, comment, blank = 0, 0, 0
    in_block_comment = False
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            for line in f:
                line = line.strip()
                if not line:
                    blank += 1
                    continue
                
                if ext in {'.js', '.jsx', '.ts', '.tsx', '.rs', '.css'}:
                    if in_block_comment:
                        comment += 1
                        if '*/' in line:
                            in_block_comment = False
                    elif line.startswith('/*'):
                        comment += 1
                        if '*/' not in line:
                            in_block_comment = True
                    elif line.startswith('//'):
                        comment += 1
                    else:
                        code += 1
                elif ext in {'.html'}:
                    if in_block_comment:
                        comment += 1
                        if '-->' in line:
                            in_block_comment = False
                    elif line.startswith('<!--'):
                        comment += 1
                        if '-->' not in line:
                            in_block_comment = True
                    else:
                        code += 1
                elif ext in {'.toml', '.yml', '.yaml'}:
                    if line.startswith('#'):
                        comment += 1
                    else:
                        code += 1
                else:
                    code += 1
        stats[category]['code'] += code
        stats[category]['comment'] += comment
        stats[category]['blank'] += blank
        stats[category]['files'] += 1
    except Exception as e:
        pass

for root, dirs, files in os.walk('.'):
    # Prune ignored directories in-place
    dirs[:] = [d for d in dirs if not is_ignored(d)]
    
    if is_ignored(root):
        continue
    for f in files:
        filepath = os.path.join(root, f)
        if is_ignored(filepath):
            continue
        analyze_file(filepath)

print(json.dumps(stats, indent=2))
