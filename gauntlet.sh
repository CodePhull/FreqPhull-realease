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
echo "════════ ALL 7 GREEN ════════"
