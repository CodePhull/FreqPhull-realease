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
    print('\u2717 PASS 20 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
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
    print('\u2717 PASS 20 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('\u2713 PASS 20  no function trapped in a block, no let read before declaration')
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
    print('\u2717 PASS 21 FAILED'); [print('   -', x) for x in fails]; sys.exit(1)
print('\u2713 PASS 21  installer wizard is enabled with valid NSIS artwork')
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
    print('\u2717 PASS 22 FAILED - duplicate keys, the last one silently wins:')
    for f in fails: print('   -', f)
    sys.exit(1)
print('\u2713 PASS 22  no translation key is defined twice')
PY
echo "════════ ALL 22 GREEN ════════"
