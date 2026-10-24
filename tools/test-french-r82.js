// Round 82: "do a full check of french translations".
//
// Measured in the real app with the language set to French (hidden copy,
// every tab, Settings expanded, right-click menu, hidden panels included):
// 217 strings were still English - the whole Convert tab, most of Transcribe,
// Tools, Slow + Reverb, History filters, key names ("A minor"), tooltips and
// screen-reader labels - plus 43 pop-up messages written as English
// literals. The French itself had missing accents ("Bibliotheque",
// "Confidentialite", "A propos", "Demarrer", "Envoyer a la transcription"),
// "Engagés" for "committed", "mood" left in English, "communique avec sur".
// After the fixes the same scan finds none (7 hits, all French words with an
// apostrophe, plus the product name "Artist Edition").
//
// Run:  node tools/test-french-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}

// T, extracted with the same brace walk the app's own loader would need.
const s = app.indexOf('const T = {');
let depth = 0, i = app.indexOf('{', s), e = -1;
for (let k = i; k < app.length; k++) {
  const c = app[k];
  if (c === "'" || c === '"' || c === '`') { const q = c; k++; while (k < app.length && app[k] !== q) { if (app[k] === '\\') k++; k++; } continue; }
  if (c === '/' && app[k + 1] === '/') { while (app[k] !== '\n') k++; continue; }
  if (c === '{') depth++;
  else if (c === '}') { depth--; if (depth === 0) { e = k + 1; break; } }
}
const sb = {};
vm.createContext(sb);
vm.runInContext('this.T=' + app.slice(i, e), sb);
const { en, fr } = sb.T;

check('same keys in English and French', Object.keys(en).length === Object.keys(fr).length && Object.keys(en).every((k) => k in fr), Object.keys(en).length + ' keys');

// Every key the page asks for exists in both languages.
const used = new Set();
for (const m of html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)) used.add(m[1]);
const missing = [...used].filter((k) => !(k in en) || !(k in fr));
check('every data-i18n key on the page exists (text, tooltip, label, placeholder)', missing.length === 0 && used.size > 250, used.size + ' keys used' + (missing.length ? ', missing: ' + missing.join(',') : ''));
check('tooltips, labels and placeholders are applied on a language change',
  /\[\['data-i18n-title', 'title'\], \['data-i18n-aria', 'aria-label'\], \['data-i18n-ph', 'placeholder'\]\]/.test(app));
check('Convert and Slow + Reverb in the menu are translated', /slowverb:'navSlowverb',convert:'navConvert'/.test(app));

// No pop-up message written as an English literal.
const literalToasts = (app.match(/showAppNotification\(\s*['"`][A-Z][a-z]+ [a-z]/g) || []).length;
check('no pop-up message is an English literal', literalToasts === 0, literalToasts + ' found (43 before)');

// Key names follow the language.
check('keys show "mineur"/"majeur" in French (11 places)', (app.match(/modeLabel\(/g) || []).length >= 12 && !/key_mode \|\| ''|key_mode\|\|''/.test(app));
check('...the words exist', en.uiModeMinor === 'minor' && fr.uiModeMinor === 'mineur' && fr.uiModeMajor === 'majeur');

// Convert tab code has no English left in what it displays.
const cs = app.indexOf('function convFormatChanged(');
const ce = app.indexOf('// Load the format list the first time the tab is opened');
const conv = app.slice(cs, ce);
check('Convert tab: no English literals in labels, notes, statuses or summary',
  !/'(Bitrate|Bit depth|Queued|Failed|Done · show|Conversion failed|Cancel|Convert)'/.test(conv) && !/ converted'/.test(conv) && conv.includes("t('convSummary')"));

// The French text itself: things that were wrong must not come back.
const frText = Object.values(fr).filter((v) => typeof v === 'string').join('\n');
const BAD = [/Bibliotheque/, /Confidentialite/, /\bA propos\b/, /Demarrer/, /Envoyer a la/, /etiquetage/, /\bcredits\b/, /Acceleration/,
  /Detection des/, /Decodage/, /\bMeme\b/, /trouvee\b/, /est casse\b/, /Reparation/, /Reparer/, /Rien a /, /defilement/, /Epinglez/,
  /non empaquetee/, /base sur Chromium/, /communique avec sur/, /\bdu mood\b/, /Engagés/, /\ba faire\b/, /Le toggle/];
const found = BAD.filter((re) => re.test(frText)).map((re) => re.source);
check('no missing accents or wrong words that were fixed', found.length === 0, found.join(', '));
check('"mood" is "ambiance" in French', fr.simReason_mood === 'ambiance');
const tripleDots = Object.entries(fr).filter(([, v]) => typeof v === 'string' && /\.\.\./.test(v)).map(([k]) => k);
check('French uses the … character, not three dots', tripleDots.length === 0, tripleDots.join(','));
// French puts a space before : ; ? ! (only checked where a letter touches it)
const tight = Object.entries(fr).filter(([, v]) => typeof v === 'string' && /[A-Za-zÀ-ÿ»)](\?|!|;)(\s|$)|[A-Za-zÀ-ÿ»)]:(\s|$)/.test(v.replace(/<[^>]+>/g, '').replace(/https?:\/\/\S+/g, ''))).map(([k]) => k);
check('French spacing before : ; ? !', tight.length === 0, tight.join(','));
// Guillemets get their spaces too.
const quotes = Object.entries(fr).filter(([, v]) => typeof v === 'string' && /«\S|\S»/.test(v)).map(([k]) => k);
check('« » with spaces inside', quotes.length === 0, quotes.join(','));

console.log(fails ? '\n' + fails + ' FAILED' : '\nall French checks passed');
process.exit(fails ? 1 : 0);
