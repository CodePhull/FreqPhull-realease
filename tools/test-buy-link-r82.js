// Round 82: "Buy this beat" and "About the beatmaker".
//
// Producers put a purchase link (BeatStars, Airbit, their own store) and
// their socials in the YouTube description. BUY LINK CORE (server.js) finds
// them; the right-click menu sends people to buy the beat and credit the
// producer. Measured while building it on real "type beat" descriptions
// (metadata only): a purchase link on 21 of 24 videos after the fixes
// below (the other 3 have no store link at all), first pass 30/32.
// Things the real descriptions taught it, each a case below: air.bi is
// Airbit; wa.me is a contact, not a store; a producer's own site with no
// "buy" word (zdanbeats.com for "Zdan Beats"); YouTube /@name/join links;
// shorteners (bit.ly, pin.it) can point anywhere.
//
// Run:  node tools/test-buy-link-r82.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const si = src.indexOf('// ─── BEGIN BUY LINK CORE ───');
const ei = src.indexOf('// ─── END BUY LINK CORE ───');
if (si < 0 || ei < 0) throw new Error('BUY LINK CORE markers not found');
const sb = { URL, String, decodeURIComponent };
vm.createContext(sb);
vm.runInContext(src.slice(si, ei) + '\nthis.f = { findBuyLink, findProducerLinks };', sb);
const { findBuyLink, findProducerLinks } = sb.f;
const H = 'https:' + '//';   // (kept out of string literals: tools/xref.py strips from "//")
const buy = (d, ch) => { const r = findBuyLink(d, ch); return r ? r.url : null; };

// ── Purchase link ──
check('BeatStars short link on a "Purchase" line',
  buy('🎹 Purchase this beat (Instant Delivery): ' + H + 'bsta.rs/yLbgDi\n📸 Instagram: ' + H + 'instagram.com/prod.x') === H + 'bsta.rs/yLbgDi');
check('French "Acheter" line, producer\'s own store',
  buy('💰 Acheter / Lease : ' + H + 'mawsbeats.fr/\nInsta : ' + H + 'instagram.com/mawsbeats') === H + 'mawsbeats.fr/');
check('a store link wins over a social link that comes first',
  buy('Follow ' + H + 'instagram.com/abc\nBeats: ' + H + 'www.beatstars.com/theskybeats/') === H + 'www.beatstars.com/theskybeats/');
check('a store on a "buy" line wins over a bare store link above it',
  buy(H + 'abc.beatstars.com\nBUY THIS BEAT -> ' + H + 'bsta.rs/FIsFIQ') === H + 'bsta.rs/FIsFIQ');
check('Airbit short link (air.bi) counts as a store', buy('Beat: ' + H + 'air.bi/waRQA') === H + 'air.bi/waRQA');
check('a site named after the channel, no "buy" word (zdanbeats.com)',
  buy('More beats ' + H + 'zdanbeats.com', 'Zdan Beats') === H + 'zdanbeats.com');
check('...but not without the channel name', buy('More beats ' + H + 'zdanbeats.com') === null);
check('WhatsApp is a contact, never a store', buy('Buy / contact: ' + H + 'wa.me/5511999999999') === null);
check('a shortener is never trusted as a store', buy('BUY: ' + H + 'bit.ly/3xyz') === null);
check('YouTube links are never stores', buy('Buy my beats: ' + H + 'youtube.com/watch?v=abc') === null);
check('www. without a scheme is understood', buy('Purchase: www.prodbyx.com/beats') === H + 'www.prodbyx.com/beats');
check('trailing punctuation is trimmed', buy('Lease it here: ' + H + 'bsta.rs/abc123).') === H + 'bsta.rs/abc123');
check('no links -> null', buy('Free for non-profit use. Credit me!') === null);
check('a javascript: or other scheme is never returned', buy('buy javascript:alert(1) ftp' + ':' + '//x.com/a') === null);

// ── Producer links (About) ──
const pl = findProducerLinks([
  'Purchase: ' + H + 'bsta.rs/PeYkz5',
  'Instagram: ' + H + 'instagram.com/isombrebeats',
  'Post: ' + H + 'instagram.com/p/C123/',
  'Spotify: ' + H + 'open.spotify.com/artist/4ZO6NXYyrCBgqW4ZMo09HW',
  'Join: ' + H + 'www.youtube.com/@sombrebeats/join',
  'Video: ' + H + 'youtube.com/watch?v=abc',
  'Pin: ' + H + 'pin.it/xyz',
  'Site: ' + H + 'sombrebeats.com',
  'Bare: ' + H + 'instagram.com/',
  'Biz: contact.sombre@gmail.com',
].join('\n'), 'Sombre Beats');
const kinds = pl.socials.map((s) => s.kind + ':' + s.handle);
check('About lists the profiles', kinds.includes('Instagram:isombrebeats') && kinds.includes('Spotify:4ZO6NXYyrCBgqW4ZMo09HW') && kinds.includes('YouTube:@sombrebeats'), kinds.join(', '));
check('...a channel "join" link reads as the channel, not "join"', !kinds.some((k) => /join$/.test(k)));
check('...not posts, videos, shorteners or bare front pages', pl.socials.length === 4, kinds.join(', '));
check('...the producer\'s own site, not the buy link\'s', kinds.includes('Website:sombrebeats.com') && !kinds.some((k) => k.includes('bsta.rs')));
check('...and the business e-mail', pl.email === 'contact.sombre@gmail.com');
check('...with the purchase link alongside', pl.buy === H + 'bsta.rs/PeYkz5');

// The user's report (Prod Regi, "GUESS WHO'S BACK"): About showed only the
// YouTube channel - "Instagram: @imregii" has no link, and the store is on a
// subdomain (prodregi.beatstars.com). Description copied from the video.
const regi = findProducerLinks([
  '• 🌐 Buy this beat : ' + H + 'bsta.rs/WTBT7c',
  'Key of the beat : Cm 130 Bpm',
  '• 🔥 Motivate me: ' + H + 'www.youtube.com/c/ProdRegi?sub_confirmation=1',
  '• 💸 Beat Store:',
  H + 'prodregi.beatstars.com/',
  '• Contact me here 👇🏽',
  '• 📷 Instagram: @imregii',
  '• 📧 Email: Regiiprod@gmail.com',
  'FREE Tory Lanez x Drake Type Beat "GUESS WHO\'S BACK"  @imregii',
].join('\n'), 'Prod Regi');
const rk = regi.socials.map((s) => s.kind + ':' + s.handle);
check('Prod Regi: YouTube, BeatStars store and Instagram all listed', rk.join(',') === 'YouTube:ProdRegi,BeatStars:prodregi,Instagram:imregii', rk.join(', '));
check('...the Instagram handle becomes its profile link', regi.socials[2].url === H + 'www.instagram.com/imregii/');
check('...e-mail and purchase link kept', regi.email === 'Regiiprod@gmail.com' && regi.buy === H + 'bsta.rs/WTBT7c');
const hs = (d) => findProducerLinks(d, '').socials.map((s) => s.kind + ':' + s.handle).join(',');
check('handle on the line after the label (measured: Dibi)', hs('Contact:\n📷   Instagram: \nprodbydibi\n\n📨 mail') === 'Instagram:prodbydibi');
check('Insta / IG / TikTok / Snap / Twitter labels', hs('Insta: aa.bb\nTikTok - @cc\nSnap: dd_ee\nTwitter: @ff') === 'Instagram:aa.bb,TikTok:@cc,Snapchat:dd_ee,X:ff');
check('"x" meaning featuring is not X (measured: "prod by amour x @skripinho")', hs('prod by amour x @skripinho') === '');
check('...but "X: @name" is', hs('X: @someprod') === 'X:someprod');
check('an e-mail or link after the label is not a handle', hs('Instagram: me@gmail.com\nIG: ' + H + 'instagram.com/realone') === 'Instagram:realone');
check('a written handle and its link are listed once', hs('Instagram: @same\n' + H + 'instagram.com/same') === 'Instagram:same');
check('prose is not a handle', hs('Follow me on Instagram for more beats\nIG post below') === '');
check('a BeatStars beat page on a subdomain is not the store', hs(H + 'sfv.beatstars.com/beat/n-faste-19578481') === '');
check('zero-width character after a link is cut off (measured)', hs(H + 'sfv.beatstars.com​') === 'BeatStars:sfv');
check('tracks looked up by the first version are looked up again',
  src.includes('const PRODUCER_LINKS_VERSION = 2;') && /\(links\.v \|\| 1\) < PRODUCER_LINKS_VERSION/.test(src) && (src.match(/v: PRODUCER_LINKS_VERSION/g) || []).length === 2);
check('...and a failed new lookup still shows the old one', /if \(links\) return reply\(row\.buy_url, links, true\);/.test(src));

// ── Wiring ──
check('downloads store both (buy_url + producer_links)', src.includes('INSERT INTO history (title,channel,youtube_url,file_path,format,duration,thumbnail,buy_url,producer_links)'));
check('older tracks are looked up once and remembered', src.includes("app.get('/history/:id/producer'") && src.includes("dbRun('UPDATE history SET buy_url=?, producer_links=? WHERE id=?'"));
check('a failed lookup is not remembered as "no link"', /catch \(e\) \{\s*\/\/ Not remembered/.test(src));
check('the list carries buy_url for the menu', /HISTORY_LIST_COLUMNS =[\s\S]{0,300}buy_url'/.test(src));
const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
check('right-click menu has Buy this beat and About the beatmaker', app.includes("t('ctxBuyBeat')") && app.includes("act: () => openProducerAbout(id)"));
const ox = app.slice(app.indexOf('function openExternalLink('), app.indexOf('function openExternalLink(') + 300);
check('links open only as http(s), in the system browser', ox.includes("if (u.protocol !== 'https:' && u.protocol !== 'http:') return;") && ox.includes("window.open(u.href, '_blank', 'noopener')"));
const about = app.slice(app.indexOf('async function openProducerAbout('), app.indexOf('async function openProducerAbout(') + 5000);
check('About never puts a link into the page: buttons look actions up by index', about.includes('data-pa="${actions.length - 1}"') && !/href=/.test(about));
const mj = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
check('main.js hands window.open to the system browser, http(s) only', /setWindowOpenHandler\(\(\{ url \}\) => \{ toBrowser\(url\); return \{ action: 'deny' \}; \}\)/.test(mj) && mj.includes('/^https?:\\/\\//i.test(url)'));
for (const key of ['ctxBuyBeat', 'ctxAboutProducer', 'buyNone', 'aboutTitle', 'aboutNote', 'aboutCopyCredit']) {
  const n = (app.match(new RegExp('\\n\\s+' + key + ":'", 'g')) || []).length;
  check('label ' + key + ' in English and French', n === 2, n + ' found');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
process.exit(fails ? 1 : 0);
