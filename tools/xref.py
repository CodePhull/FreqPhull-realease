import re, sys, os
FILES = ['server.js','main.js','updater.js','sentry-init.js','preload.js',
         'updater-preload.js','lib/impulse.js','renderer/app.js']
KEYWORDS = set('if for while switch catch return typeof do else try function new delete void in of'.split())
GLOBALS = set("""require module exports process console setTimeout setInterval clearTimeout
clearInterval Promise JSON Math Date Object Array String Number Boolean Error RegExp Map Set
WeakMap Symbol parseInt parseFloat isNaN isFinite encodeURIComponent decodeURIComponent Buffer
__dirname __filename URL TextDecoder TextEncoder AbortSignal fetch structuredClone queueMicrotask
window document navigator localStorage sessionStorage alert confirm prompt requestAnimationFrame
cancelAnimationFrame requestIdleCallback FormData Blob File FileReader Image Audio EventSource
AudioContext webkitAudioContext MutationObserver ResizeObserver IntersectionObserver Intl
CustomEvent Event KeyboardEvent MouseEvent DataView Float32Array Float64Array Int16Array Int32Array
Uint8Array Uint16Array Uint32Array ArrayBuffer performance crypto btoa atob escape unescape
getComputedStyle matchMedia globalThis Notification WebSocket XMLHttpRequest history location
screen top parent self frames""".split())

# Where each helper is defined
defined_in = {}
bodies = {}
for f in FILES:
    if not os.path.exists(f): continue
    src = open(f).read(); bodies[f] = src
    names = set(re.findall(r'function\s+(\w+)\s*\(', src))
    names |= set(re.findall(r'^\s*(?:const|let|var)\s+(\w+)', src, re.M))
    names |= set(re.findall(r'(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require', src))
    # Parameters are locals too: a callback named cb or next is not a
    # call into another module.
    for plist in re.findall(r'function\s*\w*\s*\(([^)]*)\)', src):
        names |= set(re.findall(r'\w+', plist))
    for plist in re.findall(r'\(([^)]*)\)\s*=>', src):
        names |= set(re.findall(r'\w+', plist))
    names |= set(re.findall(r'(\w+)\s*=>', src))
    names |= set(re.findall(r'\.(?:then|catch|forEach|map|filter|on|once)\(\s*(?:async\s*)?\(?\s*(\w+)', src))
    flat = set()
    for n in names:
        for part in re.split(r'[,:]', n):
            part = part.strip()
            if re.fullmatch(r'\w+', part): flat.add(part)
    defined_in[f] = flat

fails = []
for f, src in bodies.items():
    local = defined_in[f]
    # strip strings and comments so their contents are not read as code
    code = re.sub(r'//[^\n]*', '', src)
    code = re.sub(r'/\*.*?\*/', '', code, flags=re.S)
    code = re.sub(r"'(?:[^'\\]|\\.)*'", "''", code)
    code = re.sub(r'"(?:[^"\\]|\\.)*"', '""', code)
    code = re.sub(r'`(?:[^`\\]|\\.)*`', '``', code, flags=re.S)
    for m in re.finditer(r'(?<![\w.$])([a-z_]\w*)\s*\(', code):
        name = m.group(1)
        if name in local or name in GLOBALS or name in KEYWORDS: continue
        if re.search(r'\b' + name + r'\b\s*[:=]', code[:m.start()]): continue
        # `get() { ... }` is a method or getter definition, not a call.
        if re.match(r'[^)]*\)\s*\{', code[m.end():m.end() + 120]): continue
        elsewhere = [g for g in defined_in if g != f and name in defined_in[g]]
        if elsewhere:
            line = src[:m.start()].count('\n') + 1
            fails.append(f'{f}: calls {name}() which is defined only in {elsewhere[0]}')

seen = set(); uniq = []
for x in fails:
    k = x.split(': calls ')[0] + x.split(' which')[0].split('calls ')[-1]
    if k not in seen: seen.add(k); uniq.append(x)
if uniq:
    print('✗ PASS 19 FAILED - these throw at runtime:')
    for x in uniq[:12]: print('   -', x)
    sys.exit(1)
print('✓ PASS 19  no module calls a helper defined in another file')
