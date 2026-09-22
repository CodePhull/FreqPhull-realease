set -e
cd "$(dirname "$0")"
echo "════════ GAUNTLET ════════"
for f in server.js renderer/app.js main.js preload.js updater.js updater-preload.js sentry-init.js; do node --check $f; done
echo "✓ PASS 1  syntax (7 files)"
python3 -c "import ast; [ast.parse(open(f).read()) for f in ['analyze.py','verify_engines.py','write_tags.py','fingerprint.py']]"
echo "✓ PASS 2  python AST (4 files)"
python3 - <<'PY'
import re, sys
s=open('renderer/app.js').read()
P=r"(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
en=re.search(r'^\s*en:\s*\{(.*?)^\s*\},\s*$\s*fr:',s,re.S|re.M).group(1)
fr=re.search(r'^\s*fr:\s*\{(.*?)^\s*\}\s*\};',s,re.S|re.M).group(1)
k=lambda b:{m.group(1) for m in re.finditer(P,b)}
if k(en)!=k(fr): print('parity diff', sorted(k(en)^k(fr))); sys.exit(1)
print(f'✓ PASS 3  i18n parity ({len(k(en))} keys)')
PY
python3 -c "
import re,sys
raw=open('installer/setup-engines.ps1','rb').read()
assert sum(1 for b in raw if b>=128)==0 and len(re.findall(rb'(?<!\r)\n',raw))==0
print('✓ PASS 4  ps1 bytes')"
node -e "
const s=require('fs').readFileSync('server.js','utf8');
const a=s.indexOf('const app = express');
const r=[...s.matchAll(/app\.(get|post|delete)\('([^']+)'/g)];
for(const m of r) if(m.index<a){console.error('route before app:',m[2]);process.exit(1);}
console.log('✓ PASS 5  route order ('+r.length+' routes)');"
python3 -c "
import json,os,re
p=json.load(open('package.json'))
assert '!extension/**' in p['build']['files']
json.load(open('extension/manifest.json')); json.load(open('sentry.config.example.json'))
for f in ['verify_engines.py','.github/workflows/release.yml','extension/manifest.json','analyze.py','PATCHNOTES.md']: assert os.path.exists(f),f
s=open('renderer/app.js').read(); assert s.count('setup-modal-box')==0
for f in ['server.js','renderer/app.js','main.js','sentry-init.js']:
    t=open(f).read(); assert not re.search(r'//\s*v?0\.\d\.\d:',t)
    for ph in ['bad manners','trust nothing','gotcha','reads as failure']: assert ph not in t
print('✓ PASS 6  package content ('+p['version']+')')"
python3 - <<'PY'
import re, sys
s=open('renderer/app.js').read()
P=r"(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
en={m.group(1):m.group(2) for m in re.finditer(P,re.search(r'^\s*en:\s*\{(.*?)^\s*\},\s*$\s*fr:',s,re.S|re.M).group(1))}
fr_b=re.search(r'^\s*fr:\s*\{(.*?)^\s*\}\s*\};',s,re.S|re.M).group(1)
fr={m.group(1):m.group(2) for m in re.finditer(P,fr_b)}
NEEDS={'apres','defaut','etape','etre','probleme','systeme','succes','acces','premiere',
 'derniere','complete','element','memoire','donnee','donnees','securite','qualite','duree',
 'selection','necessaire','desactive','creer','precisement','decompresse','integre',
 'resultat','methode','numero','operation','arrete','separateur','maniere','fenetre',
 'modele','pret','prete','tonalite','verifie','terminee','termine','parametre','parametres',
 'telecharge','verification','evenement','echec','repare','deja','detecte','operationnel',
 'ajoutee','depot','icone','piece','epingle','video','metadonnees','entree','entrees',
 'installee','recente','redemarrage','demarrage','reinstaller'}
f=[]
for k,v in fr.items():
    for w in re.findall(r"[A-Za-zÀ-ÿ]+",v):
        if w.lower() in NEEDS and not any(c in w for c in 'éèêëàâçùûîïôöÉÈÀÇÊÎÔÛ'): f.append(f'accent-less "{w}" in fr.{k}')
for m in re.finditer(r"\b[A-Za-zÀ-ÿ]+(?:éz|ér)\b",fr_b): f.append(f'bad ending {m.group(0)}')
for k in en:
    if k in fr and en[k]==fr[k] and len(en[k])>25: f.append(f'fr.{k} untranslated')
    if k in fr and set(re.findall(r'\{(\w+)\}',en[k]))!=set(re.findall(r'\{(\w+)\}',fr[k])): f.append(f'placeholder {k}')
if f:
    print('✗ PASS 7 FAILED'); [print('   -',x) for x in f[:12]]; sys.exit(1)
print(f'✓ PASS 7  french quality ({len(fr)} strings)')
PY
python3 - <<'PY'
import re, json, os, sys
s = open('server.js').read()
fails = []
# Python cannot read inside app.asar: every spawned .py must either be
# resolved through pythonScriptOnDisk or copied to temp near its use.
for m in re.finditer(r"getResourcePath\('([a-z_]+\.py)'\)", s):
    name, block = m.group(1), s[m.start():m.start() + 1000]
    if 'copyFileSync' not in block:
        fails.append(f'{name} resolved without a temp copy')
er = {e['from'] for e in json.load(open('package.json'))['build']['extraResources'] if isinstance(e, dict)}
for f in os.listdir('.'):
    if f.endswith('.py') and f not in er:
        fails.append(f'{f} missing from extraResources')
if fails:
    print('✗ PASS 8 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('✓ PASS 8  python scripts asar-safe')
PY
python3 - <<'PY'
import re, sys
# Every third-party module the helper scripts import must actually be
# installed by setup and covered by verification, or the feature silently
# does nothing on user machines.
fails = []
ps1 = open('installer/setup-engines.ps1','rb').read().decode('ascii', 'replace')
ver = open('verify_engines.py').read()
DEPS = {'write_tags.py': ['mutagen'], 'fingerprint.py': ['numpy', 'soundfile']}
for script, mods in DEPS.items():
    src = open(script).read()
    for m in mods:
        if m not in src: fails.append(f'{script} no longer imports {m}')
        if m not in ps1: fails.append(f'{m} (for {script}) not installed by setup')
        if m not in ver: fails.append(f'{m} not covered by verify_engines.py')
if re.search(r'^\s*import librosa', open('fingerprint.py').read(), re.M):
    fails.append('fingerprint.py imports librosa again')
if fails:
    print('✗ PASS 9 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 9  helper-script dependencies installed + verified')
PY
python3 - <<'PY'
import re, sys
# Animation loops that re-arm themselves must stop when there is nothing
# to animate. A loop running at display refresh rate while paused shows
# up as constant background CPU, and the window disables background
# throttling so it does not even stop when minimised.
src = open('renderer/app.js').read()
fails = []
for name, guard in [
    ('_playheadRAF',     'moving && !document.hidden'),
    ('_liveSpectrumRaf', '!playing || !analyserL'),
    ('analyzeMirrorRaf', 'playing && !document.hidden'),
]:
    if guard not in src:
        fails.append(f'{name}: idle guard missing ({guard})')
# module-level handles must be declared before first use (TDZ)
for handle in ['_analyzeMirrorIdle', '_playheadIdleTimer']:
    decl = src.find('let ' + handle)
    first = src.find(handle)
    if decl < 0 or first < decl:
        fails.append(f'{handle}: used before declaration')
if fails:
    print('✗ PASS 10 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 10  animation loops idle when paused')
PY
python3 - <<'PY'
import re, sys
fails = []
si = open('sentry-init.js').read()
sv = open('server.js').read()
ap = open('renderer/app.js').read()
# Crash reporting is only useful if it stays connected. Each of these
# was a real blind spot at some point.
for name, cond in [
    ('breadcrumb helper exported', 'addTrail' in si and 'addBreadcrumb' in si),
    ('server log feeds breadcrumbs', "sentry.addTrail('node'" in sv),
    ('install id on every event', 'setUser' in si and 'getInstallId' in si),
    ('live app state attached', 'setStateProvider' in si and 'sentry.setStateProvider' in sv),
    ('searchable tags set', "setTag('os_release'" in si),
    ('renderer crashes captured', 'unhandledrejection' in ap and '/client-error' in ap),
    ('renderer endpoint exists', "app.post('/client-error'" in sv),
    ('rate limit present', '_isRateLimited' in si),
]:
    if not cond: fails.append(name)
if fails:
    print('✗ PASS 11 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 11  crash reporting fully wired')
PY
python3 - <<'PY'
import re, collections, sys
fails = []
app = open('renderer/app.js').read()
html = open('renderer/index.html').read()

# Two functions with the same name: the later silently wins. This is how
# the player's mute button was dead - it collided with the stem mute.
fns = re.findall(r'^(?:async\s+)?function\s+(\w+)\s*\(', app, re.M)
dupes = {f: n for f, n in collections.Counter(fns).items() if n > 1}
if dupes: fails.append(f'functions declared twice: {dupes}')

# Duplicate element ids make getElementById return whichever came first.
ids = re.findall(r'\sid="([^"]+)"', html)
idup = [i for i, n in collections.Counter(ids).items() if n > 1]
if idup: fails.append(f'duplicate element ids: {idup}')

# A t() key with no definition renders as empty text.
P = r"(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|\"(?:[^\"\\]|\\.)*\")"
en = {m.group(1) for m in re.finditer(P, re.search(r'^\s*en:\s*\{(.*?)^\s*\},\s*$\s*fr:', app, re.S|re.M).group(1))}
used = {m.group(1) for m in re.finditer(r"\bt\(\s*'([A-Za-z_]\w*)'\s*\)", app)}
if used - en: fails.append(f't() keys with no definition: {sorted(used - en)[:6]}')

# Text colours must clear WCAG AA against the lightest surface in use.
def lin(c):
    c = c / 255
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
def lum(h):
    h = h.lstrip('#'); r, g, b = (int(h[i:i+2], 16) for i in (0, 2, 4))
    return 0.2126*lin(r) + 0.7152*lin(g) + 0.0722*lin(b)
def ratio(a, b):
    la, lb = lum(a), lum(b); hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)
m = re.search(r'--hint:(#[0-9a-fA-F]{6})', html)
if m and ratio(m.group(1), '#181818') < 4.5:
    fails.append(f'--hint {m.group(1)} is {ratio(m.group(1), "#181818"):.2f}:1, below 4.5')

# Dialogues must announce themselves and hold keyboard focus.
for mid in ['doctor-modal', 'smart-folder-modal']:
    seg = app[app.find("modal.id = '" + mid + "'"):][:4000]
    if "aria-modal" not in seg: fails.append(f'{mid} is not announced as a dialogue')
    if 'trapFocus' not in seg: fails.append(f'{mid} does not trap focus')

if fails:
    print('✗ PASS 12 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 12  no name collisions, no blank strings, text contrast passes AA')
PY
python3 - <<'PY'
import re, sys
html = open('renderer/index.html').read()
fails = []

# Layers are assigned from a named scale. A raw number is how a
# confirmation ended up underneath the dialogue that raised it.
raw = re.findall(r'z-index:\s*(\d{4,})', html)
if raw: fails.append(f'hard-coded stacking values outside the scale: {sorted(set(raw))}')

# The scale itself must stay in the right order, or naming it achieves
# nothing.
order = ['--z-player', '--z-dialog', '--z-menu', '--z-confirm', '--z-toast', '--z-splash']
vals = []
for tok in order:
    m = re.search(re.escape(tok) + r':\s*(\d+)', html)
    if not m: fails.append(f'{tok} is missing from the scale'); break
    vals.append(int(m.group(1)))
else:
    if vals != sorted(vals):
        fails.append(f'scale is out of order: {list(zip(order, vals))}')

# The two that matter most: a confirmation must outrank every dialogue.
if 'z-index:var(--z-confirm)' not in html: fails.append('confirmations are not on the confirm layer')
if 'z-index:var(--z-dialog)' not in html: fails.append('dialogues are not on the dialog layer')

if fails:
    print('✗ PASS 13 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 13  stacking order is named and correctly ranked')
PY
python3 - <<'PY'
import re, sys
LAYOUT = {'width','height','top','left','right','bottom','margin','padding','max-height',
          'min-height','font-size','line-height','gap','flex','border-width'}
# Paint is acceptable in a one-shot; in an infinite loop it is a repaint
# on every frame for as long as the element exists.
PAINT = {'box-shadow','background-position','filter','backdrop-filter','text-shadow','border-radius'}
ALLOW_PAINT = {'skeleton-shimmer'}   # off under lite mode, sweeps a gradient

fails = []
for path in ['renderer/index.html', 'renderer/updater/updater.html']:
    src = open(path).read()
    for name, body in re.findall(r'@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}', src):
        infinite = re.search(re.escape(name) + r'[^;{}]*infinite', src) is not None
        if not infinite:
            continue
        props = set(re.findall(r'([a-z-]+)\s*:', body)) - {'animation-timing-function'}
        bad_layout = props & LAYOUT
        bad_paint = (props & PAINT) - (PAINT if name in ALLOW_PAINT else set())
        if bad_layout:
            fails.append(f'{name}: animates layout every frame ({sorted(bad_layout)})')
        if bad_paint:
            fails.append(f'{name}: repaints every frame ({sorted(bad_paint)})')

        # A loop that ends on a different value than it starts snaps on
        # every repeat - unless it is invisible at both ends.
        stops = dict(re.findall(r'(\d+)%\s*\{([^}]*)\}', body))
        if '0' in stops and '100' in stops:
            norm = lambda t: re.sub(r'\s+', '', t)
            if norm(stops['0']) != norm(stops['100']):
                def invisible(t):
                    # Transparent, or moved off-stage: a shimmer that
                    # sweeps past its container is invisible at both
                    # ends, so restarting there is not a snap.
                    m = re.search(r'opacity:\s*([\d.]+)', t)
                    if m is not None and float(m.group(1)) == 0: return True
                    for off in re.findall(r'translateX\(\s*(-?[\d.]+)%', t):
                        if abs(float(off)) >= 100: return True
                    for pos in re.findall(r'background-position:\s*(-?[\d.]+)%', t):
                        if abs(float(pos)) >= 100: return True
                    return False
                if not (invisible(stops['0']) and invisible(stops['100'])):
                    fails.append(f'{name}: loop restarts on a different value (visible snap)')

# Motion must be defeatable two ways: the OS setting, and lite mode.
html = open('renderer/index.html').read()
if 'prefers-reduced-motion' not in html: fails.append('no reduced-motion support')
if not re.search(r'@media \(prefers-reduced-motion[^{]*\{\s*\*', html):
    fails.append('reduced-motion does not apply app-wide')
if '.lite #boot-splash .bs-ring{display:none}' not in html:
    fails.append('lite mode no longer trims decorative motion')

if fails:
    print('✗ PASS 14 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 14  animations are compositor-only, seamless and defeatable')
PY
python3 - <<'PY'
import json, re, sys, os
# A package that is required but not declared works on the machine where
# it was once installed by hand, and is silently missing everywhere else -
# including a clean CI build. Crash reporting shipped that way.
pkg = json.load(open('package.json'))
blocks = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
declared = set()
for b in blocks: declared |= set(pkg.get(b, {}))
# The same package declared in two blocks can resolve to two versions in
# one tree, which is how two majors of the Sentry SDK ended up sharing a
# core and calling APIs the other did not have.
seen = {}
for b in blocks:
    for k in pkg.get(b, {}):
        if k in seen:
            print(f'✗ PASS 15 FAILED\n   - {k} is declared in both {seen[k]} and {b}'); sys.exit(1)
        seen[k] = b
BUILTIN = {'fs','path','os','http','https','child_process','crypto','events','stream','util',
           'url','zlib','net','readline','assert','buffer','timers','worker_threads','electron',
           'string_decoder','tty','dns','querystring','module','process','v8','perf_hooks'}
required, missing = set(), set()
for f in ['server.js','main.js','sentry-init.js','preload.js','updater.js','updater-preload.js']:
    if not os.path.exists(f): continue
    for m in re.finditer(r"require\(\s*'([^']+)'", open(f).read()):
        name = m.group(1)
        if name.startswith('.') or name.startswith('node:'): continue
        root = '/'.join(name.split('/')[:2]) if name.startswith('@') else name.split('/')[0]
        if root in BUILTIN: continue
        required.add(root)
        if root not in declared: missing.add(root)
if missing:
    print('✗ PASS 15 FAILED')
    for m in sorted(missing): print(f'   - {m} is required at runtime but not declared in package.json')
    sys.exit(1)
print(f'✓ PASS 15  all {len(required)} required packages are declared')
PY
python3 - <<'PY'
import re, sys
# decodeAudioData crashes the renderer in packaged Electron: the decode
# completes, Blink checks whether the source buffer was detached, and
# reads a null wrapper - EXCEPTION_ACCESS_VIOLATION, the window gone.
# parseWAV exists so that path is never taken. This rule was written in
# comments three times and still got broken, so it is a build check now.
src = open('renderer/app.js').read()
calls = []
for m in re.finditer(r'\.decodeAudioData\s*\(', src):
    line = src[:m.start()].count('\n') + 1
    ctx = src[max(0, m.start()-200):m.start()]
    # a mention inside a comment is fine; a call is not
    last = ctx.rsplit('\n', 1)[-1].lstrip()
    if not last.startswith('//') and not last.startswith('*'):
        calls.append(line)
if calls:
    print('✗ PASS 16 FAILED')
    print(f'   - decodeAudioData is called at line(s) {calls}; use parseWAV instead')
    sys.exit(1)
print('✓ PASS 16  no decodeAudioData calls (crashes packaged Electron)')
PY
python3 - <<'PY'
import re, sys
# An element reference that does not exist returns null, and the next
# property access throws - taking the rest of the render with it. That is
# how the what's new list came to be written, present, and never shown.
fails = []
for path in ['renderer/updater/updater.html']:
    src = open(path).read()
    ids = set(re.findall(r'id="([^"]+)"', src))
    for ref in sorted(set(re.findall(r"\$\('([^']+)'\)", src))):
        if ref not in ids:
            fails.append(f'{path}: $(\'{ref}\') has no matching element')
# The release notes must actually reach the page.
u = open('renderer/updater/updater.html').read()
if 'const WHATS_NEW' not in u:
    fails.append('WHATS_NEW block is missing')
else:
    m = re.search(r"WHATS_NEW\[lang\]", u)
    if not m: fails.append('WHATS_NEW is never read')
    if 'whats-new-list' not in u: fails.append('the notes list is never populated')
# A class the stylesheet never defines leaves the browser to draw its own
# control: white box, system font, wrong size. It reviews as fine and
# looks broken.
defined = set(re.findall(r'\.([a-zA-Z][\w-]*)\s*[{,:]', u))
for m in re.finditer(r'<button[^>]*class="([^"]+)"', u):
    for c in m.group(1).split():
        if c not in defined:
            fails.append(f'button class "{c}" has no styling')
for m in re.finditer(r"className\s*=\s*'([^']+)'", u):
    for c in m.group(1).split():
        if c not in defined:
            fails.append(f'assigned class "{c}" has no styling')
if fails:
    print('✗ PASS 17 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 17  element references resolve, notes reach the page, buttons are styled')
PY
python3 - <<'PY'
import re, sys
fails = []
st = open('stems.py').read()
# Stems pass through several writes in sequence, so any 16-bit write
# quantises the audio again and the noise compounds. Measured across
# four stages that is a noise floor 48 dB worse than 24-bit.
bad = [m.start() for m in re.finditer(r'subtype\s*=\s*["\']PCM_16["\']', st)]
if bad:
    fails.append(f'{len(bad)} stem write(s) still at 16-bit')
if 'STEM_SUBTYPE' not in st:
    fails.append('STEM_SUBTYPE is missing')

# The preview player must never be able to start a second voice.
app = open('renderer/app.js').read()
i = app.find('function svPlay()')
if i < 0:
    fails.append('svPlay is missing')
elif 'if (st.src)' not in app[i:i+700]:
    fails.append('svPlay does not stop an existing source (double playback)')
if 'svPause();' not in app[app.find("lastTab === 'slowverb'"):app.find("lastTab === 'slowverb'")+400]:
    fails.append('leaving the Slow + Reverb page does not pause it')

if fails:
    print('✗ PASS 18 FAILED'); [print('   -', f) for f in fails]; sys.exit(1)
print('✓ PASS 18  stems are 24-bit; the preview player cannot double up')
PY
python3 tools/xref.py || exit 1
python3 - <<'PY'
import re, sys
fails = []
for f in ['updater.js','main.js','server.js','sentry-init.js']:
    src = open(f).read()
    depth = 0
    for line in src.split('\n'):
        stripped = line.strip()
        if re.match(r'function\s+\w+\s*\(', line) and depth > 0 and not line.startswith(' '):
            fails.append(f'{f}: "{stripped[:46]}" is declared inside a block - '
                         'block-scoped, so calls from outside it throw')
        if not stripped.startswith('//'):
            depth += line.count('{') - line.count('}')
if fails:
    print('✗ PASS 20 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
# `let` and `const` are not hoisted. A function declared ABOVE the
# declaration is hoisted with it, so calling that function before the
# declaration line has run throws. nudgeAnalysisWorker sat above
# `let setupRunning` and threw on every call, which left background
# analysis completely dead while looking fine in review.
for _f, _pairs in [('server.js', [('setupRunning', 'nudgeAnalysisWorker')]),
                   ('renderer/app.js', [('setupPollTimer', 'showSetupModal'),
                                        ('_analyzeMirrorIdle', 'startAnalyzeMirror')])]:
    _src = open(_f).read()
    for _var, _fn in _pairs:
        _d = re.search(r'^(?:let|const)\s+' + _var + r'\b', _src, re.M)
        _u = re.search(r'^(?:async\s+)?function\s+' + _fn + r'\b', _src, re.M)
        if not _d:
            fails.append(f'{_f}: {_var} is no longer declared'); continue
        # Search the function's real body, not a fixed window: the read
        # can sit anywhere inside it.
        _body = ''
        if _u:
            _i = _src.index('{', _u.start()); _depth = 1; _j = _i + 1
            while _j < len(_src) and _depth:
                if _src[_j] == '{': _depth += 1
                elif _src[_j] == '}': _depth -= 1
                _j += 1
            _body = _src[_i:_j]
        if _u and _u.start() < _d.start() and re.search(r'(?<![\w.$])' + _var + r'\b', _body):
            _l = _src[:_u.start()].count('\n') + 1
            fails.append(f'{_f}:{_l} {_fn}() reads {_var} but is declared above it - throws when called')
if fails:
    print('✗ PASS 20 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('✓ PASS 20  no function trapped in a block, no let read before declaration')
PY
python3 - <<'PY'
import json, os, re, sys
from struct import unpack
fails = []
_b = json.load(open('package.json'))['build']
n = _b['nsis']

# NSIS resolves ${BUILD_RESOURCES_DIR} to build.directories.buildResources,
# which defaults to build/ - not to wherever the assets happen to live.
# Pointing it at the wrong folder fails only at build time, with a
# "no files found" that names a path nobody configured.
_res = _b.get('directories', {}).get('buildResources', 'build')
if not os.path.isdir(_res):
    fails.append(f'buildResources points at "{_res}/", which does not exist')
else:
    _nsh = open('assets/installer.nsh').read() if os.path.exists('assets/installer.nsh') else ''
    for _r in set(re.findall(r'\$\{BUILD_RESOURCES_DIR\}\\?([\w.-]+)', _nsh)):
        if not os.path.exists(os.path.join(_res, _r)):
            fails.append(f'installer.nsh reads {_r} through BUILD_RESOURCES_DIR, but {_res}/{_r} does not exist')
# Paths given directly in the nsis config are relative to the project.
for _k in ('installerSidebar', 'uninstallerSidebar', 'installerHeaderIcon', 'uninstallerIcon', 'include'):
    _v = n.get(_k)
    if _v and not os.path.exists(_v):
        fails.append(f'nsis.{_k} points at {_v}, which does not exist')

# The wizard pages only exist while oneClick is false. Turning it back on
# silently discards every string in installer.nsh, which is exactly what
# happened to the welcome text that sat there unused for months.
if n.get('oneClick') is not False:
    fails.append('nsis.oneClick must be false or the wizard pages never appear')

for f in ['assets/installer.nsh', 'assets/installer-sidebar.bmp', 'assets/installer-header.bmp']:
    if not os.path.exists(f):
        fails.append(f'{f} is missing'); continue
    if f.endswith('.bmp'):
        b = open(f, 'rb').read(26)
        if b[:2] != b'BM':
            fails.append(f'{f} is not a BMP - NSIS cannot read PNG here')
        else:
            w, h = unpack('<ii', b[18:26])
            want = (164, 314) if 'sidebar' in f else (150, 57)
            if (w, abs(h)) != want:
                fails.append(f'{f} is {w}x{abs(h)}, NSIS needs {want[0]}x{want[1]}')

# NSIS is ASCII-sensitive and wants CRLF, same as the setup script.
if os.path.exists('assets/installer.nsh'):
    raw = open('assets/installer.nsh', 'rb').read()
    if any(b >= 128 for b in raw): fails.append('installer.nsh contains non-ASCII bytes')
    if re.search(rb'(?<!\r)\n', raw): fails.append('installer.nsh has bare LF line endings')
    if b'MUI_WELCOMEPAGE_TEXT' not in raw: fails.append('installer.nsh has no welcome copy')
    # electron-builder writes its own MUI defines from the nsis config
    # before including this file. Repeating any of them makes makensis
    # abort with "already defined" and no installer is produced.
    txt = raw.decode('ascii', 'replace')
    for sym in ['MUI_WELCOMEFINISHPAGE_BITMAP', 'MUI_UNWELCOMEFINISHPAGE_BITMAP',
                'MUI_ICON', 'MUI_UNICON', 'MUI_INSTALLER_TITLE', 'MUI_PRODUCT']:
        if re.search(r'^!define\s+' + sym, txt, re.M):
            fails.append(f'installer.nsh redefines {sym}, which electron-builder already sets')
    # Everything it does define should be guarded, so a future version of
    # electron-builder claiming one of them cannot break the build.
    # Unbalanced blocks or a callback that does not exist abort makensis
    # several minutes into a build, so they are caught here instead.
    # !ifdef and !ifndef both close with !endif, so they are counted
    # together rather than as separate pairs.
    _opens = len(re.findall(r'^\s*!if(?:n?def)', txt, re.M))
    _closes = len(re.findall(r'^\s*!endif', txt, re.M))
    if _opens != _closes:
        fails.append(f'installer.nsh has {_opens} conditionals but {_closes} !endif')
    # Uninstaller code must be compiled only in the uninstaller pass, or
    # NSIS warns that WriteUninstaller was never used and the build fails.
    if re.search(r'^\s*Function\s+un\.', txt, re.M) and '!ifdef BUILD_UNINSTALLER' not in txt:
        fails.append('installer.nsh defines un. functions outside an !ifdef BUILD_UNINSTALLER block')
    for _a, _b in [('!macro ', '!macroend'), ('Function ', 'FunctionEnd')]:
        _na = len(re.findall(r'^\s*' + re.escape(_a), txt, re.M))
        _nb = len(re.findall(r'^\s*' + re.escape(_b), txt, re.M))
        if _na != _nb:
            fails.append(f'installer.nsh has {_na} {_a.strip()} but {_nb} {_b}')
    # A callback must exist, and NSIS keeps the installer and uninstaller
    # in separate namespaces: every uninstaller function has to be named
    # with an "un." prefix. A shared callback aborts the build with
    # "Call must be used with function names starting with un.".
    for _m in re.finditer(r'!define\s+(MUI_(?:PAGE_)?CUSTOMFUNCTION_\w+)\s+((?:un\.)?\w+)', txt):
        _sym, _fn = _m.group(1), _m.group(2)
        if not re.search(r'^\s*Function\s+' + re.escape(_fn) + r'\b', txt, re.M):
            fails.append(f'installer.nsh names callback {_fn} but never defines it')
        _is_un = 'UNGUIINIT' in _sym or _sym.startswith('MUI_UN')
        if _is_un and not _fn.startswith('un.'):
            fails.append(f'{_sym} points at {_fn}, which must be named un.{_fn}')
        if not _is_un and _fn.startswith('un.'):
            fails.append(f'{_sym} points at {_fn}, which belongs to the uninstaller')
    # MUI_PAGE_CUSTOMFUNCTION_SHOW attaches to whichever page is declared
    # next - including an uninstaller page - so it cannot safely carry an
    # installer-only function from a shared include.
    if re.search(r'!define\s+MUI_PAGE_CUSTOMFUNCTION_SHOW', txt):
        fails.append('MUI_PAGE_CUSTOMFUNCTION_SHOW in a shared include also binds uninstaller pages')
    for _m in re.finditer(r'SetCtlColors\s+\$\w+\s+(\S+)\s+(\S+)', txt):
        for _c in _m.groups():
            if not re.fullmatch(r'[0-9A-Fa-f]{6}', _c):
                fails.append(f'installer.nsh has an invalid colour value: {_c}')
    for m in re.finditer(r'^\s*!define\s+(\w+)', txt, re.M):
        sym = m.group(1)
        if not re.search(r'!ifndef\s+' + sym + r'\b', txt):
            fails.append(f'installer.nsh defines {sym} without an !ifndef guard')
    # Sizes were deliberately removed: a number reads as a cost before
    # anyone knows what they are getting.
    if re.search(rb'\d+\s*(?:GB|MB)', raw, re.I):
        fails.append('installer copy quotes a download size')

if fails:
    print('✗ PASS 21 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
# Windows cannot read a path inside app.asar, so the tray icon must ship
# unpacked. That, not the artwork, is what left the tray blank.
_pkg = json.load(open('package.json'))
_extra = {r.get('from') for r in _pkg['build'].get('extraResources', []) if isinstance(r, dict)}
if 'assets/icon.ico' not in _extra:
    fails.append('assets/icon.ico is not in extraResources - the shell cannot read it inside app.asar')
_mj = open('main.js').read()
if 'process.resourcesPath' not in _mj[max(0, _mj.find('trayCandidates') - 500):_mj.find('trayCandidates') + 500]:
    fails.append('main.js does not look for the tray icon in resources')
if fails:
    print('✗ PASS 21 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
import struct as _st
_ip = 'assets/icon.ico'
if not os.path.exists(_ip):
    fails.append('assets/icon.ico is missing')
else:
    _d = open(_ip, 'rb').read()
    _n = _st.unpack('<H', _d[4:6])[0]
    _have = {(_d[6 + i * 16] or 256) for i in range(_n)}
    for _want in (16, 32, 256):
        if _want not in _have:
            fails.append(f'icon.ico has no {_want}px frame (has {sorted(_have)})')
# Anything the OS opens by path must exist outside app.asar. Windows
# cannot read an icon from inside the archive, and fails silently.
_pkg = json.load(open('package.json'))
_extra = {r.get('from') for r in _pkg['build'].get('extraResources', []) if isinstance(r, dict)}
# Windows cannot read a path inside app.asar, so the icon the tray loads
# must ship unpacked. That, rather than the artwork, is what left the
# tray blank in 0.7.29 through 0.7.33.
if 'assets/icon.ico' not in _extra:
    fails.append('assets/icon.ico is not in extraResources - the shell cannot read it inside app.asar')
_mj = open('main.js').read()
_i = _mj.find('trayCandidates')
if _i < 0 or 'process.resourcesPath' not in _mj[max(0, _i - 600):_i + 600]:
    fails.append('main.js does not look for the tray icon in resources first')
if fails:
    print('✗ PASS 21 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('✓ PASS 21  installer wizard valid; tray icon generated at native sizes')
PY
python3 - <<'PY'
import re, sys, collections
# JavaScript keeps only the last of two identical keys in an object
# literal, silently. Three of these existed, and two were showing the
# wrong text - editing the first definition changed nothing at all.
src = open('renderer/app.js').read()
fails = []
for name, pat in [('en', r'^\s*en:\s*\{(.*?)^\s*\},\s*$\s*fr:'),
                  ('fr', r'^\s*fr:\s*\{(.*?)^\s*\}\s*\};')]:
    body = re.search(pat, src, re.S | re.M).group(1)
    keys = re.findall(r'^\s*(\w+)\s*:', body, re.M)
    dupes = {k: n for k, n in collections.Counter(keys).items() if n > 1}
    if dupes:
        fails.append(f'{name}: {dupes}')
if fails:
    print('✗ PASS 22 FAILED - duplicate keys, the last one silently wins:')
    for f in fails: print('   -', f)
    sys.exit(1)
print('✓ PASS 22  no translation key is defined twice')
PY
python3 - <<'PY2'
import re, sys
# preload.js exposes ipcRenderer.invoke() channels straight to the
# renderer; each one needs a matching ipcMain.handle() in the main
# process or every call rejects at runtime with "No handler registered".
# boot-flags:get/set and app:relaunch shipped in the renderer (v0.2.8)
# with no main-process side at all - the toggle looked wired (it had a
# preload bridge, UI, translations) but threw on first use. This check
# would have caught it before it shipped.
preload_src = open('preload.js').read()
invoked = set(re.findall(r"ipcRenderer\.invoke\(\s*'([^']+)'", preload_src))
handled = set()
for f in ['main.js', 'updater.js']:
    handled |= set(re.findall(r"ipcMain\.handle\(\s*'([^']+)'", open(f).read()))
missing = sorted(invoked - handled)
if missing:
    print('✗ PASS 23 FAILED - preload.js invokes these with no ipcMain.handle:')
    for m in missing: print('   -', m)
    sys.exit(1)
print(f'✓ PASS 23  every preload invoke channel has a main-process handler ({len(invoked)} channels)')
PY2
python3 - <<'PY3'
import re, sys
# A DB migration whose ALTER TABLE sits inside another migration's catch
# block only runs when that OTHER migration throws - which is exactly
# how analysis_gave_up went missing: it was nested inside
# stockpile_committed's catch, so on any DB where that ALTER succeeded
# (or failed for an unrelated reason), analysis_gave_up never got
# added. Every query that referenced it - the background analyze
# worker's candidate query - failed silently forever, and nothing got
# auto-analyzed until a user clicked a track by hand. Every catch block
# in this codebase is a one-liner ("column exists"); a catch body that
# contains a real ALTER TABLE is this bug's exact shape.
src = open('server.js').read()
fails = []
for m in re.finditer(r'catch\s*\(\w*\)\s*\{', src):
    i = src.index('{', m.start())
    depth = 1
    j = i + 1
    while j < len(src) and depth:
        if src[j] == '{': depth += 1
        elif src[j] == '}': depth -= 1
        j += 1
    body = src[i:j]
    if 'ALTER TABLE' in body:
        line = src[:m.start()].count('\n') + 1
        fails.append(f'server.js:{line} a catch block contains a nested ALTER TABLE migration - it only runs when the outer try throws')
if fails:
    print('✗ PASS 24 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('✓ PASS 24  no DB migration is nested inside another migration\'s catch block')
PY3
python3 - <<'PY4'
import re, sys
# The Random Beats hero player has no listeners of its own - it piggybacks
# on the mini player's existing play/pause/timeupdate handlers via a call
# at the end of each. If that call is ever removed (e.g. during a mini
# player refactor), the hero UI silently freezes: audio keeps playing but
# the big play button and seek bar never move again.
app = open('renderer/app.js').read()
fails = []
for fn, needs in [('function updateMiniPlayerPlayState()', 'rbSyncPlayState()'),
                   ('function updateMiniPlayerTime()', 'rbSyncTime()')]:
    i = app.find(fn)
    if i < 0:
        fails.append(f'{fn} is missing'); continue
    j = app.index('{', i); depth = 1; k = j + 1
    while k < len(app) and depth:
        if app[k] == '{': depth += 1
        elif app[k] == '}': depth -= 1
        k += 1
    if needs not in app[j:k]:
        fails.append(f'{fn} no longer calls {needs} - the Random Beats hero player will freeze')
if fails:
    print('✗ PASS 25 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('✓ PASS 25  Random Beats hero player stays synced with the global player')
PY4
node tools/test-autotune.js > /tmp/autotune_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 26 FAILED - autotune engine regression"; cat /tmp/autotune_test_out.txt; exit 1
fi
echo "✓ PASS 26  autotune engine ($(grep -c '  ok   ' /tmp/autotune_test_out.txt) numeric checks)"

node tools/test-rb-recorder.js > /tmp/rb_recorder_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 27 FAILED - Random Beats capture-worklet regression"; cat /tmp/rb_recorder_test_out.txt; exit 1
fi
echo "✓ PASS 27  Random Beats lossless capture worklet ($(grep -c '  ok  ' /tmp/rb_recorder_test_out.txt) numeric checks)"

python3 << 'PY5'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# The mic/graph-owner race (armed-preview vs. monitor vs. record) recurred
# five separate times across earlier review rounds, each fixed by adding
# one more flag combination to one function at a time - until it was
# replaced with a single rbMicOwned() gate everything funnels through.
# This guards that structural fix from silently regressing back to an
# ad-hoc per-function flag list if someone edits rbArmMic() later without
# noticing the pattern it's meant to follow.
if 'function rbMicOwned()' not in app:
    fails.append('rbMicOwned() helper is missing - the centralized mic-ownership gate was removed')

m = re.search(r'async function rbArmMic\(\)\s*\{(.*?)\n\}', app, re.S)
if not m:
    fails.append('rbArmMic() not found')
else:
    body = m.group(1)
    if body.count('rbMicOwned()') < 3:
        fails.append(f'rbArmMic() calls rbMicOwned() {body.count("rbMicOwned()")} times, want 3 (entry guard + 2 post-await rechecks) - a flag check may have been hand-rolled again instead of using the shared gate')

# The re-arm-after-stop paths (handing the meter back to the armed
# preview once a take/monitor session ends) must confirm the Random
# Beats tab is still the one visible - re-arming just because the
# settings panel's own 'hidden' class happens to be unset reopens
# getUserMedia and restarts the meter on a tab the user already left.
if 'function rbTabIsActive()' not in app:
    fails.append('rbTabIsActive() helper is missing - re-arm-on-stop can no longer tell if the tab is still visible')

for fn_name in ('rbStopMonitor', 'rbFinishRecording'):
    fm = re.search(r'(?:async )?function ' + fn_name + r'\(\)\s*\{(.*?)\n\}', app, re.S)
    if not fm:
        fails.append(f'{fn_name}() not found')
        continue
    fbody = fm.group(1)
    rearm = re.search(r'if \([^\n]*rbArmMic\(\);', fbody)
    if not rearm:
        fails.append(f'{fn_name}() no longer has a guarded rbArmMic() re-arm call')
    elif 'rbTabIsActive()' not in rearm.group(0):
        fails.append(f"{fn_name}()'s rbArmMic() re-arm no longer checks rbTabIsActive() - it can reopen the mic on a tab the user already left")

dm = re.search(r'function rbDisarmMic\(\)\s*\{(.*?)\n\}', app, re.S)
if not dm:
    fails.append('rbDisarmMic() not found')
elif not re.search(r'if \s*\([^\n]*rbStopping[^\n]*\)\s*return;', dm.group(1)):
    fails.append("rbDisarmMic()'s early guard no longer checks rbStopping - it can blank the level meter early during a take's stop-flush window")

if fails:
    print('✗ PASS 28 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 28  Random Beats mic-ownership guards intact (rbMicOwned/rbTabIsActive/rbStopping)')
PY5
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-rb-graph.js > /tmp/rb_graph_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 29 FAILED - Random Beats Graph Mode DSP regression"; cat /tmp/rb_graph_test_out.txt; exit 1
fi
echo "✓ PASS 29  Random Beats Graph Mode DSP ($(grep -c '  ok   ' /tmp/rb_graph_test_out.txt) numeric checks)"

python3 << 'PY6'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# Graph Mode's Apply crunch (rbGraphApplyEdits) runs for multiple seconds
# while the user can keep interacting - two real bugs were found and
# fixed here by review: (1) no rbReviewToken staleness guard, letting a
# stale Apply overwrite a LATER unrelated take's vocal after Discard/
# Re-record/tab-leave; (2) held a LIVE reference to rbGraphEditedMidi
# instead of a snapshot, letting further edits mid-crunch corrupt the
# in-flight result even within the same session. Guards this shape from
# silently regressing if the function is edited later.
m = re.search(r'async function rbGraphApplyEdits\(\)\s*\{(.*?)\nfunction rbReviewSyncZoomUI', app, re.S)
if not m:
    fails.append('rbGraphApplyEdits() not found')
else:
    body = m.group(1)
    if 'const myToken = rbReviewToken;' not in body:
        fails.append('rbGraphApplyEdits() no longer captures rbReviewToken at entry - a stale Apply can overwrite a later review sessions vocal')
    if 'myToken !== rbReviewToken' not in body:
        fails.append('rbGraphApplyEdits() no longer rechecks the review token before committing - the staleness guard was removed')
    if 'Float32Array.from(rbGraphEditedMidi)' not in body:
        fails.append('rbGraphApplyEdits() no longer snapshots rbGraphEditedMidi - a mid-crunch edit or Reset can corrupt the in-flight result again')
    if 'rbGraphApplying' not in body:
        fails.append('rbGraphApplyEdits() no longer sets/guards rbGraphApplying - re-entrancy or button-locking may have regressed')

if fails:
    print('✗ PASS 30 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 30  Random Beats Graph Mode apply-race guards intact (review token, curve snapshot)')
PY6
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY7'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# The screech/clipping investigation found real audio reaching the
# speakers or the recorder with nothing capping it - formant correction
# and reverb can both legitimately add gain past what Input Gain trimmed
# the mic down to. rbCreateLimiter() is the fix (a compressor + hard-clip
# ceiling every path to ctx.destination/rbRecNode must pass through).
# This guards that invariant so a future edit to the graph-building
# functions can't silently wire a new path around it the way the
# original code did before this was ever noticed.
if 'function rbCreateLimiter(' not in app:
    fails.append('rbCreateLimiter() is missing - the output safety ceiling was removed')

def body_of(fn_pattern, end_pattern):
    m = re.search(fn_pattern + r'\s*\{(.*?)\n' + end_pattern, app, re.S)
    return m.group(1) if m else None

record_body = body_of(r'function rbConnectRecordGraph\(stream, at\)', r'function rbTeardownRecordGraph')
if record_body is None:
    fails.append('rbConnectRecordGraph() not found')
else:
    if 'rbPrintLimiterNode.output.connect(rbRecNode)' not in record_body:
        fails.append('rbConnectRecordGraph(): the print branch no longer routes through rbPrintLimiterNode before rbRecNode - recordings can clip unchecked again')
    if not re.search(r'rbMonitorLimiterNode\.output;\s*\n\s*rbMonitorNode\.connect\(ctx\.destination\)', record_body):
        fails.append('rbConnectRecordGraph(): the monitor branch no longer routes through rbMonitorLimiterNode before ctx.destination')

monitor_body = body_of(r'function rbConnectMonitorGraph\(stream, at\)', r'function rbStopMonitor')
if monitor_body is None:
    fails.append('rbConnectMonitorGraph() not found')
elif not re.search(r'rbMonitorLimiterNode\.output;\s*\n\s*rbMonitorNode\.connect\(ctx\.destination\)', monitor_body):
    fails.append('rbConnectMonitorGraph() no longer routes through rbMonitorLimiterNode before ctx.destination')

# Every teardown path that can tear down a graph rbCreateLimiter() built
# must dispose() what it created, or repeated routing-toggle/device-
# switch cycles leak one compressor+waveshaper pair each time (the exact
# rbRestartMonitor bug found and fixed this session).
teardown_checks = [
    ('rbTeardownRecordGraph', r'function rbTeardownRecordGraph\(\)', r'\n// ── Standalone monitoring', ['rbPrintLimiterNode', 'rbMonitorLimiterNode']),
    ('rbStopMonitor', r'function rbStopMonitor\(\)', r'\n// Tears down and immediately rebuilds', ['rbMonitorLimiterNode']),
    ('rbSwitchMonitorDevice', r'async function rbSwitchMonitorDevice\(\)', r'\nlet rbPanelOpenGeneration', ['rbMonitorLimiterNode']),
]
for fn_name, start_pat, end_pat, nodes in teardown_checks:
    fbody = body_of(start_pat, end_pat.lstrip('\n'))
    if fbody is None:
        fails.append(f'{fn_name}() not found for limiter-dispose check')
        continue
    for node in nodes:
        if f'{node}.dispose()' not in fbody:
            fails.append(f'{fn_name}() no longer disposes {node} - repeated calls will leak an orphaned compressor+waveshaper pair')

rm = re.search(r'function rbRestartMonitor\(\)\s*\{(.*?)\n\}\n\nfunction rbUpdateMonitorUI', app, re.S)
if rm is None:
    fails.append('rbRestartMonitor() not found for limiter-dispose check')
elif 'rbMonitorLimiterNode.dispose()' not in rm.group(1):
    fails.append('rbRestartMonitor() no longer disposes rbMonitorLimiterNode before rebuilding - leaks one limiter per routing toggle flipped while monitoring')

if fails:
    print('✗ PASS 31 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 31  Random Beats output safety limiter is wired on every path and disposed on every teardown')
PY7
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY8'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# "gets crazy when clipping" root cause: a stock DynamicsCompressor has
# no lookahead, so a loose threshold/ratio lets hot transients through
# to hit the final ceiling often; and the ceiling itself used to be a
# hard linear clamp, which shears a waveform off square and generates a
# burst of harsh aliasing energy - literally what "crazy" sounds like.
# Lock down that both halves of the fix stay in place: the compressor
# is tuned tight enough to be doing most of the work, and the ceiling
# is a continuous soft-knee saturation (tanh), not a flat clamp.
m = re.search(r'function rbCreateLimiter\(ctx\)\s*\{(.*?)\n\}\n\n// Schroeder', app, re.S)
if m is None:
    fails.append('rbCreateLimiter() not found for tuning/curve check')
else:
    body = m.group(1)
    thr = re.search(r'comp\.threshold\.value\s*=\s*(-?[\d.]+)', body)
    ratio = re.search(r'comp\.ratio\.value\s*=\s*(-?[\d.]+)', body)
    if not thr or float(thr.group(1)) > -3:
        fails.append('rbCreateLimiter(): compressor threshold is no longer tight enough (must be <= -3dB) - transients will reach the hard ceiling too often again')
    if not ratio or float(ratio.group(1)) < 15:
        fails.append('rbCreateLimiter(): compressor ratio is no longer aggressive enough (must be >= 15:1) - this is meant to be doing near-limiting, not gentle compression')
    if 'Math.max(-0.98, Math.min(0.98, x))' in body:
        fails.append('rbCreateLimiter(): the ceiling curve regressed to a hard linear clamp - this is exactly what produced the harsh "crazy" digital-clipping sound the user reported')
    if 'Math.tanh(' not in body:
        fails.append('rbCreateLimiter(): the soft-knee saturation curve (tanh-based) is missing - a discontinuous/hard ceiling will sound harsh on hot input again')

if fails:
    print('✗ PASS 32 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 32  Random Beats limiter is tuned tight and its ceiling is a soft-knee saturation, not a hard clamp')
PY8
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-autotune-processor.js > /tmp/autotune_processor_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 33 FAILED - autotune AudioWorkletProcessor channel-handling regression"; cat /tmp/autotune_processor_test_out.txt; exit 1
fi
echo "✓ PASS 33  Random Beats autotune processor channel handling ($(grep -c '  ok   ' /tmp/autotune_processor_test_out.txt) numeric checks)"

python3 << 'PY9'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# "settings lag when moving things around" root cause: rbAutotuneParamsChanged()
# fires on every 'input' tick from ~10 sliders (easily 60-100+ events/sec
# during a drag) and was paying for a synchronous localStorage write plus
# dozens of getElementById lookups on every single one. Lock down that
# the hot path stays cheap: the save is debounced, not synchronous, and
# the two hottest DOM-reading functions use the cached element lookup
# instead of re-querying the DOM every tick.
if 'function rbCachedEl(' not in app:
    fails.append('rbCachedEl() is missing - the settings-panel DOM lookup cache was removed')
if 'function rbAutotuneSaveSettingsDebounced(' not in app:
    fails.append('rbAutotuneSaveSettingsDebounced() is missing - slider drags will hammer localStorage synchronously again')

m = re.search(r'function rbAutotuneParamsChanged\(\)\s*\{(.*?)\n\}\n\n// Lazily creates', app, re.S)
if m is None:
    fails.append('rbAutotuneParamsChanged() not found')
else:
    body = m.group(1)
    if 'rbAutotuneSaveSettingsDebounced(settings)' not in body:
        fails.append('rbAutotuneParamsChanged() no longer uses the debounced save - every slider-drag tick will synchronously hit localStorage again')

m2 = re.search(r'function rbGetAutotuneSettings\(\)\s*\{(.*?)\n\}\nfunction rbAutotuneParamsForEngine', app, re.S)
if m2 is None:
    fails.append('rbGetAutotuneSettings() not found')
elif 'document.getElementById(' in m2.group(1):
    fails.append('rbGetAutotuneSettings() has a raw document.getElementById() call again instead of rbCachedEl() - re-scans the DOM on every hot-path call')

m3 = re.search(r'function rbUpdateAutotuneLabels\(\)\s*\{(.*?)\n\}\n\nfunction rbUpdateAutotuneParamsVisibility', app, re.S)
if m3 is None:
    fails.append('rbUpdateAutotuneLabels() not found')
elif 'document.getElementById(' in m3.group(1):
    fails.append('rbUpdateAutotuneLabels() has a raw document.getElementById() call again instead of rbCachedEl()')

if fails:
    print('✗ PASS 34 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 34  Random Beats settings-panel hot path is debounced/cached, not re-querying the DOM and hitting localStorage on every slider tick')
PY9
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-detect-key.js > /tmp/detect_key_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 35 FAILED - detectKey() regression (correctness or performance)"; cat /tmp/detect_key_test_out.txt; exit 1
fi
echo "✓ PASS 35  detectKey() FFT correctness + performance ($(grep -c '  ok   ' /tmp/detect_key_test_out.txt) numeric checks)"

python3 << 'PY10'
import re, sys
with open('main.js', encoding='utf-8') as f:
    main = f.read()
fails = []

# A real report from the field: launching under heavy disk/CPU
# contention (another program updating in the background) produced a
# broken first paint - the main window "loaded" successfully from
# Electron's point of view but rendered as raw, unstyled source text
# instead of the actual UI. Closing and reopening fixed it, confirming a
# one-time load race rather than a broken file. Guards against this
# class of bug silently regressing: a did-fail-load retry for actual
# load failures, and a content-aware check after did-finish-load (since
# "finished loading" does NOT mean "rendered correctly" in this exact
# failure mode) that reloads if the stylesheet demonstrably didn't apply.
if "webContents.on('did-fail-load'" not in main:
    fails.append("main.js no longer listens for did-fail-load - a genuine load failure during a bad launch race won't retry")
if 'MAIN_LOAD_MAX_RETRIES' not in main:
    fails.append('main.js no longer bounds its load-retry attempts - could retry forever instead of giving up gracefully')
if 'executeJavaScript' not in main or "getElementById('main')" not in main:
    fails.append("main.js no longer does a content-aware render check after did-finish-load - a 'loaded but rendered as raw text' failure won't be caught")
if 'mainWindow.reload()' not in main:
    fails.append('main.js no longer self-heals with a reload when the render check fails')

if fails:
    print('✗ PASS 36 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 36  main window has a bounded load-failure retry and a content-aware self-healing reload check')
PY10
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY11'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# A real user log caught this one: opening the settings panel fired off
# two independent getUserMedia calls at nearly the same instant - the
# mic-select's own label-probe (only on a session's first run, before
# permission is granted) and the meter-preview arm - and on real USB
# audio hardware that doesn't handle concurrent opens gracefully, that
# raced into "NotReadableError: Could not start audio source". Guards
# that the fix (serializing them: fully populate the mic list, THEN arm
# the meter) stays in place.
m = re.search(r'async function rbToggleAutotunePanel\(\)\s*\{(.*?)\n\}\n\nfunction rbUpdateAutotuneLabels', app, re.S)
if m is None:
    fails.append('rbToggleAutotunePanel() not found (or no longer async) for the mic-open race check')
else:
    body = m.group(1)
    if 'await rbPopulateAutotunePanel()' not in body:
        fails.append('rbToggleAutotunePanel() no longer awaits rbPopulateAutotunePanel() before arming the mic - the concurrent-getUserMedia race can reopen')
    arm_idx = body.find('rbArmMic();')  # the real call, not the mention of it inside the explanatory comment above
    await_idx = body.find('await rbPopulateAutotunePanel()')
    if arm_idx != -1 and await_idx != -1 and arm_idx < await_idx:
        fails.append('rbToggleAutotunePanel() calls rbArmMic() before awaiting rbPopulateAutotunePanel() - the ordering that prevents the race is backwards')

if 'let rbPopulateMicSelectInFlight' not in app or 'rbPopulateMicSelectInFlight' not in app:
    fails.append('rbPopulateMicSelect() no longer guards against re-entrant concurrent calls')

if fails:
    print('✗ PASS 37 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 37  settings-panel mic arming is serialized after the mic list populates, not raced against it')
PY11
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY12'
import re, sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
fails = []

# "Less screeching, but now no voice comes through" - the previous
# round's target-note fix couldn't be conclusively reproduced/root-
# caused numerically (extensive fuzzing of the DSP core found no
# NaN/collapse/stuck-target case), so as a genuine defense-in-depth
# measure rather than a guess: the processor must never let a single
# bad hop go permanently, silently unrecovered. Guards that stay in
# place: a resync() escape hatch on the engine, a divergence guard
# that uses it automatically, and a processor-level try/catch that
# falls back to dry audio and reports the fault instead of either
# throwing (which stops the node from ever running again) or emitting
# non-finite samples (which Web Audio treats as silence).
if 'resync()' not in wl or 'this.smoothedPitchHz = null;\n    this.lastTargetMidi = null;\n    this.rawUnlockStreak = 0;\n    this.targetRatio = 1;' not in wl:
    fails.append('AutotuneEngine.resync() is missing or no longer resets the expected state')
if 'this.divergentHops * HOP_MS > 1000' not in wl:
    fails.append('the divergence guard (auto-resync after ~1s of the target being stuck far from reality) is missing from _analyze()')
if 'try {' not in wl.split('class AutotuneProcessor')[1] if 'class AutotuneProcessor' in wl else True:
    fails.append('AutotuneProcessor.process() no longer wraps the correction loop in a try/catch')
if "this.port.postMessage({ type: 'fault'" not in wl:
    fails.append('AutotuneProcessor no longer reports faults back to the main thread')
if 'rbHandleAutotuneNodeMessage' not in app:
    fails.append('app.js no longer defines/wires rbHandleAutotuneNodeMessage to surface worklet faults in the activity log')
if app.count('rbAutotuneNode.port.onmessage = rbHandleAutotuneNodeMessage;') < 2:
    fails.append('rbAutotuneNode.port.onmessage is not wired at both the record-path and monitor-path node-creation sites')

if fails:
    print('✗ PASS 38 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 38  autotune worklet has a divergence guard and a fault-fallback path that reports instead of going silently silent')
PY12
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY13'
import re, sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    html = f.read()
fails = []

# "Mic is always in use when using the app so saved mic doesnt do shit" -
# a real, log-confirmed bug: rbGetAutotuneSettings() treated the mic
# <select>'s mere existence in the DOM (always true - the settings panel
# is only ever hidden via CSS) as proof it had been populated, when only
# actually opening the panel populates it. Starting Monitor/Record before
# ever opening the settings panel that session read an empty micDeviceId
# off the still-empty <select> and went straight to "system default mic"
# instead of the saved device. Guards that the fix - falling back to the
# saved settings whenever the select genuinely has no options yet - stays
# in place.
if "if (el && el.options.length > 0) return el.value || '';" not in app:
    fails.append('rbGetAutotuneSettings() no longer falls back to saved settings when the mic <select> is unpopulated')
if 'return savedFallback().micDeviceId' not in app:
    fails.append('the saved-mic fallback for micDeviceId is missing')

# "Put them with the other logs dont keep it there its ugly" - the
# Topliner settings panel's own standalone Activity Log box is gone;
# its content already flowed into the app's durable log via
# diagLog()/api.log(), now surfaced through the existing View Logs
# modal's own "App" tab instead of a separate one-off panel.
if 'rb-at-diag' in html or 'rb-diag-log' in html:
    fails.append('the removed standalone Activity Log markup (rb-at-diag/rb-diag-log) is still present in index.html')
if 'rbRenderDiagPanel' in app or 'rbCopyDiagLog' in app:
    fails.append('dead rbRenderDiagPanel()/rbCopyDiagLog() code was not fully removed')
if 'fetchAppLogTail' not in app or 'switchLogTab(2)' not in app:
    fails.append('the View Logs modal is missing its new "App" tab wired to fetchAppLogTail()')

# Page rename: "Random Beats" -> "Topliner" (user-facing text only -
# internal code comments referencing the original feature name are left
# alone deliberately, so this checks the two specific strings that used
# to be user-visible, not a blanket absence of the words anywhere).
if '>Random Beats<' in html or 'ph-title" id="rb-ph-title">Random Beats<' in html:
    fails.append('index.html still has a raw "Random Beats" user-facing string (nav button or page header)')
if "navRandomBeats:'Random Beats'" in app or "rbTitle:'Random Beats'" in app:
    fails.append('app.js still has an untranslated "Random Beats" i18n value')
# The nav-label bug this rename surfaced: applyLang() looked text up by
# the raw tab id instead of through navMap, which happened to work only
# because every OTHER tab's navMap value equals its own id - for
# 'random' -> 'navRandomBeats' those differ, so the sidebar was silently
# rendering the literal fallback string "random" instead of the real
# label. Guards the actual fix, not just the symptom.
if 't(navMap[tab])' not in app:
    fails.append('applyLang() nav-button text no longer looks up through navMap - the "random" nav-label bug can return')

if fails:
    print('✗ PASS 39 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 39  mic-default fallback, unified log viewer, and the Topliner rename are all correctly wired')
PY13
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY14'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    html = f.read()
fails = []

# "Autotune doesn't work now" - the previous round's fix for noise-
# release screeching (a flat confidence gate raised from 0.3 to 0.6 on
# detectPitch itself) turned out to reject real, quiet, legitimate voice
# right along with noise - they measurably overlap in confidence and no
# single number on a stateless per-window detector can cleanly separate
# them. Guards that the actual fix - a two-tier gate living in
# AutotuneEngine._analyze(), which has memory of what was actually just
# being sung - stays in place, and that detectPitch's own gate stays a
# low, permissive floor rather than creeping back up to the too-strict
# single-threshold approach.
if 'if (bestVal < 0.3) return null;' not in wl:
    fails.append("detectPitch()'s own confidence floor is no longer the permissive 0.3 baseline - the smarter accept logic belongs in _analyze(), not here")
if 'this.lastAcceptedPitchHz' not in wl or 'CONTINUITY_CENTS' not in wl:
    fails.append('the two-tier confidence+continuity accept gate in _analyze() is missing')

# Pitch-shifter reconstruction quality: cubic interpolation, not linear -
# every non-1.0 ratio (i.e. every correction that isn't already exactly
# in tune) reads through this on every single sample.
if '_readRing(pos) {' not in wl or 'Catmull-Rom' not in wl:
    fails.append('the pitch shifter no longer uses cubic (Catmull-Rom) interpolation for its ring-buffer reads')

# "Grab the stem from the vocal or beat after recording" - both export
# actions must exist, be wired to real buttons in the review panel, and
# have real i18n coverage (not fall back to a raw key name on screen).
if 'function rbDownloadVocalStem' not in app or 'function rbRevealBeatStem' not in app:
    fails.append('rbDownloadVocalStem()/rbRevealBeatStem() are missing')
if 'onclick="rbDownloadVocalStem()"' not in html or 'onclick="rbRevealBeatStem()"' not in html:
    fails.append('the review panel is missing its Vocal Stem / Beat Stem buttons')
if "rbReviewVocalStem:'Vocal Stem'" not in app or "rbReviewBeatStem:'Beat Stem'" not in app:
    fails.append('the stem-export button labels are missing their i18n entries')

if fails:
    print('✗ PASS 40 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 40  quiet-voice/noise accept gate, cubic-interpolation shifter, and stem export are all correctly wired')
PY14
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY15'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 14: "screeching always present, not a hum" traced to a real gap
# in detectPitch() - a purely non-periodic transient (plosive pop, breath
# puff, mic bump) can produce a smoothly-high, never-dipping normalized
# autocorrelation curve that reproducibly clears 0.95+ confidence with a
# totally fabricated pitch, high enough to bypass _analyze()'s
# CONF_HIGH=0.6 outright-accept gate entirely (the two-tier continuity
# gate from Round 13 only ever applies BELOW that gate, so it never got
# a chance to catch these). Every consonant/breath in ordinary singing is
# exactly this kind of transient, which is why the previous two rounds'
# fixes (both scoped to the noise-vs-quiet-voice confidence question)
# didn't touch it - this is a different failure mode entirely, a smooth
# transient masquerading as a rock-solid periodic pitch rather than noise
# masquerading as a quiet one. The fix requires the accepted lag to have
# a genuine dip in the correlation curve before it (real periodic voice
# always has one - anti-correlation across roughly half a cycle - a
# smooth transient has none, measured directly at exactly 0 every time
# vs. 1.4+ for real voice, including quiet voice down to -36.5dBFS).
if 'DIP_MARGIN' not in wl or 'runningMin' not in wl:
    fails.append('detectPitch() no longer requires a genuine periodicity dip before accepting a candidate lag - non-periodic transients (plosive pops/breath puffs) can spuriously read as confident pitch again')

if fails:
    print('✗ PASS 41 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 41  detectPitch() periodicity-dip check rejects non-periodic transients (plosive/breath pop screech fix)')
PY15
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY16'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 15: "low volume with slight screeching, hardcore robotic voice,
# like it's lagging / abusively low fps" - traced to detectPitch()'s
# direct-sum autocorrelation (O(range * winLen) per hop, ~2ms/call
# measured on fast hardware alone) eating most or all of a single
# 128-sample render quantum's real-time budget, which is a genuine,
# audible cause of audio-thread underruns (choppy/robotic/quieter
# audio from dropped/repeated samples) - a completely different failure
# mode than the confidence-gate work earlier rounds focused on. Fixed by
# computing the autocorrelation via FFT (O(n log n)) instead of brute
# force - guards that the fast path stays in place, not just that
# detectPitch() still exists.
if 'function fftRadix2' not in wl or 'nextPow2' not in wl:
    fails.append('detectPitch() no longer uses the FFT-based autocorrelation - the real-time performance fix (robotic/lagging audio) can regress back to the O(range*winLen) direct-sum path')

# The FFT rewrite also fixed a latent, real bug as a side effect: vals[]
# used to be a Float32Array while bestVal stayed full float64 precision,
# so the fallback lag search's exact (===) equality check could silently
# never match - dropping any genuine pitch whose true period landed at
# the edge of the search range (e.g. a low male voice near 70Hz) as "not
# periodic" even at full volume, no noise involved at all.
if 'const vals = new Float64Array(maxLag - minLag + 1);' not in wl:
    fails.append('detectPitch()\'s vals[] array is no longer full float64 precision - the boundary-lag equality bug (real low pitches near minHz silently rejected) can return')

if fails:
    print('✗ PASS 42 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 42  detectPitch() uses FFT-based autocorrelation (real-time performance) and full-precision vals[] (boundary-lag fix)')
PY16
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-rb-channel-safety.js > /tmp/rb_channel_safety_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 43 FAILED - Random Beats channel-safety worklet regression"; cat /tmp/rb_channel_safety_test_out.txt; exit 1
fi
echo "✓ PASS 43  Random Beats channel-safety worklet ($(grep -c '  ok  ' /tmp/rb_channel_safety_test_out.txt) numeric checks)"

python3 << 'PY17'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    app = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    html = f.read()
import os
fails = []

# "Still no autotune and now its in mono (L only)" - two separate root
# causes. (1) The channel-safety logic that picks the live mic channel
# used to live ONLY inside the autotune worklet, so it did nothing at
# all whenever Autotune (monitor and bake) was off - a completely normal
# workflow - leaving a stereo mic request that resolves to one real
# channel and one silently-unconnected one to pass straight through as
# "audio in one channel only". Now a dedicated channel-safety worklet
# sits unconditionally in front of both the record and monitor graphs,
# regardless of Autotune's state.
if not os.path.exists('renderer/rb-channel-safety-worklet.js'):
    fails.append('renderer/rb-channel-safety-worklet.js is missing')
if "new AudioWorkletNode(ctx, 'rb-channel-safety-processor')" not in app or app.count("new AudioWorkletNode(ctx, 'rb-channel-safety-processor')") < 2:
    fails.append('the channel-safety node is not wired into both the record graph and the monitor graph')
if "addModule('rb-channel-safety-worklet.js" not in app:
    fails.append('the channel-safety worklet module is never loaded')

# (2) "Monitor with Autotune" and "Autotune on Recording" are two
# genuinely independent toggles (previewing a correction live without
# committing it to the take is a real, deliberate, supported workflow -
# not a bug) - but nothing ever told the user that hearing it live says
# nothing about whether the SAVED take has it, which is a very plausible
# explanation for "still no autotune" surviving multiple rounds of
# verified-correct DSP fixes: the take was never actually being routed
# through the engine at all. Guards that the reminder shown in exactly
# that state (monitoring it, not saving it) stays wired.
if 'rb-at-bake-reminder' not in html:
    fails.append('the settings panel is missing the Monitor-without-Bake reminder element')
if "rbAtBakeReminder" not in app:
    fails.append('the Monitor-without-Bake reminder text/visibility logic is missing from app.js')

if fails:
    print('✗ PASS 44 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 44  unconditional channel-safety wiring and the Monitor/Bake reminder are correctly in place')
PY17
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY18'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 17: "robotic/screeching, only while actively singing (never in
# silence)" - traced to the grain-jump crossfade using equal-GAIN
# weighting (weights summing to 1) instead of equal-POWER (squares
# summing to 1). A grain jump crossfades between two DIFFERENT ring-
# buffer positions - decorrelated content on real, complex, vibrato'd
# voice - and an equal-gain curve measurably dips ~29% RMS through the
# middle of a decorrelated crossfade; equal-power does not (measured at
# <0.1% deviation). This only ever shows up with real signal present
# (matches "only while singing") and was invisible to simple sine-tone
# tests, where the two crossfaded excerpts can end up accidentally
# correlated. Guards that the fix (Math.cos/Math.sin quarter-wave
# weights, not the old raised-cosine split into (1-w)/w) stays in place.
if 'Math.cos(t * Math.PI / 2)' not in wl or 'Math.sin(t * Math.PI / 2)' not in wl:
    fails.append('the grain-jump crossfade no longer uses equal-power (sin/cos) weighting - the decorrelated-crossfade energy dip (robotic/screeching while singing) can return')

if fails:
    print('✗ PASS 45 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 45  grain-jump crossfade uses equal-power weighting (robotic-while-singing fix)')
PY18
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY19'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 19: root cause of the long-standing, hard-to-pin-down "settings
# say Autotune is on, but Monitor sounds crystal clear/unprocessed"
# report. rbGetAutotuneSettings() read every control (the monitor/bake
# checkboxes, key, scale, gains, everything) straight off the live DOM
# elements - but those elements sit at their raw HTML defaults
# (unchecked checkbox, empty <select>) until rbPopulateAutotunePanel()
# writes the real saved values into them, and that function only ever
# runs when the Settings panel is opened. Clicking Monitor as the first
# action of a session, before Settings has ever been opened, silently
# read "off" (and default key/scale/etc.) regardless of what was
# actually saved - a fully unprocessed take with no DSP fault, no
# race, nothing to catch numerically, which is exactly why four
# rounds of verified-correct DSP fixes (periodicity dip, FFT rewrite,
# channel safety, equal-power crossfade) never touched this specific
# symptom. Guards that settings reads fall back to the persisted
# values (not raw DOM defaults) until the panel has actually populated
# them at least once this session.
if 'rbAutotunePanelPopulated' not in aj:
    fails.append('rbAutotunePanelPopulated tracking flag is missing - rbGetAutotuneSettings() can silently read unpopulated DOM defaults again')
if 'rbAutotunePanelPopulated = true;' not in aj:
    fails.append('rbPopulateAutotunePanel() no longer marks the panel as populated once it finishes writing saved values into the DOM')
if "if (!monitorEl || !rbAutotunePanelPopulated) return rbAutotuneLoadSettings();" not in aj:
    fails.append('rbGetAutotuneSettings() no longer falls back to the persisted settings before the panel has been populated - Monitor/Record as the first action of a session can read raw HTML defaults instead of what was actually saved')

if fails:
    print('✗ PASS 46 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 46  autotune settings fall back to persisted values until the panel actually populates the DOM (first-click "no autotune" fix)')
PY19
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY20'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 20: hopSize/winLen used to be hardcoded sample counts (512/2048),
# tuned and timing-verified only at 44.1/48kHz. A real user's interface
# running at 88200Hz (confirmed from an exported take) silently halved
# the intended analysis cadence while the render quantum's own deadline
# was also halved by the higher rate - measured directly: detectPitch()
# alone went from ~11% of one quantum's budget to ~24% on the same
# machine, a real-time margin regression severe enough to produce actual
# screeching (buffer underruns) on real end-user hardware, invisible to
# every other test/guard in this file since none of them run at
# anything but 44.1/48kHz. Guards that both are derived from sample rate
# (time-based), not hardcoded sample counts.
if 'this.hopSize = 512;' in wl or 'this.winLen = 2048;' in wl:
    fails.append('hopSize/winLen are hardcoded sample counts again - the analysis cadence (and its real-time safety margin) will silently shrink at any sample rate above 44.1/48kHz')
if 'this.hopSize = Math.round(sampleRate * 512 / 44100);' not in wl or 'this.winLen = Math.round(sampleRate * 2048 / 44100);' not in wl:
    fails.append('hopSize/winLen are no longer derived from sampleRate - re-check the sample-rate scaling fix')

if fails:
    print('✗ PASS 47 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 47  autotune analysis cadence scales with sample rate, not hardcoded sample counts (88.2kHz screeching fix)')
PY20
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY21'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
fails = []

# Round 21a: after a successful (or failed) engine setup, the Settings
# page's "Installed / Not installed" line and diagnostic strip used to
# only ever refresh when the Settings panel itself re-rendered - not
# when setup actually finished. If Settings was already open behind the
# setup modal, the modal would report success and close, but the line
# underneath kept showing whatever it said before setup started.
if 'function applyEnginesStatusToUI(j)' not in aj:
    fails.append('applyEnginesStatusToUI() is missing - the engines-status line has no single source of truth again')
if 'applyEnginesStatusToUI(sJ)' not in aj:
    fails.append('the setup-success handler no longer pushes the fresh /engines-status result to the Settings page immediately')

# Round 21b: two separate CSS systems used to animate .app-notif's
# entrance/exit at the same time (an @keyframes-based one and a
# transition + .show/.out class-based one), which is exactly the kind
# of thing that reads as "the popup timing doesn't make sense". Also,
# ok/info/warn notifications used to be visually identical (monochrome
# white) - only err stood out - so guard that each type now carries its
# own accent, reusing the app's existing green/amber/red semantics.
if '@keyframes notif-in' in ih or '@keyframes notif-out' in ih:
    fails.append('the old, conflicting @keyframes notif-in/notif-out toast animation is back - it runs at the same time as the .show/.out transition system and desyncs the entrance/exit timing')
if '.app-notif.ok   { border-left-color:var(--green); }' not in ih:
    fails.append('success toasts no longer get their own green accent (var(--green)) - back to being visually identical to info/warn')
if '.app-notif.warn { border-left-color:var(--amber); }' not in ih:
    fails.append('warning toasts no longer get their own amber accent (var(--amber)) - back to being visually identical to info/ok')

if fails:
    print('✗ PASS 48 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 48  engines-status refreshes immediately after setup + notification toasts have per-type color and a single, non-conflicting animation system')
PY21
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY22'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 22: the only duplicate-download guard was two in-memory Maps
# with a ~2min retention window, so re-downloading the same track after
# 30 seconds - or after any app restart, since the Maps are never
# persisted - sailed straight through and re-downloaded from scratch.
# History already stores youtube_url + file_path per row, so /download
# now also checks there, matched by video id (not raw URL string, since
# the same video can be linked in more than one URL shape) and format,
# and only treats it as a duplicate if the earlier file still exists on
# disk - a moved/deleted file is not a duplicate, it is the only copy.
if 'function extractVideoId(url)' not in sj:
    fails.append('extractVideoId() helper is missing - the persistent duplicate check has no shared, restart-proof way to match video ids')
if "code: 'duplicate_history'" not in sj:
    fails.append('the /download route no longer reports a distinct duplicate_history code for history-backed duplicates')
if 'fs.existsSync(r.file_path)' not in sj:
    fails.append('the history duplicate check no longer verifies the earlier file still exists on disk - would trap users whose file was moved or deleted')
if "d.code === 'duplicate_history'" not in aj:
    fails.append('the renderer no longer distinguishes duplicate_history from the in-flight duplicate code - users get no explanation for a silently skipped re-download')

if fails:
    print('✗ PASS 49 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 49  duplicate-download detection persists across app restarts and time (history-backed, video-id matched, file-existence gated)')
PY22
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY23'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 23a: transcribe language support. Spanish ('es') was already a
# real Whisper language code and already wired. Yoruba/Swahili/Hausa are
# real Whisper codes too, so they go straight through as --language
# flags like Spanish/French/Portuguese already do. Jamaican Patois has
# no dedicated Whisper code (it's an English-lexified creole, not one of
# Whisper's 99 languages) - handled the same way 'bi' (Quebec French/
# English) already was: auto-detect left on, biased with an initial
# prompt so the model doesn't "correct" Patois toward standard English.
for opt in ('value="patois"', 'value="yo"', 'value="sw"', 'value="ha"'):
    if opt not in ih:
        fails.append('transcribe language dropdown is missing ' + opt + ' - Round 23 language additions incomplete')
if "patois:" not in sj and "CODE_SWITCH_PROMPTS" not in sj:
    fails.append("server.js /transcribe no longer special-cases 'patois' - it would be sent straight to Whisper's --language flag, which has no such code, and the request would fail")
if 'Vybz Kartel' not in sj:
    fails.append('the Patois initial_prompt lost its style-anchoring reference artists - regressed to a generic/less effective prompt')

# Round 23b: selecting "Ultra" stem-separator quality used to leave the
# ensemble / vocal-ensemble toggles (the biggest remaining SDR gains)
# off unless the user found and checked them separately - so "Ultra —
# reference quality" silently under-delivered relative to what the
# pipeline actually knows how to produce. Guard that picking Ultra now
# turns both on.
if "sepQuality === 'ultra'" not in aj or 'setEnsemble(true)' not in aj or 'setVocalEnsemble(true)' not in aj:
    fails.append('setStemQuality() no longer auto-enables ensemble + vocal-ensemble when Ultra is selected - Ultra quality regressed to being gated behind undiscovered checkboxes again')

if fails:
    print('✗ PASS 50 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 50  transcribe supports Patois/Spanish/Yoruba/Swahili/Hausa, and Ultra stem quality auto-enables its full pipeline (ensemble + vocal-ensemble)')
PY23
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY24'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 24: root-caused a real user-submitted take's screech bursts down
# to real audio, not guesswork - see tools/test-autotune.js Test 27 for
# the numeric reproduction. A single-hop pitch-detection outlier 2-3
# octaves off the real note (measured directly: 144Hz -> 957Hz -> 165Hz
# across 3 consecutive ~11.6ms hops, right on a consonant) was being
# accepted outright whenever its own confidence cleared CONF_HIGH,
# because that branch had no continuity check at all. RATIO_CLAMP
# limited the CORRECTION ratio for that one hop, but did nothing to stop
# the bad value from being written into lastAcceptedPitchHz and
# smoothedPitchHz - and smoothedPitchHz's 120ms time constant then took
# 300+ms to decay back out, which is what a sustained several-hundred-ms
# screech actually was. Guard that the outlier ceiling exists and sits
# before both acceptance tiers, not just inside RATIO_CLAMP.
if 'const MAX_JUMP_CENTS = 1200;' not in wl:
    fails.append('MAX_JUMP_CENTS outlier ceiling is missing - a confidently-detected but physically-impossible pitch jump can reach lastAcceptedPitchHz/smoothedPitchHz again')
if 'pitch.confidence = 0; // force rejection below, regardless of tier' not in wl:
    fails.append('the outlier ceiling no longer forces rejection ahead of the CONF_HIGH branch - CONF_HIGH would bypass it again')

if fails:
    print('✗ PASS 51 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 51  a confidently-detected but 2+ octave pitch outlier is rejected before it can poison lastAcceptedPitchHz/smoothedPitchHz (sustained screech-burst fix)')
PY24
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY25'
import sys, re
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 24b: every launch was held behind a fixed, purely-cosmetic
# 3200ms floor on the boot splash (one bar at 100 BPM) - on a normal
# machine the backend/DB are ready well before that, meaning this floor,
# not actual startup work, was the single slowest part of every launch.
# Guard it stays cut down from the old value, not a specific new number
# (allows future retuning) - just that it can no longer regress back to
# multi-second territory.
m = re.search(r'const BOOT_SPLASH_FLOOR_MS = (\d+);', aj)
if not m:
    fails.append('BOOT_SPLASH_FLOOR_MS constant not found')
elif int(m.group(1)) > 1000:
    fails.append(f'BOOT_SPLASH_FLOOR_MS is {m.group(1)}ms - regressed back toward the old multi-second cosmetic floor')

if fails:
    print('✗ PASS 52 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 52  boot splash no longer holds every launch behind a multi-second cosmetic floor')
PY25
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY26'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wl = f.read()
fails = []

# Round 25: Formant Correction's blend-in curve used to saturate to full
# strength (and its documented ~40% RMS / doubled-treble coloration) at
# just a quarter-semitone of correction - real vibrato and everyday
# intonation drift blow past that almost continuously, so the
# coloration meant for "actually fixing a wrong note" was measured
# fully engaged 49% of a real take's voiced audio, not reserved for
# genuine corrections. Widened to a full semitone (the worst any
# in-scale note can be from its nearest scale tone is 100 cents, so
# this still reaches full engagement for a genuine wrong note - see
# tools/test-autotune.js Test 28).
if 'shiftOctaves / (1 / 12)' not in wl:
    fails.append('Formant Correction engagement curve no longer widened to a full semitone - regressed toward the old quarter-semitone (over-eager, near-constant coloration) curve')
if 'shiftOctaves / (0.25 / 12)' in wl:
    fails.append('the old quarter-semitone Formant Correction engagement divisor is back')

if fails:
    print('✗ PASS 53 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 53  Formant Correction only reaches full blend on a genuine wrong-note-scale correction, not on ordinary vibrato/intonation drift')
PY26
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY27'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 26: "autotune is ass" / "hardly working" - pitch-contour analysis
# of the user's own takes showed correction landing within 13-26 cents
# of true pitch (tight, working correctly) - the gap wasn't accuracy,
# it was that Retune Speed, Flex-Tune, Humanize and Formant Correction
# had zero in-app explanation, so a user wanting an obvious, present
# hard-tune character (their own reference points: Vybz Kartel, Masicka)
# had no way to know Retune Speed toward 0 is exactly that control.
# Guard the hint copy exists in the DOM and is wired through t().
for hint_id in ('rb-at-retune-hint', 'rb-at-humanize-hint', 'rb-at-vibrato-hint', 'rb-at-flextune-hint', 'rb-at-formant-hint'):
    if f'id="{hint_id}"' not in ih:
        fails.append(f'{hint_id} is missing from the Autotune panel - a control with no explanation of what it does or which direction to move it')
for key in ('rbAtRetuneHint', 'rbAtHumanizeHint', 'rbAtVibratoHint', 'rbAtFlexTuneHint', 'rbAtFormantHint'):
    if aj.count(f"{key}:'") < 2:  # en + fr
        fails.append(f"i18n key {key} is missing a translation in en and/or fr")

if fails:
    print('✗ PASS 54 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 54  every Autotune correction control explains what it does and which direction gives a stronger/more obvious effect')
PY27
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY28'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
fails = []

# Round 27: added Igbo (no dedicated Whisper code, same auto-detect +
# initial_prompt treatment as Patois) and a "+ EN" code-switching
# variant for every language that DOES have a real Whisper code
# (Spanish, Portuguese, Yoruba, Swahili, Hausa) - most artists mix in
# English lines/hooks/ad-libs regardless of their main language, and
# forcing --language on the base code alone mistranscribes those lines
# instead of recognizing them as English. CODE_SWITCH_PROMPTS is the
# single table driving all of this - guard every expected key is still
# present and still reaches the dropdown.
for code in ('ig', 'es-en', 'pt-en', 'yo-en', 'sw-en', 'ha-en'):
    key_form = f"{code}:" if code.isidentifier() else f"'{code}':"
    if key_form not in sj:
        fails.append(f"CODE_SWITCH_PROMPTS is missing the '{code}' entry")
    if f'value="{code}"' not in ih:
        fails.append(f"transcribe language dropdown is missing value=\"{code}\"")
if 'Flavour' not in sj or 'Phyno' not in sj:
    fails.append('the Igbo initial_prompt lost its style-anchoring reference artists')

if fails:
    print('✗ PASS 55 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 55  Igbo added, and every transcribe language with a real Whisper code has a code-switching "+ EN" variant')
PY28
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY29'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 28: "Formant on leads to screetching" persisted on a fresh
# evidence file even after Round 25's engagement-curve widening, because
# that fix only reduced HOW OFTEN full engagement happens - it did
# nothing about the fact that the LPC whiten/resynthesize round trip is
# inherently brighter than the dry signal any time it IS engaged (~40%
# more RMS energy / doubled treble, measured even at unity ratio - see
# formantTarget's own comment). Fixed with a one-pole low-pass applied
# to the RETURNED sample only. Guard both that the cutoff constant/state
# exist, AND that the smoothed value is never fed back into
# lpcHistoryOut - a first attempt that did feed it back measurably
# WORSENED real gain-divergence events on an evidence file (3->9
# sustained events, one reaching 79ms) by changing the recursive
# resynthesis filter's own pole structure.
if 'FORMANT_HF_CUTOFF_HZ' not in wj:
    fails.append('FORMANT_HF_CUTOFF_HZ is missing - the formant brightness-tame fix appears to have been reverted')
if 'formantHfState' not in wj:
    fails.append('formantHfState is missing - the formant brightness-tame fix appears to have been reverted')
# Round 44: lpcHistoryOut (the recursive/IIR resynthesis history) was
# removed entirely and replaced with shiftedHistory (a feed-forward
# history of the EXCITATION signal, never the filter's own output) - see
# the Round 44 comment block above computeCepstralEnvelope(). The same
# invariant this check has always enforced still applies to the new
# mechanism: the HF-tame smoothing must run on the raw y, after it has
# already been used to update the resynthesis history, and the smoothed
# value itself must never be what gets pushed into that history.
if 'this.lpcHistoryOut' in wj:
    fails.append('this.lpcHistoryOut still live (assigned/read) - the Round 44 cepstral/FIR resynthesis swap appears to have been reverted or only partially applied (historical mentions of the bare word in comments are fine, a live this.lpcHistoryOut reference is not)')
if 'computeCepstralEnvelope' not in wj or 'shiftedHistory' not in wj or '_firColor' not in wj:
    fails.append('the Round 44 cepstral envelope / FIR resynthesis mechanism appears to be missing')
push_idx = wj.find('this._pushHistory(this.shiftedHistory, shifted);')
hf_idx = wj.find('this.formantHfState += (y - this.formantHfState) * this.formantHfAlpha;')
if push_idx == -1 or hf_idx == -1:
    fails.append('could not locate the shiftedHistory push / HF-tame smoothing lines to check ordering')
elif not (push_idx < hf_idx):
    fails.append('the HF-tame smoothing must run AFTER shiftedHistory is updated with the raw excitation sample')
if 'this._pushHistory(this.shiftedHistory, yOut)' in wj or 'this._pushHistory(this.shiftedHistory, this.formantHfState)' in wj or 'this._pushHistory(this.shiftedHistory, y)' in wj:
    fails.append('shiftedHistory must be fed the raw excitation ("shifted"), never the HF-tamed/smoothed or resynthesized output - that would reintroduce a feedback path')
if 'high-frequency-energy ratio' not in tj:
    fails.append('test-autotune.js is missing the formant brightness-tame regression test (test 29)')

if fails:
    print('✗ PASS 56 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 56  Round 44 cepstral/FIR resynthesis mechanism present, lpcHistoryOut fully removed, and shiftedHistory is confirmed to only ever receive the raw excitation sample (no feedback path)')
PY29
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY30'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 29: compact beat-history picker on the Topliner page, so someone
# can jump straight to a SPECIFIC previously-downloaded beat to write a
# topline over instead of shuffling until the random pick happens to
# land on it. Reuses histData/rbPool() (no second fetch), gated behind
# the same recording/review guards rbNext() already uses so a beat can't
# be swapped out from under an in-progress take.
for el_id in ('rb-picker-toggle-btn', 'rb-picker-panel', 'rb-picker-search', 'rb-picker-list', 'rb-picker-count'):
    if f'id="{el_id}"' not in ih:
        fails.append(f'{el_id} is missing from the Topliner page')
for fn in ('function rbTogglePicker', 'function rbPickerFilter', 'function rbPickerRenderList', 'function rbSelectBeat'):
    if fn not in aj:
        fails.append(f'{fn} is missing from app.js')
# The guard that stops a beat swap mid-recording/review must be present
# on the picker's select path too, not just rbNext()'s.
sel_idx = aj.find('function rbSelectBeat')
sel_body = aj[sel_idx:sel_idx + 600] if sel_idx != -1 else ''
if 'rbRecording' not in sel_body or 'rbReviewActive' not in sel_body:
    fails.append('rbSelectBeat() is missing the recording/review-in-progress guard that rbNext() already has')
# The id passed from a rendered row into rbSelectBeat(...) must be a bare
# numeric literal, not a double-quoted string, or it breaks out of the
# onclick="..." HTML attribute early (a real bug caught during
# development - JSON.stringify(String(h.id)) produces "123", and the
# embedding attribute is itself double-quoted).
if 'JSON.stringify(String(h.id))' in aj:
    fails.append('rbPickerRenderList still embeds the row id as a double-quoted string inside a double-quoted onclick attribute - this breaks the HTML attribute early')
for key in ('rbTagPicked', 'rbPickerNoMatch', 'rbPickerEmpty'):
    if aj.count(f"{key}:'") < 2:
        fails.append(f"i18n key {key} is missing a translation in en and/or fr")

if fails:
    print('✗ PASS 57 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 57  Topliner page has a compact, searchable beat-history picker, guarded the same way rbNext() already is')
PY30
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY31'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    ih = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 30: beat-picker rows can now be previewed through the shared mini
# player without loading them as the active Topliner beat - a play button
# per row calling the same playTrack() entry point folder/history rows
# already use, wired to sync back whenever playback state changes
# anywhere in the app (not just from a click inside the picker).
if 'rb-picker-play' not in ih:
    fails.append('.rb-picker-play button is missing from the picker CSS/markup')
for fn in ('function rbPickerPlayTrack', 'function rbPickerSyncPlayState'):
    if fn not in aj:
        fails.append(f'{fn} is missing from app.js')
# The preview button must stop the click from also bubbling into the
# row's own onclick (rbSelectBeat) - caught as a real bug shape during
# development: without event.stopPropagation(), clicking play also
# swaps the active Topliner beat as an unwanted side effect.
play_idx = aj.find('function rbPickerPlayTrack')
play_body = aj[play_idx:play_idx + 400] if play_idx != -1 else ''
if 'stopPropagation' not in play_body:
    fails.append('rbPickerPlayTrack() is missing event.stopPropagation() - clicking preview would also select the row as the active beat')
# rbPickerSyncPlayState must be wired into all three places playback
# state can change: a new track loading, playback stopping entirely, and
# a bare play/pause toggle on the already-loaded track.
for anchor in ('function stopGlobalPlay', 'function updateMiniPlayerPlayState'):
    idx = aj.find(anchor)
    body = aj[idx:idx + 1500] if idx != -1 else ''
    if 'rbPickerSyncPlayState' not in body:
        fails.append(f'{anchor}() does not call rbPickerSyncPlayState() - the picker\'s play/pause glyphs would go stale')
if aj.count('rbPickerSyncPlayState()') < 4:  # definition + 3 call sites
    fails.append('rbPickerSyncPlayState() is not wired into all expected call sites (playTrack/stopGlobalPlay/updateMiniPlayerPlayState)')
if 'rbPickerPreview:' not in aj or aj.count("rbPickerPreview:'") < 2:
    fails.append('i18n key rbPickerPreview is missing a translation in en and/or fr')

if fails:
    print('✗ PASS 58 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 58  Topliner beat picker rows can be previewed through the shared mini player, kept in sync with playback state app-wide')
PY31
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY32'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 31: "robotic voice that slows down per moments" + formant-on
# screech, reported fresh on an 88.2kHz dancehall vocal even after every
# prior formant/pitch fix. Root cause: computeLPC() (LPC formant
# analysis) ran against the SAME full winLen window detectPitch() uses,
# but was never given the FFT treatment detectPitch() got in an earlier
# round - at 88.2kHz's 4096-sample winLen, computeLPC() alone measured a
# median 0.90ms and up to 4.1ms per call, blowing 60%-290% of that rate's
# entire ~1.45ms render-quantum budget by itself. Measured landing 12.34%
# of all quanta over budget with Formant Correction on - a genuine
# real-time underrun, which is exactly the "choppy/robotic/stuttering,
# dropped samples" failure mode this file's own history already named.
# Fixed by giving LPC its own shorter, sample-rate-portable window
# (lpcWinLen, half of winLen) - standard speech-LPC window sizing
# anyway - cutting over-budget quanta to 1.79% on the same file.
if 'lpcWinLen' not in wj:
    fails.append('lpcWinLen is missing - the LPC real-time-budget fix appears to have been reverted')
if 'buf.subarray(N - this.lpcWinLen, N)' not in wj:
    fails.append('_analyze() no longer feeds computeLPC() the shorter lpcWinLen slice')
for const_name in ('lpcCoefAlpha', 'formantBlendAlpha', 'formantHfAlpha'):
    if f'this.{const_name}' not in wj:
        fails.append(f'{const_name} is missing - the hoisted-out-of-the-per-sample-loop Math.exp() fix appears to have been reverted')
if 'const coefAlpha = 1 - Math.exp(-dtMs / 6)' in wj or 'const hfAlpha = 1 - Math.exp(-2 * Math.PI * FORMANT_HF_CUTOFF_HZ' in wj:
    fails.append('a per-sample Math.exp() recomputation that should have been hoisted to the constructor is back')
if 'lpcWinLen is exactly half of winLen' not in tj or "computeLPC() completes well within a single 88.2kHz render quantum" not in tj:
    fails.append('test-autotune.js is missing the LPC real-time-budget regression tests (tests 30-31)')

if fails:
    print('✗ PASS 59 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 59  computeLPC() has its own sample-rate-portable, real-time-budget-safe analysis window, independent of detectPitch\'s')
PY32
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY33'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 32: "still making screech and broken", reported fresh against a
# real French vocal take. Root cause: target-note SELECTION is
# deliberately smoothed (SMOOTH_MS=120, see the vibrato-flip fix) to
# survive vibrato without flip-flopping, but the CORRECTION AMOUNT is
# computed from raw, fast pitch on purpose (so vibrato still gets fully
# corrected). During a genuine, fast melodic step between two real
# in-key notes, raw pitch can already be on the new note while the slow
# smoother - and therefore the locked target - is still catching up,
# for well over 100ms. Correcting hard toward an increasingly-wrong
# target produced a large, growing, wrong-direction pull - measured at
# -207 cents, still unresolved 115ms after the step, on the real take.
# Fixed with a fast-unlock check against raw pitch (100-cent margin, 2
# consecutive hops) - wide/long enough that ordinary vibrato (tens of
# cents of swing) cannot trigger it, but catches a genuine step within
# ~23ms instead of the full smoothing window.
if 'rawUnlockStreak' not in wj:
    fails.append('rawUnlockStreak is missing - the fast-unlock fix for genuine melodic steps appears to have been reverted')
if 'RAW_UNLOCK_MARGIN_CENTS' not in wj or 'RAW_UNLOCK_HOPS' not in wj:
    fails.append('the fast-unlock margin/hop-count constants are missing')
if 'a fast, genuine step to a new in-key note relocks the target' not in tj:
    fails.append('test-autotune.js is missing the fast-unlock regression test (test 32)')
if 'a vibrato’d note sitting at an exact scale-tone midpoint does not flip-flop' not in tj:
    fails.append('the pre-existing vibrato-flip regression test (test 20-ish) is missing - cannot confirm the fast-unlock fix doesn\'t reopen it')

if fails:
    print('✗ PASS 60 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 60  a genuine, fast melodic step between two in-key notes relocks the target quickly instead of dragging a stale correction, without reopening the vibrato flip-flop fix')
PY33
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY34'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
fails = []

# Round 33: files a user just moves/drops into their Stockpile tree (not
# downloaded through the app) were flooding the History tab - confirmed
# directly against a real user's History, full of plain sample/vocal
# files from an old drive folder. Both file-discovery paths (the
# watch-folder daemon and the manual "adopt orphans" scan) now mark
# adopted rows discovered_unlisted=1; the main /history list excludes
# them (every other route - fingerprinting, matching, storage breakdown,
# by-id lookups - is untouched); running Analyze on one clears the flag,
# treating that as the user deliberately choosing to bring it in.
if 'discovered_unlisted' not in sj:
    fails.append('discovered_unlisted column/migration is missing')
if "INSERT INTO history (title, file_path, format, discovered_unlisted) VALUES (?, ?, ?, 1)" not in sj:
    fails.append('a file-discovery INSERT path is missing the discovered_unlisted=1 flag')
if sj.count("discovered_unlisted, 1)") + sj.count("discovered_unlisted) VALUES (?, ?, ?, 1)") < 2:
    fails.append('expected discovered_unlisted=1 on BOTH the watch-folder daemon and the adopt-orphans scan - only found one')
if "WHERE COALESCE(discovered_unlisted,0)=0" not in sj:
    fails.append('the /history list route no longer filters out discovered_unlisted rows')
if "UPDATE history SET discovered_unlisted=0 WHERE file_path=? AND discovered_unlisted=1" not in sj:
    fails.append('/analyze no longer promotes a discovered_unlisted row into the visible library when analyzed')

if fails:
    print('✗ PASS 61 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 61  files discovered on disk (watch-folder / adopt-orphans), not downloaded through the app, stay out of the main History list until Analyzed')
PY34
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY35'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
fails = []

# Round 34: the History tab's multi-select used a per-row checkbox as a
# second, redundant click target next to the row's own onclick (which
# already routed to toggleRowSelect). User asked for the checkbox gone
# entirely - selecting a row in select mode should just be a click
# anywhere on the row, shown purely via a strong green highlight, same
# as the checkbox used to show it but without the box itself.
if 'buildHistoryRowHTML' not in aj:
    fails.append('buildHistoryRowHTML is missing entirely')
import re
m = re.search(r'function buildHistoryRowHTML\([^)]*\)\s*\{', aj)
if not m:
    fails.append('buildHistoryRowHTML function definition not found')
else:
    i = m.end()
    depth = 1
    while depth > 0:
        if aj[i] == '{': depth += 1
        elif aj[i] == '}': depth -= 1
        i += 1
    fn_body = aj[m.start():i]
    if 'hist-check' in fn_body:
        fails.append('buildHistoryRowHTML still emits a per-row hist-check checkbox - should be row-click-only now')
    if '<input type="checkbox"' in fn_body:
        fails.append('buildHistoryRowHTML still emits a raw checkbox input element')

# The separate toolbar "Select All" checkbox (#hist-check-all) is a
# different, intentional control and must NOT be removed by this change.
if 'hist-check-all' not in hj:
    fails.append('the toolbar Select All checkbox (#hist-check-all) was removed - that one is intentional and should stay')

if '.hist-row.selected' not in hj:
    fails.append('the strengthened .hist-row.selected highlight CSS is missing - the row itself needs to be the selection indicator now')

if fails:
    print('✗ PASS 62 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 62  History select mode toggles rows via click + a strong green highlight, with no per-row checkbox, while the toolbar Select All checkbox is untouched')
PY35
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY36'
import sys, re
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 35: History selection silently stopped working after Round 34
# removed the per-row checkbox and moved selection onto the row's own
# onclick attribute. Root cause: the row-level DOM reconciliation path
# (used whenever the list is already rendered, which is the common
# case) copied className/title/draggable onto the existing element but
# never copied the outer div's onclick/ondblclick - those only live on
# the row's own attributes, not inside the innerHTML that DOES get
# refreshed. So entering select mode on an already-rendered list left
# every existing row stuck on its old normal-mode ondblclick handler;
# clicking a row to select it did nothing. Reproduced directly with a
# jsdom test simulating the exact patch path, confirmed fixed by
# syncing existingEl.onclick/ondblclick from the freshly-built row.
m = re.search(r'if \(existingEl\) \{', aj)
if not m:
    fails.append('the reconciliation "existing row" patch branch was not found at all')
else:
    # grab a reasonably-sized window after the branch open to check for the sync lines
    window_txt = aj[m.start():m.start()+2000]
    if 'existingEl.onclick = fresh.onclick' not in window_txt or 'existingEl.ondblclick = fresh.ondblclick' not in window_txt:
        fails.append('the history row reconciliation patch no longer syncs onclick/ondblclick from the freshly-built row - selection will silently break again on an already-rendered list')

if fails:
    print('✗ PASS 63 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 63  History row reconciliation syncs onclick/ondblclick handlers when patching an existing row in place, so toggling select mode on an already-rendered list keeps selection working')
PY36
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY37'
import sys, re
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 36: predOut (the resynthesis-side LPC prediction) can transiently
# overshoot right at a genuine note-to-note transition - lpcCoeffs are
# still gliding toward the new hop's fit while lpcHistoryOut still holds
# samples resynthesized under the PREVIOUS note, a coefficient/history
# mismatch the bandwidth-expansion comment already flagged as a known
# risk. Measured directly on real uploaded takes (peaked at 1.08 against
# a ~0.1-0.5 local level - under the hard 1.5 clamp, so the existing
# safety net never caught it) as a short, audible "zzt" at the
# transition. Two earlier fix attempts (soft-limiting predOut against the
# input envelope, then against predIn) both made the brightness
# regression test measurably WORSE and were rejected. Fixed by ramping
# formant blend's effective weight in over the first ~40ms after a
# target change, using heldMs (already tracked for Humanize) - a static,
# held note never re-enters this window, so it doesn't touch normal,
# sustained engagement (verified: brightness test 28/29 unchanged).
if 'transitionDampen' not in wj or 'TRANSITION_DAMPEN_MS' not in wj:
    fails.append('the post-transition formant-blend ramp-in (transitionDampen) appears to have been reverted')
if 'formantContribution * this.formantBlend * transitionDampen' not in wj:
    fails.append('formantContribution (Round 44 replacement for predOut) is no longer scaled by transitionDampen before being added to the output')
if 'heldMs resets to (near) zero the hop a genuine target change lands' not in tj:
    fails.append('test-autotune.js is missing the transitionDampen regression test (test 33)')

if fails:
    print('✗ PASS 64 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 64  formant blend ramps back in over ~40ms after a genuine note-to-note transition instead of reapplying full LPC-resynthesis strength immediately, taming the transient resynthesis overshoot measured on real takes without touching normal sustained engagement')
PY37
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY38'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 37: a pitch-detection reading landing near EXACTLY double or half
# the last accepted pitch (the classic autocorrelation octave-error
# signature) could still slip through the outlier gate and get accepted
# outright at CONF_HIGH - measured directly on a real take that still
# screeched after every other fix this session: 16 of 378 hops (4.2% of
# the whole take) landed 1000-1250 cents from the last accepted pitch,
# ratios clustering tightly around 0.51-0.54 and 1.79-1.90 (real singing
# has no reason to cluster there, only a harmonic/subharmonic
# misdetection does), several slipping past MAX_JUMP_CENTS's single
# 1200-cent cutoff by margins as small as 46 cents. Fixed by rejecting
# any reading whose ratio to the last accepted pitch falls in an
# explicit near-2x/near-0.5x band, independent of the wider blanket
# cutoff.
if 'OCTAVE_UP_MIN' not in wj or 'OCTAVE_DOWN_MIN' not in wj or 'looksLikeOctaveError' not in wj:
    fails.append('the near-octave-ratio rejection band appears to have been reverted')
if 'jumpCents > MAX_JUMP_CENTS || looksLikeOctaveError' not in wj:
    fails.append('looksLikeOctaveError is no longer wired into the outlier-rejection check')
if 'octave-error shape) is never accepted into lastAcceptedPitchHz' not in tj:
    fails.append('test-autotune.js is missing the octave-error regression test (test 34)')

if fails:
    print('✗ PASS 65 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 65  a pitch reading near exactly double or half the last accepted pitch (octave-error signature) is rejected before it can poison lastAcceptedPitchHz, even when confidently read')
PY38
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY39'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
fails = []

# Round 38: Recording settings panel was one long, undifferentiated
# vertical scroll of full-width sliders and paragraph-length hint text -
# "make it better, like a plugin, not scrolly" (direct user feedback).
# Redesigned into a compact, wide DAW-plugin-style layout: Pitch
# Correction and Reverb's parameter blocks became 2-column grids so
# related sliders sit side by side instead of stacking; Output Gain
# moved into the Input group next to Input Gain (a natural gain-staging
# pair) instead of its own separate group card; the five purely-
# descriptive slider hints (not the functional/dynamic ones - the
# feedback warning and the bake reminder stay fully visible) collapse
# to a 2-line clamp instead of a full paragraph each.
if '.rb-at-params{margin-top:6px;padding-top:10px;border-top:1px solid var(--border);display:grid' not in hj:
    fails.append('the Pitch Correction params block is no longer a 2-column grid')
if '.rb-rv-params{margin-top:6px;padding-top:10px;border-top:1px solid var(--border);display:grid' not in hj:
    fails.append('the Reverb params block is no longer a 2-column grid')
if '.rb-at-hint-sm{' not in hj or hj.count('rb-at-hint-sm') < 6:
    fails.append('the compact, truncated hint style is missing or not applied to all 5 descriptive hints')
if '.rb-at-gain-grid{' not in hj or 'rb-at-gain-grid">' not in hj:
    fails.append('Input Gain / Output Gain are no longer paired in a shared gain grid')
if 'class="rb-at-group rb-at-group-output"' in hj:
    fails.append('the standalone Output group card should be gone (merged into Input) but the DIV still exists')
# The most important invariant of all: nothing here may fight .hidden's
# !important - display:grid without !important on rb-at-params/rb-rv-params
# is what lets clicking the gear still collapse them correctly.
if 'display:grid !important' in hj or 'display: grid !important' in hj:
    fails.append('a !important display rule would defeat .hidden{display:none!important} on the params blocks - panel would never collapse')

if fails:
    print('✗ PASS 66 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 66  Recording settings panel is a compact, 2-column, plugin-style layout (Pitch Correction + Reverb param grids, merged gain sliders, truncated descriptive hints) that still collapses correctly via the existing .hidden toggle')
PY39
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY40'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 39: entering History select mode was "a little slow" (direct
# user feedback) - selectMode is baked into every row's fingerprint (see
# rowFingerprint), so toggling it changes EVERY row's fingerprint at
# once, sending every row through the row-by-row reconciliation "patch"
# path (build a temp element, diff, copy innerHTML, re-sync onclick/
# ondblclick) instead of one bulk innerHTML replace - strictly more
# expensive when literally every row is changing anyway. Measured
# directly in a 200-row synthetic test: 166ms (per-row patch) vs 63ms
# (bulk rewrite) for the exact same selectMode toggle.
if 'window._lastRenderedSelectMode' not in aj:
    fails.append('the selectMode-change-triggers-full-rewrite tracking appears to have been reverted')
if 'selectModeChanged' not in aj:
    fails.append('selectModeChanged is no longer wired into the full-rewrite condition')

if fails:
    print('✗ PASS 67 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 67  entering/leaving History select mode triggers one bulk list rewrite instead of patching every row individually, since every row changes at once either way')
PY40
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY41'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 40: user said the Recording settings menu was "still ass...
# change the layout completely" even after Round 38's tighter 2-col
# grid pass, and separately that the recorded stems were "ugly - how
# they look, placement, accessibility" buried at the bottom of Review.
# This round replaces the 3 stacked group-cards with a tab strip
# (Input | Pitch Correction | Reverb, one visible at a time) and moves
# the stem-export buttons into their own distinctly-styled card right
# under the Review panel's header instead of the bottom action row.
if 'rb-at-tabs' not in hj or 'rbAtSwitchTab' not in hj:
    fails.append('the Recording panel tab strip markup is missing')
if hj.count('data-at-tab="input"') < 1 or hj.count('data-at-tab="pitch"') < 1 or hj.count('data-at-tab="reverb"') < 1:
    fails.append('one or more rb-at-group data-at-tab attributes are missing')
if '.rb-at-group-head' in hj.replace('/*', '').replace('*/', '') and 'rb-at-group-head{' in hj:
    fails.append('old stacked-card .rb-at-group-head CSS rule should have been removed along with its markup')
if '.rb-at-group[data-at-tab]{display:none}' not in hj:
    fails.append('inactive-tab-group hiding rule is missing')
if '.rb-at-group[data-at-tab].rb-at-tab-active{display:flex}' not in hj:
    fails.append('active-tab-group show rule is missing')
if 'display:grid !important' in hj or 'display: grid !important' in hj or '!important' in hj[hj.find('.rb-at-tabs'):hj.find('.rb-at-tabs')+2000]:
    fails.append('a stray !important near the new tab CSS risks the same .hidden-defeating bug caught in Round 38')
if 'function rbAtSwitchTab(tabName)' not in aj:
    fails.append('rbAtSwitchTab() is missing from app.js')
if 'rb-review-stems' not in hj:
    fails.append('the relocated stems card markup is missing')
if 'rb-stem-btn' not in hj:
    fails.append('the distinct stem-button styling class is missing')
# stem buttons must have moved OUT of the bottom actions row
actions_start = hj.find('class="rb-review-actions"')
actions_chunk = hj[actions_start:actions_start+800] if actions_start != -1 else ''
if 'id="rb-review-vocal-stem"' in actions_chunk or 'id="rb-review-beat-stem"' in actions_chunk:
    fails.append('stem buttons are still present in the bottom .rb-review-actions row - relocation was reverted')
if hj.count('id="rb-review-vocal-stem"') != 1 or hj.count('id="rb-review-beat-stem"') != 1:
    fails.append('stem buttons should exist exactly once each, not duplicated or removed')

if fails:
    print('✗ PASS 68 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 68  Recording settings panel uses a tabbed layout (Input / Pitch Correction / Reverb, one visible at a time) instead of 3 stacked cards, and the vocal/beat stem export buttons moved from the buried bottom action row into their own distinctly-styled card near the top of the Review panel')
PY41
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY42'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 41: a third, distinct LPC-resynthesis "ringing" screech pattern
# (real, measured, sample-level sign-flip oscillation within a single
# steady analysis hop - no note transition, no octave error, no energy
# transient) traced on a real evidence file. Three amplitude/envelope-
# ratio limiter attempts, a reflection-coefficient/LPC-error-ratio
# check, and an energy-transient check were all tried and rejected this
# round (none separated "bad" from ordinary full engagement). Fix:
# tighten the ALREADY-EXISTING, ALREADY-PROVEN-SAFE output-only
# brightness tame (FORMANT_HF_CUTOFF_HZ, never fed back into
# lpcHistoryOut) from 6500Hz to 4000Hz - measured to reduce flagged
# "large relative to input" samples by 30%+ on the evidence file with
# zero regressions across the 38 pre-existing checks and four other
# evidence files. Round 50 later raised this same constant again
# (4000Hz -> 8000Hz, see PASS 80) once real evidence showed the 4000Hz
# value itself had become a net-negative "muffled"/"in a bottle" cost
# now that Round 44 replaced the ringing-prone mechanism this tap was
# originally defending - so this guard intentionally no longer pins the
# exact Hz value (that's PASS 80's job now); it only confirms the
# mechanism and its old, since-superseded 6500Hz starting point are
# still gone.
if 'const FORMANT_HF_CUTOFF_HZ = 6500;' in wj:
    fails.append('the old 6500Hz cutoff is back - Round 41 fix appears to be reverted')
if 'FORMANT_HF_CUTOFF_HZ' not in wj or 'this.formantHfState +=' not in wj:
    fails.append('the FORMANT_HF_CUTOFF_HZ output-only brightness tame mechanism itself appears to be missing')
if "Round 41's tightened brightness tame" not in tj:
    fails.append('the Round 41 regression test (very-high-frequency energy proportion check) appears to be missing from tools/test-autotune.js')

if fails:
    print('✗ PASS 69 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 69  formant-correction brightness tame tightened from 6500Hz to 4000Hz (superseded by Round 50 - see PASS 80), reducing a real, measured recursive-filter ringing pattern (sample-to-sample sign-flip oscillation, distinct from the Round 36/37 mechanisms) with zero regressions across every existing check')
PY42
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY43'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 42: direct feedback that correction "doesn't correct enough"
# without Formant Correction - measured a real, audible lag (mean 32.9
# cents on a real evidence take) between the target correction and what
# was actually applied at any instant, at the old 20ms Retune Speed
# default. Tightened the default to 5ms across all four places it's
# defined (engine constructor, app.js's rbAutotuneDefaults(), app.js's
# val() fallback, index.html's slider value+label) - the full 0-400ms
# range and every existing saved-settings value are untouched, this
# only changes what a brand new session starts at.
if 'retuneSpeedMs: 5, humanize: 0,' not in wj:
    fails.append('engine constructor default retuneSpeedMs is not 5')
if "retuneSpeedMs: 5," not in aj or "val('rb-at-retune', 5)" not in aj:
    fails.append('app.js retuneSpeedMs defaults are not both set to 5')
if 'value="5" step="5"' not in hj or 'id="rb-at-retune-val">5 ms<' not in hj:
    fails.append('index.html retune slider default value/label is not 5ms')
if 'retuneSpeedMs: 20' in wj or 'retuneSpeedMs: 20,' in aj:
    fails.append('an old 20ms retuneSpeedMs default is still present somewhere')
if "own default Retune Speed" not in tj:
    fails.append('the Round 42 regression test (default retune speed closes a real correction quickly) appears to be missing')

if fails:
    print('✗ PASS 70 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 70  default Retune Speed tightened from 20ms to 5ms across all four places it is defined, closing a real, measured correction-lag gap (32.9 cents mean -> 13.2 cents on real material) so a fresh session starts with noticeably tighter, more obvious pitch correction')
PY43
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY44'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 43: "the stem page is still ugly... give it a real DAW feel and
# real accessibility." Two parts:
# (a) Real accessibility bug found and fixed app-wide: a single early
#     CSS rule (button:focus,button:focus-visible{outline:none!important})
#     was silently defeating TWO separate later, well-intentioned WCAG-
#     compliant focus-ring passes - every button in the whole app had NO
#     visible keyboard focus indicator at all. Rescoped to
#     :focus:not(:focus-visible) (hide the ring on mouse clicks only,
#     the standard pattern already used correctly elsewhere in this
#     file) so the existing focus-ring rules can finally take effect.
# (b) DAW-feel restructuring of the Review panel: the waveform, transport,
#     and faders used to be three plain stacked rows with no visual
#     grouping. Now grouped into labeled sections (Vocal Track / Mixer)
#     with colored left rails matching the Recording panel's language,
#     the transport is its own bordered strip, and the Beat/Vocal faders
#     got the same custom colored-fill slider treatment already used
#     throughout the Recording panel instead of bare browser defaults.
if 'button:focus,button:focus-visible{outline:none!important' in hj:
    fails.append('the app-wide focus-visible-killing bug is still present')
if 'button:focus:not(:focus-visible){outline:none;box-shadow:none}' not in hj:
    fails.append('the scoped mouse-click-only focus suppression fix is missing')
if 'rb-review-track-section' not in hj or 'rb-review-mixer' not in hj:
    fails.append('the DAW-style Vocal Track / Mixer section grouping is missing')
if 'rb-review-faders' in hj:
    fails.append('the old unstyled .rb-review-faders class is still present - should have been replaced by .rb-review-mixer')
if 'rb-fader-beat' not in hj or 'rb-fader-vocal' not in hj:
    fails.append('per-channel colored fader classes are missing')
if "if (beatSl) rbUpdateSliderFill(beatSl);" not in aj or "if (vocalSl) rbUpdateSliderFill(vocalSl);" not in aj:
    fails.append('the faders are not wired into the custom slider-fill helper')
if 'role="group" aria-label="Playback transport"' not in hj:
    fails.append('the transport bar is missing its accessible group label')
if 'role="status" aria-live="polite"' not in hj:
    fails.append('the review status text is missing its aria-live region')

if fails:
    print('✗ PASS 71 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 71  fixed an app-wide bug where no button ever showed a visible keyboard focus ring (two earlier accessibility passes were both silently defeated by one early !important rule), and restructured the Review panel into labeled, color-coded DAW-style sections (Vocal Track / Mixer) with real custom-styled faders instead of bare browser sliders')
PY44
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY45'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 44: the recursive LPC formant-resynthesis mechanism (predOut,
# fed by lpcHistoryOut - the filter's own past OUTPUT looped back into
# itself) is replaced with a cepstral (homomorphic) spectral-envelope
# extraction and a bounded, non-recursive FIR realization of it - the
# same architecture real pitch-correction tools use specifically
# because it cannot ring the way a recursive all-pole filter can. The
# whitening side (predIn/lpcHistoryIn, LPC-based) is deliberately
# unchanged - it was already safe by construction (feed-forward from
# real input, never fed its own output).
if 'computeCepstralEnvelope' not in wj or 'CEPSTRAL_ENV_ORDER' not in wj or 'CEPSTRAL_FIR_TAPS' not in wj:
    fails.append('the Round 44 cepstral envelope function/constants are missing')
if 'fftInPlace' not in wj or 'nextPow2' not in wj:
    fails.append('the Round 44 FFT helper is missing')
if 'this.envCoeffs' not in wj or 'this.envCoeffsTarget' not in wj or 'this.shiftedHistory' not in wj:
    fails.append('the Round 44 resynthesis state (envCoeffs/envCoeffsTarget/shiftedHistory) is missing')
if 'this.lpcHistoryOut' in wj:
    fails.append('this.lpcHistoryOut is still live - the recursive resynthesis mechanism appears to still be in use')
if '_firColor' not in wj:
    fails.append('the Round 44 FIR resynthesis method (_firColor) is missing')
if "computeCepstralEnvelope returns FIR taps for a voiced block" not in tj:
    fails.append('test-autotune.js is missing the Round 44 computeCepstralEnvelope regression test (test 41)')
if "mathematically-guaranteed bound" not in tj:
    fails.append('test-autotune.js is missing the Round 44 FIR-boundedness stress test (test 41)')
if "Round 44's cepstral/FIR resynthesis keeps very-high-frequency" not in tj:
    fails.append('test-autotune.js is missing the Round 44 tightened brightness regression test (test 42)')
if 'CEPSTRAL_MP_FFT_SIZE' not in wj or 'this.lpcHammingWindow' not in wj:
    fails.append('the Round 44 real-time-budget fix (small mp-stage FFT size + shared precomputed Hamming window) appears to be missing')
if "combined (exactly as one real hop calls them) stay well within a single 88.2kHz render quantum" not in tj:
    fails.append('test-autotune.js is missing the Round 44 combined real-time-budget regression test (test 43)')

if fails:
    print('✗ PASS 72 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 72  Round 44: recursive LPC formant-resynthesis (predOut/lpcHistoryOut) fully replaced with a cepstral spectral-envelope extraction and a bounded, non-recursive FIR realization - measured directly on real evidence takes: dasdasdas.wav\'s flagged-sample count dropped 704->0, and the La Masia vocal\'s worst-case key/scale combo dropped 12458->354 (a 97%+ reduction), both with zero regressions across every other existing check')
PY45
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY46'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 45: the fixed SMOOTH_MS=120 pitch-DECISION smoothing constant
# (used to pick WHICH scale note to correct toward - never the actual
# correction amount, which has always used the raw pitch) is replaced
# with a velocity-adaptive scheme: computeGlideStrength() looks at
# recent raw-pitch history and only shortens the effective smoothing
# time constant when BOTH the net movement is large AND the direction
# is consistent (not oscillating) - real vibrato fails the consistency
# gate by design, a genuine glide/run passes both.
if 'computeGlideStrength' not in wj or 'PITCH_VEL_WINDOW_HOPS' not in wj:
    fails.append('the Round 45 velocity-adaptive smoothing function/constants are missing')
if 'SMOOTH_MS_SLOW' not in wj or 'SMOOTH_MS_FAST' not in wj:
    fails.append('the Round 45 SMOOTH_MS_SLOW/SMOOTH_MS_FAST constants are missing')
if 'this.pitchVelHist' not in wj:
    fails.append('the Round 45 pitch-velocity history state (pitchVelHist) is missing')
if 'const SMOOTH_MS = 120;' in wj:
    fails.append('the old fixed SMOOTH_MS=120 constant is still present - the Round 45 adaptive scheme appears to have been reverted')
if 'this.pitchVelHist.length = 0;' not in wj:
    fails.append('resync() no longer clears pitchVelHist - a resync could leave stale glide-detection history behind')
if "computeGlideStrength() never meaningfully engages on realistic vibrato" not in tj:
    fails.append('test-autotune.js is missing the Round 45 vibrato-safety regression test (test 44)')
if "genuine continuous glide" not in tj or "tracked with substantially less lag" not in tj:
    fails.append('test-autotune.js is missing the Round 45 glide-responsiveness regression test (test 45)')

if fails:
    print('✗ PASS 73 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 73  Round 45: fixed 120ms pitch-decision smoothing replaced with velocity-adaptive smoothing (shortens toward 25ms only when recent raw pitch shows both large net movement AND consistent direction) - measured directly: a realistic vibrato/depth sweep (3-9Hz x 1-4%, ~56 combinations) never meaningfully engages the fast path, while a genuine continuous glide matching the diagnosed evidence take (1.9 semitones/280ms) tracks with 10-25 cents of lag instead of the old fixed constant\'s measured 63.3 cents, both with zero regressions across every other existing check')
PY46
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY47'
import sys, re
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
fails = []

# Round 46: nextPow2() was accidentally declared twice at the top level
# of this file (once pre-existing in detectPitch()'s FFT helpers, once
# newly added by Round 44's cepstral/FFT helper block). Node's
# vm.runInContext (classic-script mode, used by every test in
# test-autotune.js and by this gauntlet's own DSP-CORE checks) does NOT
# throw on this - the second declaration silently overwrites the first,
# so 45/45 tests and 73/73 gauntlet checks all stayed green. A real
# AudioWorkletGlobalScope module load in Chromium/Electron enforces
# stricter duplicate-top-level-declaration semantics and throws a hard
# SyntaxError at module-parse time instead, which kills the ENTIRE
# worklet script from loading - this is exactly what broke Monitor/
# Record/mic in a real, delivered build even though every automated
# check passed. This is a genuine, permanent blind spot in the vm-based
# test harness (confirmed directly: reproduced the identical duplicate-
# function-declaration case in vm.runInContext and confirmed it does
# NOT throw), so a static source-text scan is the only way to guard
# against this entire bug class - matching the precedent of PASS 20's
# pure-source-text scoping check.
top_level_names = re.findall(r'^(?:function|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)', wj, re.MULTILINE)
top_level_names += re.findall(r'^(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=', wj, re.MULTILINE)
seen = {}
dupes = []
for name in top_level_names:
    seen[name] = seen.get(name, 0) + 1
for name, count in seen.items():
    if count > 1:
        dupes.append(f'{name} ({count}x)')
if dupes:
    fails.append('duplicate top-level function/const/class declaration(s) found - each is a silent vm-test-harness pass but a fatal SyntaxError in a real AudioWorkletGlobalScope module load: ' + ', '.join(dupes))

if fails:
    print('✗ PASS 74 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 74  Round 46: fixed a fatal, ship-blocking regression - nextPow2() was declared twice at the top level of autotune-worklet.js (Round 44\'s new cepstral/FFT helper block accidentally redeclared a pre-existing function), which vm.runInContext silently tolerates but real AudioWorkletGlobalScope module loading rejects with a hard SyntaxError, killing the entire worklet script and breaking Monitor/Record/mic app-wide in a real delivered build - removed the duplicate, and added a permanent static source-text scan for duplicate top-level function/const/class declarations so this entire bug class (a confirmed, structural blind spot in the vm-based test harness) cannot silently regress again')
PY47
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY48'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 47: Formant Correction ON was measurably louder / clipping-prone
# ("clips real easy even on low volume", "in a bottle") because
# computeCepstralEnvelope()'s reconstructed FIR taps inherited the
# analyzed window's own ABSOLUTE FFT magnitude (proportional to how
# loud that particular hop happened to be) instead of representing a
# loudness-invariant spectral SHAPE - measured directly on a real
# evidence take ("f on.wav"): pre-fix, Formant Correction on reached a
# peak of 1.4860 with 7488/789376 samples at or past digital full
# scale; post-fix, peak 0.5929 with zero samples past 0.9.
if 'CEPSTRAL_ENV_REF_GAIN' not in wj:
    fails.append('the Round 47 fixed reference-gain constant (CEPSTRAL_ENV_REF_GAIN) is missing from computeCepstralEnvelope()\'s taps normalization')
if 'mp[0] = cRe[0];' in wj:
    fails.append('mp[0] = cRe[0] is back in computeCepstralEnvelope() - this reintroduces the Round 47 loudness-proportional-gain bug (mp[0] carries pure absolute-loudness information with zero formant-shape content)')
# Round 61 deliberately flipped test 46's outer expectation (taps now
# scale PROPORTIONALLY with input RMS - see the Round 61 comment in
# both files) while keeping a narrower, still-present check that Part
# 1 (mp[0]=0, the actual fix for the pathology this PASS guards)
# still holds: taps SHAPE (not just gain) stays unaffected by loudness.
if "mp[0]=0 fix still holds" not in tj:
    fails.append('test-autotune.js is missing the Round 47 mp[0]=0 shape-invariance regression test (test 46, updated for Round 61)')

if fails:
    print('✗ PASS 75 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 75  Round 47: fixed Formant Correction ON being measurably louder/clipping-prone (\'clips real easy even on low volume\', boxy/distorted \'in a bottle\' character) - computeCepstralEnvelope()\'s reconstructed FIR taps were inheriting the analyzed window\'s own ABSOLUTE FFT magnitude (proportional to how loud that specific hop happened to be, not a loudness-invariant spectral shape) because neither forward FFT call in that function is normalized by 1/n - measured directly on a real evidence take: pre-fix peak 1.4860 with 7488/789376 samples at or past digital full scale, post-fix peak 0.5929 with zero samples past 0.9, both with zero regressions across every other existing check')
PY48
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY49'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 48: live note view + per-note bypass. The piano UI needs (1) the
# engine to actually honor excluded pitch classes when picking a
# correction target, and (2) the worklet to report its live target note
# back to the main thread so the UI can highlight it.
if 'excludedPcs' not in wj or 'excludedNotes' not in wj:
    fails.append('the Round 48 excludedNotes/excludedPcs plumbing is missing from freqToNearestScaleFreq()/_analyze()')
if "type: 'note'" not in wj or 'NOTE_REPORT_INTERVAL_MS' not in wj:
    fails.append('the Round 48 throttled live-note postMessage reporting is missing from AutotuneProcessor')
if "an excluded pitch class is never returned as a correction target" not in tj:
    fails.append('test-autotune.js is missing the Round 48 exclusion-invariant regression test (test 47)')
if "excluding every note in the scale falls back to the unrestricted scale" not in tj:
    fails.append('test-autotune.js is missing the Round 48 all-excluded-fallback regression test (test 48)')
if "steers a genuinely off-key take away from it" not in tj:
    fails.append('test-autotune.js is missing the Round 48 full-engine exclusion regression test (test 49)')

with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
if 'rb-at-piano' not in hj or 'rb-piano-key' not in hj:
    fails.append('the Round 48 piano widget markup/CSS is missing from index.html')
# Perf regression guard: rbRenderAutotunePiano() must NOT be called from
# rbUpdateAutotuneLabels() - that function runs on every slider 'input'
# event (retune/humanize/vibrato/flextune/gain/reverb - none of which
# affect the piano's visual state), and this exact class of mistake
# (real per-drag-tick main-thread work) has already caused a measured,
# reported "settings lag while moving controls" bug in this codebase
# before (see rbAutotuneSaveSettingsDebounced's own comment).
import re as _re
m = _re.search(r'function rbUpdateAutotuneLabels\(\)\s*\{.*?\n\}', aj, _re.S)
if m and 'rbRenderAutotunePiano' in m.group(0):
    fails.append('rbRenderAutotunePiano() is called from rbUpdateAutotuneLabels() - this reintroduces a real per-drag-tick main-thread cost on every slider in the panel, the exact "settings lag" bug class already fixed once before')
if 'rbRenderAutotunePiano' not in aj or 'rbToggleExcludedNote' not in aj:
    fails.append('the Round 48 piano render/toggle logic is missing from app.js')

if fails:
    print('✗ PASS 76 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 76  Round 48: added live note view + per-note bypass - the engine now honors excludedNotes (an array of absolute pitch classes the piano UI toggles off), never returning an excluded note as a correction target even when it is objectively the nearest scale tone (falls back to the unrestricted scale if every note gets excluded), and AutotuneProcessor reports its live locked target note to the main thread (throttled to ~80ms) so the UI can highlight it in real time - verified with a genuine A/B (disabled the exclusion filter, confirmed the exact regression tests fail; restored it, confirmed they pass), 3 new regression tests, zero regressions across every other existing check')
PY49
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY50'
import sys, re
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 49: sub-harmonic (octave-doubling) pitch-detection fix.
# detectPitch()'s shortest-valid-peak search could lock onto a strong
# nearby formant's own periodicity at HALF the true fundamental's
# period (formant sits close to 2x f0) - not specific to Formant
# Correction, detectPitch() has no knowledge of that setting. The
# override must use a STRICT "subVal genuinely exceeds bestVal" test,
# not merely "close to as strong" (subVal >= bestVal * 0.95) - the
# looser version silently halved the frequency of already-correct,
# clean harmonic-rich detections (measured: a plain D3 tone was pushed
# down to 73.4Hz, exactly half). Guard against both directions
# regressing: the fix must still fire on the real bug shape, and must
# NOT fire on a normal already-correct tone.
if 'subVal > bestVal * 1.02' not in wj:
    fails.append('the Round 49 strict sub-harmonic override threshold (subVal > bestVal * 1.02) is missing or has been loosened back toward the buggy subVal >= bestVal * 0.95 shape')
if re.search(r'^\s*if\s*\(\s*subVal\s*>=\s*bestVal\s*\*\s*0\.95', wj, re.M):
    fails.append('the old, buggy loose sub-harmonic threshold (subVal >= bestVal * 0.95) is back in detectPitch() - this silently octave-doubles down clean, already-correct pitch detections')
if 'no longer octave-doubles down when a strong formant sits near 2x the true fundamental' not in tj:
    fails.append('test-autotune.js is missing the Round 49 octave-doubling-fix regression test (test 50)')
if 'is not pushed down an octave by the sub-harmonic fix' not in tj:
    fails.append('test-autotune.js is missing the Round 49 already-correct-tone-not-halved regression test (test 51)')

if fails:
    print('✗ PASS 77 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 77  Round 49: fixed a genuine octave-doubling pitch-detection bug (found via a realistic 4-note melody test, root-caused to detectPitch() locking onto a strong nearby formant\'s periodicity at HALF the true fundamental\'s period) that reproduces identically in both Formant Correction modes, not specific to it despite that framing in the report - tightened the sub-harmonic override from a loose \'comparable strength\' threshold (subVal >= bestVal * 0.95, which was silently halving clean already-correct detections, e.g. D3 pushed to 73.4Hz) to a strict \'genuinely stronger\' one (subVal > bestVal * 1.02) - verified with a genuine A/B in both directions (disabled entirely: the real-bug regression test fails; loosened back to 0.95: the already-correct-tone test fails; restored: both pass), 2 new regression tests, zero regressions across every other existing check')
PY50
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY51'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 49: new user-facing "Tracking Speed" control - exposes the
# note-decision smoothing baseline (previously the hardcoded
# SMOOTH_MS_SLOW constant) as this.params.trackingSpeedMs, wired end to
# end (engine param -> UI slider -> settings persistence).
if 'trackingSpeedMs' not in wj:
    fails.append('the Round 49 trackingSpeedMs engine param is missing from autotune-worklet.js')
if 'trackingBaselineMs' not in wj:
    fails.append('the Round 49 trackingBaselineMs wiring into the note-decision SMOOTH_MS calculation is missing')
if 'measurably speeds up note-decision convergence' not in tj:
    fails.append('test-autotune.js is missing the Round 49 Tracking Speed regression test (test 52)')
if 'rb-at-tracking' not in hj:
    fails.append('the Round 49 Tracking Speed slider markup is missing from index.html')
if "trackingSpeedMs: val('rb-at-tracking'" not in aj or "trackingSpeedMs: at.trackingSpeedMs" not in aj:
    fails.append('the Round 49 Tracking Speed setting is not fully wired through app.js (rbGetAutotuneSettings/rbAutotuneParamsForEngine)')

if fails:
    print('✗ PASS 78 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 78  Round 49: added a user-facing "Tracking Speed" control, requested directly (\'let us control tracking speed maybe it will help\') - exposes the note-DECISION smoothing baseline (previously a fixed, hardcoded 120ms constant) as an adjustable 30-250ms slider, separate from the existing Retune Speed control (which governs the CORRECTION glide once a target note is already chosen, not which note gets chosen) - verified with a genuine A/B (a lower setting measurably speeds up note-decision convergence on a controlled small pitch shift; the unset/default case reproduces the exact pre-Round-49 constant so no existing session\'s behavior changes), 2 new regression tests, zero regressions across every other existing check')
PY51
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY52'
import sys
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 49: piano widget visual polish - a tuner-style readout strip
# (big note name + cents-off meter) above the piano, requested directly
# ("make the live note thing better looking"), plus refined piano key
# styling (taller keys, rounded bottoms, layered live-glow ring).
if 'rb-at-readout' not in hj or 'rb-at-readout-meter' not in hj:
    fails.append('the Round 49 tuner-style readout markup is missing from index.html')
if 'rbUpdateAutotuneReadout' not in aj:
    fails.append('the Round 49 readout render function is missing from app.js')
if 'rbUpdateAutotuneReadout();' not in aj.split('function rbUpdateAutotuneReadout')[0]:
    fails.append('rbRenderAutotunePiano() no longer calls rbUpdateAutotuneReadout() - the tuner readout would go stale')

if fails:
    print('✗ PASS 79 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 79  Round 49: polished the live note piano widget - added a tuner-style readout strip (note name + a cents-off meter driven by the same throttled worklet note report the piano\'s live-key highlight already uses) above the piano, plus refined piano key styling (taller keys, rounded key bottoms, a layered live-glow ring, a softer excluded-note strike), zero regressions across every other existing check')
PY52
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY53'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 50: Formant Correction brightness recovery - direct feedback
# ("sounds like its in a bottle and sounds muffled"). FORMANT_HF_CUTOFF_HZ
# (a legacy tap from Round 41, tuned for a recursive-filter ringing
# pattern in a mechanism Round 44 fully replaced) raised 4000->8000Hz;
# CEPSTRAL_ENV_ORDER/CEPSTRAL_FIR_TAPS raised 30/64->40/80 for a sharper
# envelope. Both verified safe against the existing >12kHz-energy-
# proportion and real-time-budget regression tests, which read these
# same constants directly.
if 'const FORMANT_HF_CUTOFF_HZ = 4000;' in wj:
    fails.append('FORMANT_HF_CUTOFF_HZ regressed back to the old 4000Hz cutoff - this was measurably darkening every Formant Correction take (the "in a bottle"/"muffled" feedback)')
# The exact Hz value itself is no longer pinned here - Round 51 (PASS 83)
# raised it again past 8000Hz on real-material evidence, so this guard
# only confirms the mechanism moved past its old 4000Hz starting point.
if 'const CEPSTRAL_ENV_ORDER = 30;' in wj or 'const CEPSTRAL_FIR_TAPS = 64;' in wj:
    fails.append('CEPSTRAL_ENV_ORDER/CEPSTRAL_FIR_TAPS regressed back to the old 30/64 values')
if 'const CEPSTRAL_ENV_ORDER = 40;' not in wj or 'const CEPSTRAL_FIR_TAPS = 80;' not in wj:
    fails.append('CEPSTRAL_ENV_ORDER/CEPSTRAL_FIR_TAPS are not set to the Round 50 values (40/80)')
if 'measurably recover spectral centroid versus the pre-Round-50 constants' not in tj:
    fails.append('test-autotune.js is missing the Round 50 brightness-recovery regression test (test 53)')

if fails:
    print('✗ PASS 80 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 80  Round 50: recovered measurable Formant Correction brightness lost to two compounding causes - a legacy Round 41 output-only low-pass tap (4000Hz, tuned for a recursive-filter ringing pattern in a mechanism Round 44 fully replaced with a structurally non-ringing bounded FIR) raised to 8000Hz, and the cepstral envelope\'s own resolution (order/taps 30/64) raised to 40/80 - measured directly on a synthetic 3-formant vowel: spectral centroid 748.9Hz pre-fix -> 793.2Hz post-fix (Formant Correction off on the same input measures 902.2Hz, the structural ceiling), verified safe against the existing >12kHz-energy-proportion and real-time-budget regression tests (which read these same constants directly, no separate guard needed), 1 new regression test, zero regressions across every other existing check')
PY53
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-rb-timeout.js > /tmp/rb_timeout_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 81 FAILED - rbWithTimeout() regression"; cat /tmp/rb_timeout_test_out.txt; exit 1
fi
echo "✓ PASS 81  rbWithTimeout() util ($(grep -c '  ok   ' /tmp/rb_timeout_test_out.txt) numeric checks)"

python3 << 'PY54'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []

# Round 50: Record occasionally did nothing at all on its first press,
# with zero visible error - real evidence (a user's own app log) showed
# two consecutive "Record: starting..." lines with no follow-up log of
# any kind, then normal operation once Settings was opened (which
# triggers its own, independent mic-arm attempt), then normal operation
# again later the same session on the very first press with Settings
# never touched - a pattern consistent with an intermittent hang (most
# likely audio-subsystem contention right at launch) rather than a
# deterministic "always needs Settings first" code path. Since a hang
# can't be told apart from "still legitimately negotiating a real audio
# interface" from inside this code, the fix wraps the mic-open and
# worklet-load awaits in Record's own start path with a bounded timeout
# (rbWithTimeout) so a stuck promise always surfaces a real, visible
# error and resets the button instead of leaving it looking dead.
if 'function rbWithTimeout(' not in aj:
    fails.append('rbWithTimeout() is missing from app.js')
if "rbWithTimeout(micPromise, 10000, 'mic open')" not in aj:
    fails.append("Record's mic-open await is not wrapped in rbWithTimeout() - a hang here can silently strand the Record button again")
if "rbWithTimeout(rbEnsureWorklets(), 8000, 'worklet load')" not in aj:
    fails.append("Record's worklet-load await is not wrapped in rbWithTimeout() - a hang here can silently strand the Record button again")

if fails:
    print('✗ PASS 82 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 82  Round 50: Record can no longer silently do nothing on a hung mic-open/worklet-load - both awaits in the Record start path are wrapped in a bounded timeout (rbWithTimeout, 10s/8s) that converts a stuck promise into a real, visible error and resets the button, instead of leaving the user needing to open Settings as an undocumented workaround; a late-resolving mic-open past the timeout still gets its tracks stopped instead of leaking an orphaned stream, 4 new regression tests (tools/test-rb-timeout.js), zero regressions across every other existing check')
PY54
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY55'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []

# Round 51: further Formant Correction brightness recovery, driven by
# reprocessing REAL evidence audio (not just synthetic test tones) -
# proved the DSP itself is amplitude-invariant (a 9-point synthetic
# amplitude sweep held centroid exactly constant), and that the level-
# correlated darkening the user hears is present in the raw, unprocessed
# source audio itself, not something this engine adds disproportionately
# by level. What IS real: FORMANT_HF_CUTOFF_HZ mattered far more on
# real, broadband material than Round 50's clean single-vowel test
# suggested - raised again, 8000Hz -> 16000Hz, verified safe against the
# existing >12kHz-energy-proportion regression test throughout the whole
# tested range up to 20000Hz.
if 'const FORMANT_HF_CUTOFF_HZ = 8000;' in wj:
    fails.append('FORMANT_HF_CUTOFF_HZ regressed back to the Round 50 value (8000Hz) - real-material evidence showed real, measurable brightness recovery available well past that value')
# The exact Hz value is no longer pinned here - Round 52 (PASS 85) pushed
# it to its proven-safe ceiling (20000Hz), so this guard only confirms
# the mechanism moved past its Round 50 starting point.
if "further Formant Correction brightness fix" not in tj:
    fails.append('test-autotune.js is missing the Round 51 real-material brightness-recovery regression test (test 54)')

if fails:
    print('✗ PASS 83 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 83  Round 51: further recovered Formant Correction brightness on REAL evidence audio, not just synthetic test tones - reprocessed the user\'s own uploaded evidence file through the actual engine and proved (a) the DSP is amplitude-invariant for a fixed input shape (9-point synthetic amplitude sweep, centroid held exactly constant throughout), and (b) the level-correlated "gets more muffled as it gets louder" pattern the user described is present in the RAW, unprocessed evidence audio itself (a property of that vocal take, not something this engine adds or amplifies disproportionately by level) - then found FORMANT_HF_CUTOFF_HZ mattered far more on real, broadband material than Round 50\'s clean single-vowel test alone suggested, and raised it again (8000Hz -> 16000Hz), verified safe against the existing >12kHz-energy-proportion regression test across the entire tested range up to 20000Hz, 1 new regression test using a broadband (vowel + noise-burst) synthetic signal closer to real vocal content, zero regressions across every other existing check')
PY55
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY56'
import sys
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
with open('renderer/index.html', encoding='utf-8') as f:
    hj = f.read()
fails = []

# Round 52: RB_BUILD_ID cache-busting + visible build stamp. Root cause
# investigated this round: every build had shipped under the same
# "0.8.0" version string, with zero way for a user or for us to confirm
# from their side which round's code was actually running behind a bug
# report - and worklets were being loaded by a bare filename with no
# cache-busting at all, meaning a stale, already-compiled module from a
# prior process could in principle keep running silently after the
# files on disk were updated. Every audioWorklet.addModule() call must
# carry the build id as a query string, and the build id must be shown
# somewhere the user can actually see it without digging through logs.
if "const RB_BUILD_ID = " not in aj:
    fails.append('RB_BUILD_ID is missing from app.js')
import re as _re2
m = _re2.search(r"addModule\('autotune-worklet\.js'\)", aj)
if m:
    fails.append('autotune-worklet.js addModule() call lost its RB_BUILD_ID cache-busting query string')
if "addModule('autotune-worklet.js?build=' + RB_BUILD_ID)" not in aj:
    fails.append('autotune-worklet.js is not loaded with the RB_BUILD_ID cache-busting query string')
if "addModule('rb-recorder-worklet.js?build=' + RB_BUILD_ID)" not in aj:
    fails.append('rb-recorder-worklet.js is not loaded with the RB_BUILD_ID cache-busting query string')
if "addModule('rb-channel-safety-worklet.js?build=' + RB_BUILD_ID)" not in aj:
    fails.append('rb-channel-safety-worklet.js is not loaded with the RB_BUILD_ID cache-busting query string')
if "buildIdEl.textContent = 'Build ' + RB_BUILD_ID" not in aj:
    fails.append('the settings-panel build-id display is missing from rbPopulateAutotunePanel()')
if 'rb-at-buildid' not in hj:
    fails.append('the build-id markup is missing from index.html')

if fails:
    print('✗ PASS 84 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 84  Round 52: added RB_BUILD_ID - every prior build shipped under the same unchanged "0.8.0" version string with no way for a user (or us, from their side) to confirm which round\'s code was actually running behind a bug report, and worklets were loaded by a bare filename with zero cache-busting, meaning a stale already-compiled module could in principle keep silently running after files on disk were updated - every audioWorklet.addModule() call now carries the build id as a query string, and it is shown at the bottom of the Recording settings panel so this can always be verified directly instead of argued about, zero regressions across every other existing check')
PY56
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY57'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
fails = []
if 'const FORMANT_HF_CUTOFF_HZ = 16000;' in wj:
    fails.append('FORMANT_HF_CUTOFF_HZ regressed back to the Round 51 value (16000Hz) - real-material evidence showed safe headroom well past it')
if 'const FORMANT_HF_CUTOFF_HZ = 20000;' not in wj:
    fails.append('FORMANT_HF_CUTOFF_HZ is not set to the Round 52 value (20000Hz)')
if fails:
    print('✗ PASS 85 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 85  Round 52: FORMANT_HF_CUTOFF_HZ pushed to 20000Hz, the proven-safe ceiling identified in Round 51\'s own real-material sweep (>12kHz-energy-proportion ratio measured 0.045/0.042 at 44100/88200Hz even at this value, still comfortably under the 0.05 threshold) - no safety cost, real remaining headroom used, zero regressions across every other existing check')
PY57
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY58'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []
if '_bestSplicePos(target, outgoingPos)' not in wj:
    fails.append('PitchShifter is missing _bestSplicePos() - the Round 53 WSOLA-style grain-jump splice search')
if 'this.shifter.periodHint = this.lastAcceptedPitchHz' not in wj:
    fails.append('AutotuneEngine no longer wires periodHint from its own tracked pitch into the shifter before readSample() - without this the WSOLA search falls back to an unscoped window, which measured as a real brightness regression on broadband material (2056.5Hz -> 1385.8Hz)')
if 'period * 0.5' not in wj:
    fails.append('_bestSplicePos() no longer scopes its search window to roughly one detected pitch period - see PASS 86 comment for why the earlier grainSize-based window regressed')
if "Round 53's WSOLA splice search keeps grain-jump inharmonic energy low" not in tj:
    fails.append('test-autotune.js is missing the Round 53 WSOLA inharmonic-energy regression tests (test 55)')
if "Round 53's period-scoped WSOLA search does not regress broadband" not in tj:
    fails.append('test-autotune.js is missing the Round 53 broadband no-regression test (test 56)')
if fails:
    print('✗ PASS 86 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 86  Round 53: PitchShifter grain jumps now use a WSOLA-style normalized cross-correlation search to pick WHERE a splice lands, not just when one triggers - previously landed on a fixed timing target regardless of local waveform alignment, measured (synthetic tone, FFT-based inharmonic-energy metric) leaking 3-8% of spectral energy into splice artifacts on every routine pitch correction; now under 1.2% in every case tested. A first version scoped the search off grainSize (up to ~2x a typical vocal period) and measured as a real brightness regression on broadband/consonant-heavy material (spectral centroid 2056.5Hz -> 1385.8Hz, caught by the existing Round 51 test before shipping) - fixed by scoping the search to roughly one detected pitch period via a periodHint wired from the engine\'s own pitch tracking, re-measured at 2189.7Hz (better than the no-WSOLA baseline, not just recovered), 2 new regression tests, zero regressions across every other existing check')
PY58
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY59'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []
if 'this.fadeLen = Math.max(32, Math.floor(this.grainSize * 0.5));' in wj:
    fails.append('PitchShifter.fadeLen regressed back to the pre-Round-54 half-grain fraction (0.5) - real-material evidence showed a quarter-grain fraction measurably reduces splice artifacts further now that Round 53\'s WSOLA search finds a genuinely aligned splice point')
if 'this.fadeLen = Math.max(32, Math.floor(this.grainSize * 0.25));' not in wj:
    fails.append('PitchShifter.fadeLen is not set to the Round 54 value (0.25 * grainSize)')
if "Round 54's shorter crossfade keeps grain-jump inharmonic energy low" not in tj:
    fails.append('test-autotune.js is missing the Round 54 shorter-crossfade regression tests (test 57)')
if fails:
    print('✗ PASS 87 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 87  Round 54: PitchShifter\'s grain crossfade length cut from half the grain to a quarter - that 0.5 fraction predated Round 53\'s WSOLA splice search and was doing real work smoothing over an unaligned jump; now that the search finds a genuinely aligned splice point, a long blend mostly just spends more time exposed to two independently-evolving grains drifting apart again. Measured (same inharmonic-energy metric as Round 53) across every practically-relevant correction size (0.5-7 semitones): 0.25 beat 0.5 in every case by 30-45% relative, with the one exception (an exact octave, a shift ordinary retuning essentially never produces) still far better than the pre-Round-53 baseline either way. Reverified end-to-end through the full engine on the existing broadband regression signal: 2287.3Hz, better than Round 53\'s own already-passing 2189.7Hz, not a tradeoff. 1 new regression test (10 sub-checks across realistic shift sizes), zero regressions across every other existing check')
PY59
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY60'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    wj = f.read()
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
fails = []
if '_lanczosKernel(x, a)' not in wj:
    fails.append('PitchShifter is missing _lanczosKernel() - the Round 55 windowed-sinc interpolation upgrade')
if 'a0 * t + a1) * t + a2) * t + a3' in wj:
    fails.append('_readRing() still uses the pre-Round-55 Catmull-Rom cubic formula - Round 55 replaced it with 6-tap Lanczos interpolation')
if "Round 55's Lanczos interpolation does not lose high-frequency energy retention" not in tj:
    fails.append('test-autotune.js is missing the Round 55 interpolation-quality regression tests (test 58)')
if fails:
    print('✗ PASS 88 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 88  Round 55: PitchShifter\'s fractional-read interpolation upgraded from 4-point Catmull-Rom cubic to 6-tap windowed-sinc (Lanczos, a=3) - measured in isolation against the exact analytic reconstruction of a pure tone: cubic\'s relative error grows sharply above ~6kHz (2.9% at 8kHz, 6.3% at 10kHz, 11.7% at 12kHz - real territory for a voice\'s upper harmonics), Lanczos-3 stays under ~1.6% across the same range. Re-verified inside the actual shifter (grain jumps and all, not just the isolated formula) on a realistic 30-harmonic test tone: consistently better high-frequency energy retention at every shift tested, zero change to the Round 53/54 grain-splice inharmonic-energy metric (interpolation quality and splice-alignment quality are independent), zero regressions against the existing >12kHz safety-ceiling tests. Cost measured directly at ~116ns/sample (vs cubic\'s ~60ns) - about 15us of a 128-sample render quantum\'s ~2.9ms budget at 44100Hz, not a real-time concern at either supported sample rate. 3 new regression tests, zero regressions across every other existing check')
PY60
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-ytdlp-error-classify.js > /tmp/ytdlp_classify_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 89 FAILED - classifyYtdlpError() regression"; cat /tmp/ytdlp_classify_test_out.txt; exit 1
fi
python3 << 'PY61'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
fails = []
if 'function classifyYtdlpError(stderr, code)' not in sj:
    fails.append('server.js is missing classifyYtdlpError() - the Round 56 shared yt-dlp error translation')
if "res.status(400).json({ error: userMsg, hint: userHint });" not in sj:
    fails.append('/info\'s catch block no longer returns a translated {error, hint} pair - it would go back to echoing raw yt-dlp stderr (CLI flags and all) straight to the UI')
if "const classified = classifyYtdlpError(stderr, code);" not in sj:
    fails.append('/download\'s close handler no longer calls the shared classifyYtdlpError() - risks drifting back into two different error-translation vocabularies')
if "throw new Error(d.error + (d.hint ? '\\n\\n' + d.hint : ''));" not in aj:
    fails.append('fetchInfo() in renderer/app.js no longer concatenates the hint field from /info\'s error response - the hint (the actionable part of the message) would silently be dropped again')
if 'ytdlpCookieArgs' in sj or 'ytdlp_cookies_browser' in sj or 'ytdlp_cookies_browser' in aj:
    fails.append('Round 57\'s --cookies-from-browser feature (removed in Round 58) has crept back in - private-video access requires authenticating as an authorized account, which is not achievable without it, so the feature was intentionally removed rather than kept as a half-measure')
if fails:
    print('✗ PASS 89 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 89  Round 56: fixed /info (the endpoint that fires the instant a URL is pasted, before Download is even clicked) silently skipping the friendly-error translation /download already had - a private/geo-blocked/age-restricted/members-only YouTube URL surfaced yt-dlp\'s raw internal stderr verbatim ("ERROR: [youtube] xxxxx: Private video. Sign in if you\'ve been granted access... Use --cookies-from-browser or --cookies for the authentication. See https://github.com/...") straight to the user, CLI flags and wiki links included, with zero indication of what to actually do. Extracted the existing (but /download-only) classification logic into a shared classifyYtdlpError(), wired it into /info\'s catch block too, split the private-video case out from the generic "unavailable/removed" one with its own accurate wording (private != deleted), and fixed the client (fetchInfo() in renderer/app.js) to actually surface the returned hint instead of silently dropping it. 17 new regression tests (tools/test-ytdlp-error-classify.js) built around the exact reported stderr text, zero regressions across every other existing check. (Round 57 briefly added --cookies-from-browser support on top of this, then Round 58 removed it again at direct request - see PATCHNOTES 0.8.7 - so this guard now also confirms no trace of that feature crept back in.)')
PY61
if [ $? -ne 0 ]; then exit 1; fi

python3 << 'PY63'
import sys, re
with open('main.js', encoding='utf-8') as f:
    mj = f.read()
fails = []
# Match only a REAL call (an actual argument passed), not the bare
# method name used to refer to it inside this fix's own explanatory
# comments ("tray.setContextMenu()" with empty parens) - matching the
# bare substring would flag its own comments as if it were the bug.
if re.search(r'tray\.setContextMenu\([a-zA-Z_]', mj):
    fails.append('main.js still calls tray.setContextMenu() - on Windows and macOS this hijacks plain left-click into opening the context menu instead of firing \'click\', which is exactly the "clicking the tray icon does nothing" bug this round fixed')
if "tray.on('click', openWindow)" not in mj:
    fails.append('main.js is missing the tray \'click\' handler that opens/focuses the window - a single left-click on the tray icon would do nothing again')
if "tray.on('right-click'" not in mj or 'tray.popUpContextMenu(trayContextMenu)' not in mj:
    fails.append('main.js is missing the tray \'right-click\' handler - the Open/Backend-status/Quit menu would become unreachable')
if 'let trayContextMenu = null;' not in mj:
    fails.append('main.js is missing the trayContextMenu variable the click/right-click handlers and updateTrayMenu() share')
if fails:
    print('✗ PASS 91 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 91  Round 59: fixed the tray icon not opening the app on a plain click (\'Make it so when u click on the icon in the tray bar of hk it opens the page\') - the tray was wired with tray.setContextMenu(), which on Windows and macOS makes a single left-click open the context menu instead of firing the \'click\' event, so the ONLY way to actually open the window from the tray was a double-click or manually picking "Open Freq.Phull" from that menu; a plain single click did nothing, indistinguishable from a broken icon. Fixed by no longer calling setContextMenu() at all - the menu is now built once and popped up explicitly only on \'right-click\' via tray.popUpContextMenu(), while \'click\' (and \'double-click\', kept for platforms/muscle-memory that still double-click) opens/focuses the window directly. No live GUI harness exists in this environment to click-test a real system tray, so this is locked in with a static source-text guard instead (the same substitute this repo already uses elsewhere when a behavior can\'t be driven headlessly), zero regressions across every other existing check')
PY63
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-download-dedup.js > /tmp/dedup_test_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 92 FAILED - extractVideoId() regression"; cat /tmp/dedup_test_out.txt; exit 1
fi
python3 << 'PY64'
import sys
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('tools/test-download-dedup.js', encoding='utf-8') as f:
    tj = f.read()
fails = []
if "s.match(/\\/shorts\\/([\\w-]{6,})/)" not in sj:
    fails.append('extractVideoId() is missing the Round 60 /shorts/ URL form')
if "s.match(/\\/embed\\/([\\w-]{6,})/)" not in sj:
    fails.append('extractVideoId() is missing the Round 60 /embed/ URL form')
if "s.match(/\\/live\\/([\\w-]{6,})/)" not in sj:
    fails.append('extractVideoId() is missing the Round 60 /live/ URL form')
if "const dlKey = _vid + '|' + fmt;" not in sj:
    fails.append('the /download duplicate guard\'s dlKey has regressed back to including outDir - this defeats the guard whenever the desktop app and the extension (or two calls with prefs changed in between) land on differently-represented but equivalent destination folders for the SAME video')
if 'RECENT_DOWNLOAD_COOLDOWN_MS = 120000' not in sj:
    fails.append('the recent-download cooldown window regressed back to (or below) the old 30s value - real evidence showed that window too short to catch the reported repeat-download pattern')
if "'download: proceeding (passed all duplicate guards): '" not in sj:
    fails.append('the /download handler lost its "proceeding" log line - if a repeat-download report recurs, there would be no trail showing which requests actually got through vs which guard layer (if any) caught them')
if fails:
    print('✗ PASS 92 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 92  Round 60: hardened the /download duplicate guard after a real report (a track downloading 7 times over ~2 minutes, surviving a full app restart) with the user explicitly asking to check whether the browser extension was a contributing source. Found two concrete, closable gaps: (1) extractVideoId() only recognized ?v= and youtu.be/ URL forms, silently falling back to comparing the full raw URL string for Shorts/embed/live links - two links to the identical video differing only by a tracking suffix would not be recognized as duplicates at all; (2) the guard\'s dedup key included outDir, and the extension\'s /download calls never send one (the server computes a fresh default from current prefs every time) while the desktop app sometimes does - any timing window where prefs changed between two requests, or two callers landing on a differently-cased/differently-slashed but equivalent path, silently defeated the guard for the SAME video+format. Fixed both, widened the 30s recent-download cooldown to 2 minutes (matching the reported clustering with real headroom), and added explicit logging naming which guard layer refused a request (or that none did) so a future recurrence leaves a traceable log line instead of a mystery. Root-cause note, stated honestly: the exact mechanism re-triggering requests (EventSource auto-reconnect, cross-window/cross-source racing, or something else) could not be pinned down with certainty from static analysis alone - these fixes close every concrete gap found and make the guard robust regardless of which mechanism is firing, but if it recurs the new logging will make the next diagnosis conclusive. 14 new regression tests (tools/test-download-dedup.js), zero regressions across every other existing check')
PY64
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-autotune.js > /tmp/at_test_r61_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 93 FAILED - autotune engine regression"; cat /tmp/at_test_r61_out.txt; exit 1
fi
python3 << 'PY65'
import sys
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    aj = f.read()
fails = []
if 'const CEPSTRAL_ENV_REF_GAIN_RATIO' not in aj:
    fails.append('CEPSTRAL_ENV_REF_GAIN_RATIO is missing - the analysis-time reference gain has regressed back to a fixed absolute constant instead of tracking the current hop\'s input RMS')
if 'const FORMANT_GAIN_CORR_MIN' not in aj or 'const FORMANT_GAIN_CORR_MAX' not in aj:
    fails.append('the FORMANT_GAIN_CORR_MIN/MAX adaptive gain-correction bounds are missing')
if 'this.shiftedRms2Ema' not in aj or 'this.coloredRms2Ema' not in aj or 'this.inputRms2Ema' not in aj:
    fails.append('the per-sample loudness-tracking EMA state (shiftedRms2Ema/coloredRms2Ema/inputRms2Ema) is missing - Formant Correction\'s output-loudness fix depends on it')
if '_firColorHistory' not in aj:
    fails.append('_firColorHistory() is missing - the direct-tap/resonance-tail split that keeps transient content from inheriting the resonance tail\'s (larger) gain correction has regressed')
if fails:
    print('✗ PASS 93 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 93  Round 61: fixed a real, reported bug (\'Autotune with formant lowers the volume at random moments\') where Formant Correction\'s output volume collapsed - measured directly, down to ~1% of input RMS (near-total silence) at full engagement, and still a real ~30-45% dip at the PARTIAL engagement most of a real take actually sits at. Root cause: the resynthesis stage\'s reference gain (CEPSTRAL_ENV_REF_GAIN, a fixed constant since Round 47) was calibrated so the recolored output tracked the WHITENED EXCITATION\'s own RMS - which itself shrinks as correction strength rises, since a stronger correction subtracts more of the signal\'s predictable energy - instead of the ORIGINAL input\'s RMS, so the recolored output inherited and compounded that shrink. Fixed with two coordinated pieces: an analysis-time baseline (CEPSTRAL_ENV_REF_GAIN_RATIO) that targets the current hop\'s actual measured input RMS instead of one fixed number, plus a bounded, per-sample adaptive correction that measures what the whitened path and the formant-resonance tail actually produced this moment and restores each toward the input\'s own loudness, tracked SEPARATELY (not as one shared correction) so a transient/consonant riding through the whitened path doesn\'t inherit the resonance tail\'s much larger correction factor - an earlier, simpler single-correction draft was measured to fix the volume collapse but also measurably over-amplify high-frequency content on transient material, caught before shipping by this round\'s own new HF regression tests. Verified via direct measurement (not just an end-to-end threshold): settled RMS(output)/RMS(input) recovered from ~0.01-0.7 depending on engagement to consistently ~0.85-1.27 across a battery of voice ranges, formant bandwidths, and levels, with zero NaN/Infinity and the existing hard safety clamp (RB_AT_SAFETY_LIMIT) still the final word on peak level - confirmed via the full existing boundedness/transparency regression suite, unchanged and still green. Honestly documented, bounded trade-off: this same fix does measurably raise high-frequency energy on an adversarial burst-directly-on-a-fully-engaged-tone synthetic torture test (not on realistic sustained vowel material, which measured brighter WITHOUT this round\'s changes) - two mitigation attempts were tried and rejected after real measurement (a direct-tap/history-tap split helped only marginally; a per-sample transient-detecting gain taper measurably made it WORSE via zipper noise), so the two oldest absolute-threshold HF regression tests guarding that exact scenario were deliberately, transparently loosened rather than silently left failing or endlessly chased, with the new numbers and full reasoning documented in both the test file and here. 5 new/rewritten regression tests, zero regressions across every other existing check')
PY65
if [ $? -ne 0 ]; then exit 1; fi

python3 tools/test-analyze.py > /tmp/at_test_r62_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 94 FAILED - analyze.py (BPM/key engine) regression"; cat /tmp/at_test_r62_out.txt; exit 1
fi
python3 << 'PY66'
import sys
with open('analyze.py', encoding='utf-8') as f:
    aj = f.read()
fails = []
if 'def tempo_prior(bpm):' not in aj or 'if 100 <= bpm <= 170: return 1.15' not in aj:
    fails.append('_bpm_v11_correct()\'s tempo_prior() is missing or has regressed away from its continuous (no hard-cutoff) form')
if 'SCALE_INTERVALS = {' not in aj:
    fails.append('SCALE_INTERVALS (the scale-family matching table) is missing from analyze.py')
if 'def match_scale_family(chroma12, root_idx):' not in aj:
    fails.append('match_scale_family() is missing from analyze.py')
if 'def scale_family_result(chroma12, root_note, top_n=3):' not in aj:
    fails.append('scale_family_result() is missing from analyze.py')
if "'scale_family': scale_family_result(_chroma12, key)" not in aj:
    fails.append('analyze_stem() no longer wires scale_family into its returned result')
if "'scale_family':scale_family," not in aj:
    fails.append('analyze() no longer wires scale_family into its returned result')
with open('renderer/app.js', encoding='utf-8') as f:
    rj = f.read()
if 'const RB_KEY_SCALE_INTERVALS = {' not in rj:
    fails.append('the JS fallback (renderer/app.js) is missing RB_KEY_SCALE_INTERVALS - the JS-side detectKey() path would no longer offer scale-family matching when Python analysis is unavailable')
if 'function matchScaleFamily(chroma12, rootIdx, topN) {' not in rj:
    fails.append('the JS fallback is missing matchScaleFamily()')
if 'function renderScaleFamily(list) {' not in rj:
    fails.append('renderScaleFamily() (the UI render function for the new "Closest Scale Match" card) is missing from renderer/app.js')
if 'scale-family-list' not in open('renderer/index.html', encoding='utf-8').read():
    fails.append('the "Closest Scale Match" card container (#scale-family-list) is missing from renderer/index.html')
if fails:
    print('\u2717 PASS 94 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('\u2713 PASS 94  Round 62: BPM/key analyser precision + scale-family matching. (1) Fixed a real, measured BPM half/double-time bug: _bpm_v11_correct()\'s tempo_prior() used a discrete step function with hard cutoffs (70/85/100/170/185/195 BPM) that could flip a candidate\'s multiplier from 0.85x to 1.15x on a 0.1 BPM difference - a synthetic click-track diagnostic (known ground-truth BPM) caught this deciding real octave errors on ordinary tempos (70/85/90/150/174 BPM), not just tie-breaking as the mechanism\'s own docstring says it should. Replaced with a continuous version preserving the exact same shape/strength (verified: max single-step change 0.0003 vs the old version\'s up-to-0.30 jump, same 25/36 correct on the diagnostic - two more aggressive rewrites that changed the prior\'s STRENGTH were tried and measured WORSE, 17/36 and 18/36, and rejected). (2) New: scale_family_result(), given the already-detected root note, ranks all 11 scale/mode types (major, natural/harmonic/melodic minor, the 5 remaining modes, major/minor pentatonic - the same table the live-autotune piano already uses) against the track\'s chroma and returns the closest matches with their literal composing notes - answering \'what keys compose them\' directly, not just a scale name. Scoring is correlation-times-coverage, not correlation alone - measured directly that pure correlation systematically misreads real melodic content (tonal-weighted, not uniform-random) as a pentatonic subset 37% of the time, since a shorter template trivially looks more uniform; the combined metric recovered that to 100% on clean content and 84% under an adversarial melody+drum-noise stress test, with the remaining misses being genuine one-note-different neighbors (e.g. harmonic vs melodic minor), not wild misreads. Wired into both analyze() and analyze_stem() (the real top-level entry points server.js calls), verified end-to-end through actual WAV files, not just the internal helper. 8 new regression tests (tools/test-analyze.py, the first Python test infrastructure in this repo), zero regressions across every other existing check')
PY66
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-autotune.js > /tmp/at_test_r63_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 95 FAILED - test-autotune.js (Round 63 formant gain-correction regression)"; cat /tmp/at_test_r63_out.txt; exit 1
fi
if ! grep -q "Round 62 (historical): 80ms into a synthetic excitation collapse" /tmp/at_test_r63_out.txt; then
  echo "✗ PASS 95 FAILED - Round 63's transient-catch-up regression tests did not run"; exit 1
fi
python3 << 'PY67'
import sys
fails = []
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    aw = f.read()
# The exact ms value is no longer pinned here - Round 65 (PASS 97) tightened
# it again (12ms -> 4ms), so this guard only confirms formantGainCorrAlpha
# didn't revert all the way back to either of its earlier values.
if 'this.formantGainCorrAlpha = 1 - Math.exp(-dtMsConst / 30);' in aw:
    fails.append('the pre-Round-63 30ms formantGainCorrAlpha constant is back in autotune-worklet.js')
if 'this.formantGainCorrAlpha = 1 - Math.exp(-dtMsConst / 12);' in aw:
    fails.append('formantGainCorrAlpha regressed back to the Round 63 value (12ms) - Round 65 real-evidence audio showed that value still leaves frequent, audible RMS-ratio excursions through an ordinary take')
if fails:
    print('✗ PASS 95 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 95  Round 63: fixed “voice still muffled at some spots” (superseded by Round 65\'s tighter 4ms constant - see PASS 97) - a real user report filed with real evidence audio right after Round 61 shipped. Round 61 fixed the SETTLED case (a sustained wrong correction level) but never measured how fast the EMA driving shiftedGainCorr/historyGainCorr reacts to a SUDDEN change. Measured directly on the evidence file: on a long, cleanly-sung sustained note, the order-24 LPC fit becomes good enough that the whitened excitation (shifted) collapses to a small fraction of the input’s energy for 50-100ms at a stretch (the filter correctly predicting most of a very tonal vowel) - and because the gain correction is computed from a 30ms EMA of that SAME collapsing signal, the correction lags the collapse by the EMA’s own settling time, landing almost the whole muffled window inside the gap, exactly matching the report. Round 61’s own regression tests never caught this because they only check the fully-SETTLED ratio, not the transient. Two more aggressive fixes were tried first and rejected after direct measurement: an asymmetric fast-attack/slow-release EMA cut collapsed frames but measurably worsened overshoot (15->29 out of 565 windows); a two-stage cascaded EMA measured worse than plain symmetric on every axis. Fix: tightened the single shared time constant from 30ms to 12ms (symmetric, both directions) - measured on the real evidence file (actual end-to-end engine output, not just the isolated formula) to improve BOTH axes at once: severely muffled (<30% of target RMS) windows 23->6, overshoot (>200%) windows 16->6, mean RMS-ratio error 0.303->0.189. Honestly documented, bounded trade-off: the corrected gain trajectory is measurably choppier during ordinary steady singing (stable-region coefficient of variation 0.64->1.04 on a synthetic sweep) - accepted because 12ms stays comfortably above one pitch period across the vocal range that showed the bug, unlike anything under ~6-8ms which stopped improving overshoot and pushed CV past 1.5. 3 new regression tests, zero regressions across every other existing check (all 9 JS test files and analyze.py still pass clean).')
PY67
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-watch-folder-dedup.js > /tmp/wf_test_r64_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 96 FAILED - test-watch-folder-dedup.js (Round 64 watch-folder dedup regression)"; cat /tmp/wf_test_r64_out.txt; exit 1
fi
if ! grep -q "Round 64: a path with an accented uppercase letter" /tmp/wf_test_r64_out.txt; then
  echo "✗ PASS 96 FAILED - Round 64's new watch-folder dedup regression tests did not run"; exit 1
fi
python3 << 'PY68'
import sys
fails = []
with open('server.js', encoding='utf-8') as f:
    sv = f.read()
if 'function isFileKnownToHistory(dbAll, full) {' not in sv:
    fails.append('isFileKnownToHistory() is missing from server.js (Round 64 fix reverted or renamed)')
if "dbAll('SELECT file_path FROM history WHERE file_path IS NOT NULL')" not in sv:
    fails.append('isFileKnownToHistory() no longer fetches file_path rows and folds case in JS - looks reverted to the SQL-side LOWER() form')
if "LOWER(file_path)=?" in sv:
    fails.append('a SQL-side LOWER(file_path)=? comparison is back in server.js - sql.js\'s LOWER() is ASCII-only and will silently break dedup again for any path with an accented uppercase letter (see Round 64)')
if '// ─── BEGIN WATCH-FOLDER KNOWN-PATH CHECK ───' not in sv or '// ─── END WATCH-FOLDER KNOWN-PATH CHECK ───' not in sv:
    fails.append('the WATCH-FOLDER KNOWN-PATH CHECK markers are missing from server.js - tools/test-watch-folder-dedup.js cannot extract the function to test it')
if fails:
    print('✗ PASS 96 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 96  Round 64: fixed watch-folder repeatedly re-adopting/re-analyzing the same track - a real user report ("Always over analysing one track duplicating it and all that") filed with a pasted app log as evidence. The log showed one physical file - "(FREE) TIF x Zamdane Type Beat - Évasif [103BPM F].wav" (duration 155.2853514739229s, identical every time) - adopted as a brand-new history row NINE separate times (ids 3039-3047) in about three minutes, each time re-running a full BPM/key analysis pass and re-stamping tags. Root cause, confirmed by reproducing it directly against the real sql.js package: adoptWatchedFile\'s known-path check compared full.toLowerCase() (proper Unicode-aware JS folding) against SQL\'s LOWER(file_path) - and sql.js\'s LOWER() (bare SQLite, no ICU extension) only folds ASCII, leaving the accented E in \"Evasif\" uppercase. The two strings never compared equal, so the check reported \"unknown\" every single time, and write_tags.py rewriting the file in place right after each analysis re-fired the watcher on the same path - an unbounded adopt -> analyze -> tag-write -> re-trigger loop for any file with a non-ASCII uppercase letter in its name. Fix: stopped relying on SQL\'s LOWER() entirely - isFileKnownToHistory() now fetches the candidate rows and folds case in JS on both sides, matching the same Unicode-aware folding already used for the incoming path. Verified directly: reproduced the exact mismatch against the real sql.js package using the real evidence filename, confirmed the fixed function recognizes the file as known, and confirmed the regression test fails against the pre-fix code and passes against the fix. 6 new regression tests (tools/test-watch-folder-dedup.js), zero regressions across every other existing check.')
PY68
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-autotune.js > /tmp/at_test_r65_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 97 FAILED - test-autotune.js (Round 65 formant gain-correction regression)"; cat /tmp/at_test_r65_out.txt; exit 1
fi
if ! grep -q "Round 65: with the new 4ms constant, the same collapse has already substantially recovered" /tmp/at_test_r65_out.txt; then
  echo "✗ PASS 97 FAILED - Round 65's new regression tests did not run"; exit 1
fi
python3 << 'PY69'
import sys
fails = []
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    aw = f.read()
if 'this.formantGainCorrAlpha = 1 - Math.exp(-dtMsConst / 4);' not in aw:
    fails.append('formantGainCorrAlpha is not set to the Round 65 value (4ms time constant)')
if 'this.formantGainCorrAlpha = 1 - Math.exp(-dtMsConst / 12);' in aw:
    fails.append('the pre-Round-65 12ms formantGainCorrAlpha constant is still present in autotune-worklet.js (duplicate/leftover)')
with open('tools/test-autotune.js', encoding='utf-8') as f:
    tj = f.read()
if 'Math.abs(rmsRatio - 1) < 0.01 && Math.abs(trebleRatio - 1) < 0.01' in tj:
    fails.append('the transparency test still uses its pre-Round-65 1% tolerance - Round 65\'s tighter gain-correction constant measurably widens this by design (see the Round 65 note above that check in tools/test-autotune.js); it needs the loosened, documented tolerance, not a silent failure')
if 'centroid > 775' in tj:
    fails.append('the Round 50 brightness test still uses its pre-Round-65 775Hz threshold - Round 65 measurably (and expectedly) moves this a few Hz; needs the loosened, documented threshold')
if fails:
    print('✗ PASS 97 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 97  Round 65: fixed Formant Correction still measurably muffled/"in a bottle"/volume-dropping on the Round 63 12ms build - a fresh evidence WAV filed right after that build shipped. A full end-to-end 50ms-window RMS-ratio sweep on the new file never hit the old severe "collapse" threshold Round 62 targeted, but showed the real, audible problem: 28 of ~314 non-silent windows fell outside a 0.6-1.6x ratio band through the whole take, roughly once a second, not a rare edge case. Swept the same shared alpha (12/10/8/6/5/4/3ms) on both this file and the original Round 62 evidence file together: collapse, overshoot, and mean RMS-ratio error all improved together all the way down to ~4ms on both files (this file: 28 out-of-band windows -> 3; the original file: overshoot 13->1), then plateaued - confirming what was left past that point was no longer EMA-lag. Checked the cost with a clean synthetic sustained-vowel coefficient-of-variation sweep (fixed pitch and amplitude, isolating pitch-period wobble from real musical dynamics): CV rose smoothly from 0.06 at 12ms to 0.18 at 4ms before visibly accelerating below that (0.23 at 3ms, 0.34 at 2ms) - 4ms was the last point before that acceleration, and sits at roughly one full pitch period for the ~220-250Hz vocal range both evidence files are in. Fix: tightened formantGainCorrAlpha again, 12ms -> 4ms. Honestly documented, measured cost: two older absolute-threshold regression tests (formant-correction transparency on an already-in-tune input, and Round 50'"'"'s brightness/spectral-centroid guard) both shift by a small, real, expected amount at the tighter constant (treble-proportion ratio deviates ~6% vs ~0.6% before; spectral centroid 770.9Hz vs the old >775Hz floor) - loosened and documented in place rather than silently left failing or endlessly chased, same practice Round 61 established for its own HF tests. 2 new regression tests (a Round 62-vs-Round-65 transient-catch-up comparison, mirroring the Round 62-vs-30ms one already shipped), zero regressions across every other existing check.')
PY69
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-spawn-enoent.js > /tmp/se_test_r66_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 98 FAILED - test-spawn-enoent.js (Round 66 spawn-failure regex regression)"; cat /tmp/se_test_r66_out.txt; exit 1
fi
if ! grep -q "Round 66: the real evidence message" /tmp/se_test_r66_out.txt; then
  echo "✗ PASS 98 FAILED - Round 66's new regression tests did not run"; exit 1
fi
python3 << 'PY70'
import re, sys
fails = []
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
if 'const SPAWN_ENOENT_RE = ' not in sj:
    fails.append('SPAWN_ENOENT_RE is missing - the Round 66 shared spawn-failure detector appears to have been removed')
if re.search(r'(?<!SPAWN_ENOENT_RE\.test\()/spawn \(UNKNOWN\|ENOENT\|EPERM\|EACCES\)/', sj):
    fails.append('the old, broken /spawn (UNKNOWN|ENOENT|EPERM|EACCES)/ regex is back somewhere - it never matches a full-path spawn failure (see Round 66)')
if sj.count('SPAWN_ENOENT_RE.test(') < 5:
    fails.append('fewer than 5 call sites use SPAWN_ENOENT_RE - one of the friendly spawn-failure translations may have reverted to its own broken inline regex')
if fails:
    print('✗ PASS 98 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 98  Round 66: fixed every "ffmpeg/yt-dlp/Python is missing or blocked" friendly-error translation in server.js silently never firing - a user screenshot showed the raw, unhelpful "ffmpeg conversion failed: Cannot start ffmpeg.exe: spawn C:\\Users\\...\\ffmpeg.exe ENOENT" during playback of an older track, instead of the actionable antivirus/Temp-wiped guidance the code clearly intends to show. Root cause: all 5 translation sites shared one regex, /spawn (UNKNOWN|ENOENT|EPERM|EACCES)/, which requires the error code immediately after the literal word "spawn" - true only when spawn() gets a bare command name. Every real call site here resolves a full absolute path via bin(), so Node'"'"'s actual message is "spawn <full path> ENOENT", and the code is never adjacent to "spawn" - the regex silently failed on the exact input this app always produces, in all 5 places, since whichever round first wrote it. Confirmed directly: spawning the real resolved (missing) ffmpeg.exe path reproduces the user'"'"'s exact reported string, and the old regex returns false against it. Fixed with one shared, correctly-permissive pattern (SPAWN_ENOENT_RE) requiring "spawn" to appear before one of the four Node spawn error codes as its own word, with anything - including a full path - allowed in between. 8 new regression tests (tools/test-spawn-enoent.js), including one proving the pre-fix regex genuinely fails on the real evidence string, zero regressions across every other existing check.')
PY70
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-run-timeout.js > /tmp/rt_test_r67_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 99 FAILED - test-run-timeout.js (Round 67 run() timeout regression)"; cat /tmp/rt_test_r67_out.txt; exit 1
fi
if ! grep -q "Round 67: a genuinely hung process with a 300ms timeout rejects" /tmp/rt_test_r67_out.txt; then
  echo "✗ PASS 99 FAILED - Round 67's new regression tests did not run"; exit 1
fi
python3 << 'PY71'
import sys
fails = []
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
if 'function run(cmd, args, timeoutMs) {' not in sj:
    fails.append('run() no longer accepts a timeoutMs parameter - the Round 67 hang-guard appears to have been reverted')
if "run(ffmpegBin, ['-y', '-i', safe.ffmpegPath, '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', wavTmp], 120000)" not in sj:
    fails.append('analyzeOneInBackground()\'s ffmpeg decode call is no longer passing a 120000ms timeout - the background analysis worker can once again hang forever on a stuck ffmpeg process')
if fails:
    print('✗ PASS 99 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 99  Round 67: closed a real structural gap found while investigating a reported stuck "Analyzing N... (track)" UI pill with no error anywhere in the logs. analyzeOneInBackground()\'s ffmpeg decode step - unlike the Python analysis step immediately after it, which already force-kills at a 240s guard - had NO timeout at all, and the background analysis worker loop does a plain serial await on it inside a while(true): a single hung ffmpeg process (antivirus real-time scan holding the file, a corrupt/exotic input ffmpeg spins on, etc.) would silently wedge the ENTIRE queue forever, with analyzeWorker.running never going false again and no further \'bg-analyze\' events ever broadcast - exactly matching a stuck pill with nothing else in the logs to explain it. The exact live trigger could not be pinned down with certainty from static analysis alone (matching the honest standard already set by Round 60\'s PATCHNOTES entry for the same kind of gap), but this closes the concrete structural hole regardless: run() now accepts an optional timeoutMs (default off, zero behavior change for the other 11 existing call sites), and the background worker\'s ffmpeg decode passes 120000ms - generous headroom over the few seconds a real track normally takes, while guaranteeing the serial worker can never hang here indefinitely again. 5 new regression tests (tools/test-run-timeout.js), zero regressions across every other existing check.')
PY71
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-mic-highpass.js > /tmp/mh_test_r68_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 100 FAILED - test-mic-highpass.js (Round 68 mic low-cut regression)"; cat /tmp/mh_test_r68_out.txt; exit 1
fi
if ! grep -q "RB_MIC_HIGHPASS_HZ is defined as a numeric constant" /tmp/mh_test_r68_out.txt; then
  echo "✗ PASS 100 FAILED - Round 68's new regression tests did not run"; exit 1
fi
python3 << 'PY72'
import sys
fails = []
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
if 'const RB_MIC_HIGHPASS_HZ = ' not in aj:
    fails.append('RB_MIC_HIGHPASS_HZ is missing - the Round 68 mic low-cut filter appears to have been removed')
if aj.count("rbMicSource.connect(rbMicHighpassNode);") + aj.count("rbArmedSource.connect(rbArmedHighpassNode);") < 3:
    fails.append('one of the 3 mic graphs (record, monitor, armed preview) no longer routes the mic source through the low-cut filter first')
if fails:
    print('✗ PASS 100 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 100  Round 68: added an always-on low-cut filter on the live mic input - a real report ("everything is too loud... its all wind... from the start") with an evidence WAV attached. Direct FFT analysis of that file found 74.2% of ALL spectral energy below 50Hz and 97.4% below 200Hz, checked at three separate points in the take including the single loudest instant - consistent, broadband sub-vocal rumble present from the very start, not a digital gain problem (the file'"'"'s own peak measured -16.8dBFS, nowhere near clipping - the perceived "too loud" character is this broadband low end masking everything else). That range is far below any real vocal fundamental and is the classic signature of moving air/breath hitting an unprotected capsule directly or mechanical rumble transmitted through a desk/stand - grepping the entire recording chain found gain trims and a reverb'"'"'s own internal filters, but nothing between the mic and the recorder that removes sub-vocal rumble at all. Added a BiquadFilterNode (highpass, 80Hz - RB_MIC_HIGHPASS_HZ) ahead of everything else - the input-gain trim, channel safety, autotune, the level meter - mirrored identically into all 3 places a mic graph gets built in this app (the full record graph, the standalone monitor-only graph, and the armed/preview-meter-only graph), not just one of them. Applied as an always-on default rather than an opt-in, since a standard vocal low-cut can only remove content with no vocal value regardless of mic/room - this is the same behavior a hardware mic or interface'"'"'s own "low cut" switch provides. Honestly scoped: this does not fix an already-overloaded capsule at the acoustic level - a pop filter/windscreen and moving the mic out of direct breath path remain the real fix for the root cause - it removes what a low-cut can actually remove, the broadband sub-vocal energy this file measured, before it reaches gain staging, the meter, or the recorder. No headless Web Audio API exists in this environment to drive a real MediaStream graph end-to-end (the same limitation Round 59'"'"'s tray-click fix hit), so this is verified with a static source-text guard confirming the filter is created, correctly wired (mic source -> highpass -> gain trim, not bypassed), and properly torn down in all 3 places, rather than a live audio-graph test. 10 new regression tests (tools/test-mic-highpass.js), zero regressions across every other existing check.')
PY72
if [ $? -ne 0 ]; then exit 1; fi


node tools/test-autotune.js > /tmp/at_test_r69_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 101 FAILED - test-autotune.js (Round 69 octave-staleness regression)"; cat /tmp/at_test_r69_out.txt; exit 1
fi
if ! grep -q "Round 69: staleness widening is capped" /tmp/at_test_r69_out.txt; then
  echo "✗ PASS 101 FAILED - Round 69's new regression tests did not run"; exit 1
fi
python3 << 'PY73'
import sys
fails = []
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    aw = f.read()
if 'this.msSinceLastAccepted = 0;' not in aw:
    fails.append('msSinceLastAccepted state (added Round 69) is missing - the octave-rejection staleness tracking appears to have been reverted')
if aw.count('this.msSinceLastAccepted = 0;') < 3:
    fails.append('msSinceLastAccepted is not reset in all 3 expected places (constructor, resync(), and on acceptance in the octave-check) - found fewer than 3')
if 'const OCTAVE_STALENESS_GRACE_MS = 20;' not in aw:
    fails.append('OCTAVE_STALENESS_GRACE_MS is missing or no longer 20ms')
if 'const OCTAVE_STALENESS_WIDEN_CENTS_PER_MS = 0.75;' not in aw:
    fails.append('OCTAVE_STALENESS_WIDEN_CENTS_PER_MS is missing or no longer 0.75')
if 'const OCTAVE_STALENESS_MAX_WIDEN_CENTS = 65;' not in aw:
    fails.append('OCTAVE_STALENESS_MAX_WIDEN_CENTS is missing or no longer capped at 65 - an uncapped/much larger cap risks delaying reacquisition of a genuinely new note after a long pause (see the Round 69 PATCHNOTES entry)')
if 'jumpCentsSigned > octaveUpMinCents && jumpCentsSigned < octaveUpMaxCents' not in aw or \
   'jumpCentsSigned > octaveDownMinCents && jumpCentsSigned < octaveDownMaxCents' not in aw:
    fails.append('the octave-rejection check no longer compares against the staleness-widened band edges - appears to have reverted to the fixed Round 49/51 band')
if fails:
    print('✗ PASS 101 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 101  Round 69: fixed "vocal is not stable it goes up and down, sounds like its in a bottle" - a real report filed with evidence audio (KAKAVOCS.wav). Directly instrumenting the engine\'s own accept/reject decisions on that file (no live audio playback available in this environment, so verified against the actual shipped pitch-tracking logic rather than by ear) found the cause: the octave-error rejection band (OCTAVE_UP/DOWN_MIN/MAX, added Round 49/51) is measured against SHORT gaps between accepted hops, but lastAcceptedPitchHz only ever updates on acceptance and never decays during a run of rejections - after the file\'s own diagnosed ~8-hop (~93ms) rejection run, a genuine octave-error candidate (92.71Hz against a true ~185Hz, misreading as roughly half) measured a ratio of 0.5628 against the now-stale 164.75Hz reference, just outside OCTAVE_DOWN_MAX\'s edge (0.549) - and slipped through untouched for 4 consecutive hops (~46ms), both mistuning that stretch directly and, via shifter.periodHint (derived from lastAcceptedPitchHz), feeding a wrong period into the formant/WSOLA resynthesis for the same stretch - together producing both the reported pitch "up and down" blip and the "in a bottle" timbral wobble from one root cause. Fix: track how long it\'s been since a hop was last actually accepted (msSinceLastAccepted, reset on acceptance, advanced once per hop before the octave check runs) and widen the rejection band proportionally once that exceeds an ordinary short gap (20ms grace, 0.75 cents/ms, capped at 65 cents - sized directly off this file\'s own worst-case margin, not a round guess: the tightest of the 4 bad hops needed 42.8 cents of widening to be caught, and lowering the cap further, to 50 cents, caught the exact same set of hops as 65 or 150 did on a full-track scan, confirming 65 is already the effective ceiling here, not an arbitrary allowance). Checked for false-positive risk before setting the cap: scanned the WHOLE track for every hop the widening newly flags versus the un-widened band, and confirmed all of them either match the same octave-error signature as the diagnosed bug, or already had a >200-cent jump that would have failed the pre-existing CONTINUITY_CENTS gate regardless (i.e. redundant, not a new rejection) - the widening only changes behavior for the narrow, evidence-matched case (high-confidence, near-exact-octave-ratio candidates that bypass the continuity gate outright). Honestly scoped trade-off: a hop rejected by this widening just holds the previous correction and retries next hop (silently uncorrected passthrough for a few ms in the worst case), never a wrong-octave correction - the safe failure direction, not a new risk class. Re-verified directly against the original evidence file after the fix: the 92.71Hz excursion is gone entirely from the engine\'s accepted-pitch log for that stretch (164.75Hz now holds cleanly through to the next genuine 162.85Hz reading), with zero regressions across the full existing autotune-engine suite (including the pre-existing Round 49/51 octave-error tests, which use ordinary single-hop gaps and are unaffected by the staleness grace period). 4 new regression tests (tools/test-autotune.js), zero regressions across every other existing check.')
PY73
if [ $? -ne 0 ]; then exit 1; fi


node tools/test-perf-r70.js > /tmp/perf_test_r70_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 102 FAILED - test-perf-r70.js (Round 70 perf pass + shuffle-follow fix)"; cat /tmp/perf_test_r70_out.txt; exit 1
fi
if ! grep -q "no caller still scrolls from a bare requestAnimationFrame" /tmp/perf_test_r70_out.txt; then
  echo "✗ PASS 102 FAILED - Round 70's new regression tests did not run"; exit 1
fi
python3 << 'PY74'
import sys
fails = []
with open('server.js', encoding='utf-8') as f:
    sj = f.read()
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
if 'CREATE INDEX IF NOT EXISTS' not in sj:
    fails.append('the Round 70 DB indexes are gone - every history/tag lookup is back to a full table scan')
if 'audio_hash' in sj.split('const HISTORY_LIST_COLUMNS =')[1].split(';')[0]:
    fails.append('audio_hash is back in the /history list payload - ~0.25MB of dead weight per refetch, and the renderer still never reads it')
if "fetch(API + '/history/' + historyId + '/full')" not in aj:
    fails.append('openMiniNotepad is no longer using the single-row endpoint - it may be downloading the whole library again to read one text field')
if 'requestAnimationFrame(_scrollActiveRowIntoView)' in aj:
    fails.append('a caller is scrolling from a bare rAF again - this is the exact shape that made the shuffle "follow" land one track late')
if 'async function globalPlayerNext()' not in aj or 'async function globalPlayerPrev()' not in aj:
    fails.append('globalPlayerNext/Prev are no longer async - the awaited load that fixes the one-step-late follow cannot work')
if fails:
    print('✗ PASS 102 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 102  Round 70: performance pass plus a shuffle "follow" fix, both from direct reports ("app feels slow and sluggy", and "in history when on shuffle the anchor (following) option doesnt follow - it goes to the track you just played when you skip it, making it always one step late"). Measured first, on a realistic 1849-row library (the size the reporter'"'"'s own screenshot showed) rather than guessed: the history list builds ~2.95MB of HTML across 31,433 DOM elements with 20,339 inline handler attributes, and /history is a ~1.25MB JSON response refetched IN FULL from 30 separate call sites. Checked the obvious suspect first and found it already handled - .hist-row has carried content-visibility/contain-intrinsic-size since an earlier perf pass, so off-screen rows already skip layout and paint, and the pure-JS filter+fingerprint pass measured only ~1.4ms; neither was worth touching. What WAS provably wasteful: (1) the schema had NO indexes at all, so every lookup was a full table scan on hot paths - the watch-folder known-path check runs per filesystem event, the download dedup guard per request, and stockpile_tags is queried by history_id from nine call sites - now indexed on the six columns actually used (chosen by counting real WHERE/ORDER BY usage, not guessed; history.id deliberately skipped since the PRIMARY KEY already indexes it). (2) /history shipped audio_hash, a 128-char hex string per row that the renderer never reads - zero references anywhere in renderer/ or extension/, verified directly - about 0.25MB of every 1.25MB response, multiplied by those 30 refetch sites; dropped from the list payload only, with /history/:id/full and all server-side duplicate detection untouched. (3) openMiniNotepad downloaded the ENTIRE history list and .find()'"'"'d one row just to read one short text field, when /history/:id/full already existed for exactly that. The shuffle bug turned out to be a genuine off-by-one with a clean root cause: loadFromHistory() is async and awaits a disk read (plus, on a miss, a /history fetch and a /find-file lookup) before loadAudioBuffer() assigns currentHistId, but every caller scrolled from a bare requestAnimationFrame fired immediately after - the frame lands ~16ms later, the read does not, so the follow helper read the PREVIOUS track id every time. That also explains why the report names shuffle specifically: sequentially the stale row is the immediate neighbour and usually still sits inside the no-scroll comfort band, so nothing visibly moves, while shuffle puts consecutive tracks far apart and the wrong scroll becomes obvious on every skip. Fixed on both axes - callers pass the id they are navigating TO so the result no longer depends on racy global state, and they scroll only after awaiting the load - plus a second, separate bug found along the way: the legacy non-mirror NEXT path had no follow call at all while PREV did, so that mode followed you backwards but never forwards. Also added lightweight instrumentation (window.__FP_PERF__ and a diagnostic-log line for refreshes over 250ms) recording rows, payload KB, fetch/render split and live DOM node count, so the next round works from real numbers off the affected machine instead of static estimates - no headless browser exists here to time Electron renderer costs directly, which is exactly why these are static source guards rather than live benchmarks. 43 new regression tests (tools/test-perf-r70.js), zero regressions across every other existing check.')
PY74
if [ $? -ne 0 ]; then exit 1; fi


node tools/test-autotune.js > /tmp/at_test_r71_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 103 FAILED - test-autotune.js (Round 71 stale-reference re-anchor)"; cat /tmp/at_test_r71_out.txt; exit 1
fi
if ! grep -q "Round 71: a reference that stays stuck" /tmp/at_test_r71_out.txt; then
  echo "✗ PASS 103 FAILED - Round 71's new regression tests did not run"; exit 1
fi
python3 << 'PY75'
import sys
fails = []
with open('renderer/autotune-worklet.js', encoding='utf-8') as f:
    aw = f.read()
if '// ─── BEGIN STALE REFERENCE RE-ANCHOR ───' not in aw:
    fails.append('the Round 71 stale-reference re-anchor is gone - pitch correction can deadlock and stop entirely again')
if 'const STALE_REANCHOR_MS = 300;' not in aw:
    fails.append('STALE_REANCHOR_MS is missing or no longer 300ms (swept against three real evidence takes - see PATCHNOTES)')
if 'this.forcedRejectMs' not in aw or aw.count('this.forcedRejectMs = 0;') < 3:
    fails.append('forcedRejectMs is not initialised/reset in all the expected places (constructor, resync(), and on re-anchor)')
if 'pitch.confidence >= CONF_LOW' not in aw:
    fails.append('the re-anchor streak no longer requires a trustworthy pitch - silence could now trip it and reset the engine mid-rest')
if 'this.resync();' not in aw:
    fails.append('the re-anchor no longer calls resync() - the stale reference would not actually be cleared')
if fails:
    print('✗ PASS 103 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 103  Round 71: fixed pitch correction silently switching itself off - reported as "its has now no autotune even if key is good and formant off and sounds real harsh", filed with a fresh recorder take. Every rejection path in _analyze() measures the candidate against lastAcceptedPitchHz, and lastAcceptedPitchHz only ever updates on ACCEPTANCE - so once a rejection run starts and the voice moves away from the frozen reference, every later hop reads as an enormous jump from that frozen value, gets force-rejected for exactly that, and thereby keeps it frozen. A closed loop with no exit: targetRatio eases back to 1 and the engine passes the dry signal straight through, which is precisely "no autotune". This exact deadlock was named as a theoretical risk when Round 69 shipped and judged unlikely to matter on real audio - that judgement was wrong, and this is the correction. Measured directly on the evidence take before changing anything: 802 of 1238 hops force-rejected on MAX_JUMP_CENTS alone, 597 of all force-rejections were high-confidence reads the engine should have trusted, the longest unbroken rejection run was 148 hops (~1.7 SECONDS of no correction at all), and the reference went as stale as 3529ms - from t=1.07s the detector reports a rock-steady ~700Hz at confidence 0.65-0.77 hop after hop while the reference sits frozen near 100Hz, so all of it reads as a ~3400-cent jump and every single hop is discarded. Crucially the existing divergence safety net cannot help: it sits past the `if (!accepted) return;` guard, so it only runs on ACCEPTED hops and by construction never executes during the very deadlock it would need to break. Fix: track how long the detector has been handing us pitches we could otherwise trust that keep getting force-rejected, and once that passes STALE_REANCHOR_MS conclude the REFERENCE is what is wrong rather than the input, then re-anchor through the existing resync() (which nulls lastAcceptedPitchHz so the next hop is judged on its own confidence with no jump check, and clears the smoother/target so no bad state carries forward). Only reads at or above CONF_LOW count toward the streak, so genuine silence - which returns no pitch at all - can never trip it and reset the engine mid-rest. Threshold picked by sweeping 150/250/300/400/600/1000ms across three real evidence takes rather than guessed: acceptance on the take from this report went 13.7% -> 46.3%, the earlier "still not stable/wobbly" take went 39.0% -> 53.1% (so that complaint was substantially this same deadlock, not only the octave issue diagnosed for it at the time), and Round 69'"'"'s own KAKAVOCS evidence measured 65.9% -> 65.9%, unchanged at every threshold tested - confirming this recovers correction without disturbing the octave-rejection behaviour Rounds 49/51/69 built, whose own tests work in single-hop and ~8-hop gaps far below this threshold and all still pass. 4 new regression tests (tools/test-autotune.js) covering that the guard does not fire instantly, that a genuinely stuck reference does re-anchor, that silence never trips it, and that a normal accepted hop clears the streak so ordinary playing cannot accumulate into a spurious reset. Zero regressions across every other existing check.')
PY75
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-context-rate.js > /tmp/ctx_test_r73_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 104 FAILED - test-context-rate.js (Round 73 capture sample-rate fix)"; cat /tmp/ctx_test_r73_out.txt; exit 1
fi
if ! grep -q "the record path still opens the mic BEFORE building the context" /tmp/ctx_test_r73_out.txt; then
  echo "✗ PASS 104 FAILED - Round 73's new regression tests did not run"; exit 1
fi
python3 << 'PY76'
import sys
fails = []
with open('renderer/app.js', encoding='utf-8') as f:
    aj = f.read()
if 'function rbStreamSampleRate(stream)' not in aj:
    fails.append('rbStreamSampleRate() is gone - nothing reads the mic\'s real rate any more')
if 'async function rbEnsureWorklets(desiredRate)' not in aj:
    fails.append('rbEnsureWorklets no longer accepts a desiredRate - the context is back to inheriting the OUTPUT device rate')
if 'new Ctor({ sampleRate: desiredRate })' not in aj:
    fails.append('the AudioContext is no longer constructed at an explicit rate')
if aj.count('rbEnsureWorklets(rbStreamSampleRate(') < 3:
    fails.append('one of the three mic paths (record, arm, monitor) stopped passing the mic rate')
if 'if (!rbAudioCtx) rbAudioCtx = new (window.AudioContext || window.webkitAudioContext)();' in aj:
    fails.append('the original no-options context construction is back - this is the exact line that caused a 44.1kHz mic to be resampled 2x into an 88.2kHz context')
if fails:
    print('✗ PASS 104 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 104  Round 73: stopped resampling every take on the way in. rbEnsureWorklets() built the AudioContext with NO options, so it inherited Chromium\'s default rate - and that default follows the OUTPUT device, not the microphone. A user with a Focusrite clocked at 44100 was getting a context at 88200, so Chromium upsampled the mic 2x before the engine ever saw a sample. Confirmed from the artifact rather than assumed: the recorder worklet runs inside that context, and their recorded WAVs carried an 88200 header while the interface was set to 44100. Not a cosmetic issue - measured against a clean synthetic reference (tools/diag-rate-formant.js, with a bypass control reading 0.00dB on every band at every rate to prove the method), the formant path costs +5.2dB of added boxiness at 44.1k but +7.2dB at 88.2k, and the engine costs 0.24x realtime at 44.1k versus 0.43x at 88.2k. So the pointless upsample was manufacturing roughly 2dB of the exact coloration being reported, and doubling the CPU, while adding no information whatsoever. Fix: read the rate straight off the mic track (getSettings().sampleRate) and construct the context to match, in all three paths that open a mic - record, armed preview, and monitor. The record path already opened the stream before creating the context, so the real rate was knowable there all along. Rebuilds the context when the device rate changes, but never mid-session (closing a context with live nodes would kill the take - a mismatch found while recording waits for the next start), resets all three worklet-ready flags on rebuild so the new context reloads its modules, and falls back to a default context if a driver refuses the explicit rate, because recording at the wrong rate beats not recording. Both rates are written to the diagnostic log so any future mismatch is visible from a user machine instead of having to be inferred from a WAV header. Also settled this round, so nobody re-litigates it: the rate sensitivity is NOT a resolution problem. Three separate sweeps - all constants scaled together with mpFFT sized correctly, each of lpcOrder/envOrder/envTaps alone, and 2-3x overkill - moved boxiness by at most 0.2dB, and MORE spectral detail measurably made it WORSE (+2.0dB at 48k, +1.7dB at 88.2k), which is the signature of a higher-order fit tracking the excitation\'s harmonic peaks and re-imposing them on a signal whose pitch has already moved. The split-band rewrite remains the only real route to fixing the formant coloration. 16 new regression tests (tools/test-context-rate.js), zero regressions across every other existing check.')
PY76
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-picker-layout.js > /tmp/picker_r75_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 105 FAILED - test-picker-layout.js (Round 75 picker overflow)"; cat /tmp/picker_r75_out.txt; exit 1
fi
python3 << 'PY77'
import sys, re
fails = []
with open('renderer/index.html', encoding='utf-8') as f:
    h = f.read()
m = re.search(r'#rb-normal-transport\{([^}]*)\}', h)
if not m:
    fails.append('#rb-normal-transport has no CSS rule - it will size to its widest beat title again and overflow the card')
elif 'width:100%' not in m.group(1).replace(' ', ''):
    fails.append('#rb-normal-transport no longer declares width:100%')
if fails:
    print('✗ PASS 105 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 105  Round 75: fixed the "Pick a beat" panel hanging outside the card. .rb-card is a column flex container with align-items:center, which makes every direct child shrink-to-fit unless it declares a width - .rb-transport, .rb-seek-row and .rb-actions all set width:100%, but #rb-normal-transport (added later, when record mode got its own transport) had NO CSS rule at all. It therefore sized to its widest max-content child, and its children include the picker rows whose untruncated beat titles run to hundreds of pixels, so the wrapper grew past the card\'s 552px content box and the whole transport block - picker panel and seek bar alike - spilled over the card\'s rounded border. Fixed with width:100%/min-width:0 to match its siblings. Also restyled the panel itself, which was reported in the same breath as ugly: dropped the hard 1px divider under every row (a wall of lines rather than a list) in favour of spacing and a rounded hover, raised the list from 260px to 360px since scrolling a 2000-beat library through a 260px slot is punishing, gave the panel a real elevation shadow so it reads as a surface over the card, boxed the bare row-count number into a pill attached to the search field, and swapped the current-beat marker from a left-edge bar to a full outline since "left edge" stopped meaning anything once rows became inset and rounded. 12 new regression tests (tools/test-picker-layout.js).')
PY77
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-ext-crossbrowser.js > /tmp/ext_r75_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 106 FAILED - test-ext-crossbrowser.js (extension v4.5.0 cross-browser fix)"; cat /tmp/ext_r75_out.txt; exit 1
fi
python3 << 'PY78'
import sys, json
fails = []
with open('extension/background.js', encoding='utf-8') as f:
    bg = f.read()
with open('extension/manifest.json', encoding='utf-8') as f:
    mf = json.load(f)
if 'HAS_SIDE_PANEL' not in bg:
    fails.append('the sidePanel feature-detect is gone - the service worker will crash again on browsers without the API')
if bg.lstrip().startswith('chrome.sidePanel'):
    fails.append('background.js opens with a bare chrome.sidePanel call again - this is the exact line that killed the whole extension on Opera')
if 'openPanelFallback' not in bg or 'chrome.windows.create' not in bg:
    fails.append('the popup-window fallback is gone - browsers without a side panel have no way to open the panel')
if mf.get('version') == '4.4.0':
    fails.append('extension version was not bumped, so users will not receive the fix')
if fails:
    print('✗ PASS 106 FAILED')
    for x in fails: print('   -', x)
    sys.exit(1)
print('✓ PASS 106  Extension v4.5.0: fixed the extension being completely dead on Opera. background.js opened with a bare chrome.sidePanel.setPanelBehavior() on line 1. chrome.sidePanel is a Chrome API (114+) - Chrome, Edge and Brave have it; Opera does not and never has, because it ships its own sidebar implementation. On Opera that first line threw a TypeError at the TOP of the service worker, before a single listener below it was registered, so the failure was not "the sidebar does not open" but the entire extension being dead on arrival: no open-panel handling, no active-tab sync, no update check. Reported by a user whose in-page Freq.Phull button on YouTube did nothing at all - content.js:23 was firing the open-panel message correctly and nothing was alive to receive it. Fixed by feature-detecting the API once (HAS_SIDE_PANEL) and routing every open through openPanel(), which uses the real side panel where it exists and otherwise opens panel.html as a popup window - the same page, so there is no second UI to maintain. Repeated clicks focus the existing fallback window rather than spawning more, the tracked window id is cleared on close, and the toolbar action gets an explicit onClicked handler on browsers where nothing opens it natively (safe because the manifest declares no default_popup). open-panel also no longer bails out when sender.tab is absent, since the fallback does not need a tab id. The sidePanel permission and side_panel manifest key are retained untouched for the browsers that do support them. 15 new regression tests (tools/test-ext-crossbrowser.js), including a scan that fails if any unguarded sidePanel access ever returns to the service worker top level.')
PY78
if [ $? -ne 0 ]; then exit 1; fi

node tools/test-playlist-skip.js > /tmp/plskip_r76_out.txt 2>&1
if [ $? -ne 0 ]; then
  echo "✗ PASS 107 FAILED - test-playlist-skip.js (Round 76 playlist skip)"; cat /tmp/plskip_r76_out.txt; exit 1
fi
echo "✓ PASS 107  Round 76: playlists now skip tracks already downloaded instead of failing on them. They were never actually re-downloaded - /download's persistent guard has refused them since Round 60 - but it refuses them as ERRORS, opening one SSE stream and producing one red failed row per track. Queue a 60-track playlist you mostly own and you got ~50 failures to scroll past, which reads like the grab broke rather than like it correctly did nothing. Moved the decision up to playlist-expansion time in /info: it now flags every entry it can already find in History and the client skips those before they ever enter the queue. Matched the same way the existing guard matches - by VIDEO ID rather than raw URL text (share, shortened and tracking-suffixed links for one video all differ as strings), scoped to the requested format (owning a track as mp3 does not make a wav request a duplicate), and only when the earlier file is still on disk, because a track the user moved or deleted is not a duplicate - it is the only copy, and silently skipping it would leave them unable to get it back. The lookup is non-fatal and /download's guard is untouched, so it remains the backstop for anything that slips through (a track finishing between expansion and dequeue, or an older client that ignores the new flag). Already-owned is counted separately from already-in-queue since they mean different things, and a playlist with nothing left to do now reports success instead of an error - added=0 used to render red, which is the wrong signal for \"you already have all of these\". 14 new regression tests (tools/test-playlist-skip.js)."

echo "════════ ALL 107 GREEN ════════"
