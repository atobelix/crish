# -*- coding: ascii -*-
"""Last repair pass for index.html.

Another process finished filling the U+FFFD holes but picked the wrong glyph in
three places. Restore the original wording:

  L224  ".docx</span></span> X <span"  X: U+4E0E -> U+548C
  L224  ".pdf</span></span> X <span"   X: U+4E0E -> U+53CA
  L402  hint glyph                     '/'    -> U+203A

Pure ASCII source; every non-ASCII char is built with chr(<hex codepoint>).
Writes UTF-8 without BOM, preserves existing line endings.
"""
import io
import sys

PATH = 'index.html'
U = (lambda c: chr(c)) if sys.version_info[0] >= 3 else (lambda c: unichr(c))

REPS = [
    (u'.docx</span></span> ' + U(0x4E0E) + u' <span',
     u'.docx</span></span> ' + U(0x548C) + u' <span'),
    (u'.pdf</span></span> ' + U(0x4E0E) + u' <span',
     u'.pdf</span></span> ' + U(0x53CA) + u' <span'),
    (u'text-hint">/</span>',
     u'text-hint">' + U(0x203A) + u'</span>'),
]

with io.open(PATH, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

counts = [text.count(old) for old, _ in REPS]
print('occurrences =', counts)

if counts != [1, 1, 1]:
    print('expected exactly one of each -- refusing to write')
    sys.exit(1)

for old, new in REPS:
    text = text.replace(old, new)

fffd = text.count(U(0xFFFD))
print('U+FFFD left =', fffd)
if fffd:
    print('UNRESOLVED -- refusing to write')
    sys.exit(1)

with io.open(PATH, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('written OK, bytes =', len(text.encode('utf-8')))
