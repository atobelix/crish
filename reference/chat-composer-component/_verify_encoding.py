# -*- coding: ascii -*-
"""Verify index.html matches the pre-corruption original.

Pure ASCII source: expected strings are built from codepoint tuples.
"""
import io
import sys

U = (lambda c: chr(c)) if sys.version_info[0] >= 3 else (lambda c: unichr(c))


def S(*cps):
    return u''.join(U(c) for c in cps)


with io.open('index.html', 'r', encoding='utf-8', newline='') as f:
    t = f.read()

# (label, expected string, expected count)
CHECKS = [
    ('em-dash in SPEC comment', U(0x2014) + u' above plan bar', 1),
    ('renwu mubiao...',         S(0x4EFB, 0x52A1, 0x76EE, 0x6807) + u'...', 1),
    ('yi wan cheng',            S(0x5DF2, 0x5B8C, 0x6210), 3),
    ('zhi xing zhong',          S(0x6267, 0x884C, 0x4E2D), 1),
    ('dai kai shi',             S(0x5F85, 0x5F00, 0x59CB), 1),
    ('yalce mingxi.csv',        S(0x538B, 0x6D4B, 0x660E, 0x7EC6) + u'.csv', 8),
    ('fenxi baogao.pdf',        S(0x5206, 0x6790, 0x62A5, 0x544A) + u'.pdf', 8),
    ('dun hao , dot',           S(0x987F, 0x53F7, 0x20, 0x3001, 0x20), 1),
    ('huanqi mulu shu...',      S(0x5524, 0x8D77, 0x76EE, 0x5F55, 0x6811) + u'...', 1),
    ('docx HE csv',             u'.docx</span></span> ' + U(0x548C) + u' <span', 1),
    ('can KAO',                 S(0x53C2, 0x8003), 1),
    ('pdf JI pptx',             u'.pdf</span></span> ' + U(0x53CA) + u' <span', 1),
    ('fen XI json',             S(0x5206, 0x6790) + u' <span', 1),
    ('json YU py',              u'.json</span></span> ' + U(0x4E0E) + u' <span', 1),
    ('shi YONG skill',          S(0x4F7F, 0x7528) + u' <span', 1),
    ('fangan fullstop',         S(0x65B9, 0x6848, 0x3002) + u'</div>', 1),
    ('fujian HUO Skill',        S(0x9644, 0x4EF6, 0x6216) + u' Skill', 1),
    ('Sonnet dot GAO',          u'Sonnet \xb7 ' + U(0x9AD8) + u'</span>', 1),
    ('slash and DUNHAO )',      u'(/ and ' + U(0x3001) + u') -->', 1),
    ('mingling YU Skill',       S(0x547D, 0x4EE4, 0x4E0E) + u' Skill', 1),
    ('quanju jian SUO',         S(0x5168, 0x5C40, 0x68C0, 0x7D22), 1),
    ('hint rangle',             u'text-hint">' + U(0x203A) + u'</span>', 1),
    ('huo chang SHANG...',      S(0x6216, 0x5382, 0x5546) + u'...', 1),
    ('sikao qiang DU',          S(0x601D, 0x8003, 0x5F3A, 0x5EA6), 1),
    ('stop GUAN',               u'data-val="0">' + U(0x5173) + u'</span>', 1),
    ('stop DI',                 u'data-val="1">' + U(0x4F4E) + u'</span>', 1),
    ('stop ZHONG',              u'data-val="2">' + U(0x4E2D) + u'</span>', 1),
    ('stop GAO',                u'data-val="3">' + U(0x9AD8) + u'</span>', 1),
    ('stop JI GAO',             u'data-val="4">' + S(0x6781, 0x9AD8) + u'</span>', 1),
    ('gongzuoqu quan XIAN',     S(0x5DE5, 0x4F5C, 0x533A, 0x6743, 0x9650), 1),
    ('fenxi dai MA',            S(0x5206, 0x6790, 0x4EE3, 0x7801), 1),
    ('sheng CHENG Implement',   S(0x751F, 0x6210) + u' Implementation', 1),
    ('kaishi bian MA quote',    S(0x5F00, 0x59CB, 0x7F16, 0x7801) + u'">', 1),
    ('zizhu chai JIE',          S(0x81EA, 0x4E3B, 0x62C6, 0x89E3), 1),
    ('zuizhong mu BIAO quote',  S(0x6700, 0x7EC8, 0x76EE, 0x6807) + u'">', 1),
    ('xianshi xun WEN',         S(0x663E, 0x5F0F, 0x8BE2, 0x95EE), 1),
    ('nin de shou QUAN quote',  S(0x60A8, 0x7684, 0x6388, 0x6743) + u'">', 1),
    ('quanquan zhi XING',       S(0x5168, 0x6743, 0x6267, 0x884C), 1),
    ('arrows in load order',
     u'utils ' + U(0x2192) + u' leaves ' + U(0x2192) + u' composites '
     + U(0x2192) + u' mount', 1),
    ('brand.css linked',        u'<link rel="stylesheet" href="css/brand.css">', 1),
]

bad = 0
for label, expected, want in CHECKS:
    got = t.count(expected)
    ok = (got == want)
    if not ok:
        bad += 1
    print('%-26s want=%-2d got=%-2d %s' % (label, want, got, 'OK' if ok else 'FAIL'))

print()
print('U+FFFD  =', t.count(U(0xFFFD)))
print('failures=', bad)
sys.exit(1 if bad or t.count(U(0xFFFD)) else 0)
