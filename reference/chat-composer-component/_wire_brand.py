# -*- coding: ascii -*-
"""Wire the new brand files into index.html.

index.html must never be touched by a tool that can re-encode it, so this
script does the edit: read UTF-8, insert pure-ASCII tags, write UTF-8 (no BOM),
preserve existing line endings.
"""
import io
import sys

PATH = 'index.html'
U = (lambda c: chr(c)) if sys.version_info[0] >= 3 else (lambda c: unichr(c))

# (anchor, text inserted right after it) -- all pure ASCII
INSERTS = [
    ('<link rel="stylesheet" href="css/flow/motion.css">',
     '\n  <link rel="stylesheet" href="css/flow/live.css">'),
    ('<script src="js/stream-renderer.js"></script>',
     '\n  <script src="js/components/SessionStart.js"></script>'),
]

with io.open(PATH, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

for anchor, added in INSERTS:
    if added.strip() in text:
        print('already present, skipping:', added.strip())
        continue
    if text.count(anchor) != 1:
        print('anchor not unique (%d):' % text.count(anchor), anchor)
        sys.exit(1)
    text = text.replace(anchor, anchor + added)
    print('inserted after:', anchor)

fffd = text.count(U(0xFFFD))
print('U+FFFD =', fffd)
if fffd:
    print('UNRESOLVED -- refusing to write')
    sys.exit(1)

with io.open(PATH, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('written OK, bytes =', len(text.encode('utf-8')))
