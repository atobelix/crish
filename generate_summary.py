import os

out_dir = r"c:\Software\conex\.agent-outputs\2026-08-12-cf555911-6abb-45a9-96a1-33a21bcadc4f"
summary_file = os.path.join(out_dir, "00-summary.md")

files = [f for f in os.listdir(out_dir) if f.endswith(".md") and f != "00-summary.md"]
files.sort()

content = "# 代码审计汇总索引\n\n| 文件名 | 标题 | 行数 | 摘要 |\n|:---|:---|:---:|:---|\n"

for f in files:
    path = os.path.join(out_dir, f)
    with open(path, "r", encoding="utf-8") as file:
        lines = file.readlines()
        
    title = f.replace(".md", "")
    for line in lines:
        if line.startswith("# "):
            title = line[2:].strip()
            break
            
    line_count = len(lines)
    
    # Try to find a summary paragraph
    summary = ""
    for line in lines:
        if line.strip() and not line.startswith("#") and not line.startswith("-") and not line.startswith("*"):
            summary = line.strip()[:100] + ("..." if len(line.strip()) > 100 else "")
            break
            
    if not summary:
        summary = "技术审查报告"
        
    formatted_path = path.replace('\\', '/')
    content += f"| [{f}](file:///{formatted_path}) | {title} | {line_count} | {summary} |\n"

with open(summary_file, "w", encoding="utf-8") as file:
    file.write(content)

print(f"Summary generated at {summary_file}")
