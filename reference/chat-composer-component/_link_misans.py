# -*- coding: ascii -*-
"""Link the MiSans sheet directly from index.html.

@import inside brand.css was silently dropped (an @import must precede all
other rules), so Chinese was still falling back to system fonts. Linking the
sheet ahead of brand.css also saves a round trip.

Pure ASCII source; writes UTF-8 without BOM and preserves line endings.
"""
import io
import sys

PATH = 'index.html'
U = (lambda c: chr(c)) if sys.version_info[0] >= 3 else (lambda c: unichr(c))

ANCHOR = '<link rel="stylesheet" href="css/brand.css">'
ADDED = '<link rel="stylesheet" href="assets/fonts/misans/misans.css">\n  '

with io.open(PATH, 'r', encoding='utf-8', newline='') as f:
    text = f.read()

if ADDED.strip() in text:
    print('already present')
    sys.exit(0)

if text.count(ANCHOR) != 1:
    print('anchor not unique (%d)' % text.count(ANCHOR))
    sys.exit(1)

text = text.replace(ANCHOR, ADDED + ANCHOR)

fffd = text.count(U(0xFFFD))
print('U+FFFD =', fffd)
if fffd:
    print('UNRESOLVED -- refusing to write')
    sys.exit(1)

with io.open(PATH, 'w', encoding='utf-8', newline='') as f:
    f.write(text)
print('written OK, bytes =', len(text.encode('utf-8')))
