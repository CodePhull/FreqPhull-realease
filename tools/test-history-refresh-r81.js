// Round 81: 'history-changed' events each triggered a full /history fetch
// (~1.15 MB, 2,248 rows on the developer's library) with nothing merging
// them. Extracts the HISTORY REFRESH COALESCE region from renderer/app.js
// with vm and drives it with a fake fetch whose latency we control.
//
// Sanity gate: the pre-Round-81 handler (one fetch per event) is run on
// the same bursts and must FAIL the same bars.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const si = src.indexOf('// ─── BEGIN HISTORY REFRESH COALESCE ───');
const ei = src.indexOf('// ─── END HISTORY REFRESH COALESCE ───');
if (si < 0 || ei < 0) throw new Error('HISTORY REFRESH COALESCE markers not found');
const region = src.slice(si, ei);

let fails = 0;
function check(name, cond, detail) {
  if (cond) console.log('  ok   ' + name + (detail ? '  (' + detail + ')' : ''));
  else { fails++; console.log('  FAIL ' + name + (detail ? '  (' + detail + ')' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeEnv(fetchMs) {
  const env = { fetches: 0, renders: 0, version: 0, lastRendered: -1 };
  const sb = {
    setTimeout, clearTimeout, API: 'http://x', histData: null,
    fetch: async () => {
      env.fetches++;
      const v = env.version;               // snapshot of server state at request time
      await sleep(fetchMs);
      return { json: async () => ({ v }) };
    },
    renderHistory: () => { env.renders++; env.lastRendered = sb.histData.v; },
  };
  vm.createContext(sb);
  vm.runInContext(region + '\nthis.__fire = requestHistoryRefresh;', sb);
  env.fire = () => sb.__fire();
  return env;
}
function makeLegacy(fetchMs) {
  const env = { fetches: 0, renders: 0, version: 0, lastRendered: -1 };
  env.fire = async () => {
    env.fetches++; const v = env.version; await sleep(fetchMs);
    env.renders++; env.lastRendered = v;
  };
  return env;
}

async function burst(env, n, gapMs) {
  for (let i = 0; i < n; i++) { env.version++; env.fire(); if (gapMs) await sleep(gapMs); }
}

(async () => {
  // Case A: one download's worth of events arriving together.
  for (const [label, mk] of [['new', makeEnv], ['legacy', makeLegacy]]) {
    const e = mk(60);
    await burst(e, 4, 0);
    await sleep(600);
    const pass = e.fetches === 1 && e.lastRendered === e.version;
    if (label === 'new') check('4 events at once -> 1 fetch, showing the latest state', pass, e.fetches + ' fetch(es), rendered v' + e.lastRendered + '/' + e.version);
    else check('  sanity gate: legacy handler FAILS that bar', !pass, e.fetches + ' fetch(es)');
  }
  // Case B: events keep arriving while a slow fetch is in flight.
  for (const [label, mk] of [['new', makeEnv], ['legacy', makeLegacy]]) {
    const e = mk(400);
    e.version++; e.fire();
    await sleep(300);                      // first fetch now in flight
    await burst(e, 10, 10);
    await sleep(1500);
    const pass = e.fetches === 2 && e.lastRendered === e.version;
    if (label === 'new') check('10 events during an in-flight fetch -> exactly 1 follow-up fetch, final state current', pass, e.fetches + ' fetch(es), rendered v' + e.lastRendered + '/' + e.version);
    else check('  sanity gate: legacy handler FAILS that bar', !pass, e.fetches + ' fetch(es)');
  }
  // Case C: separate events far apart still each refresh (no lost updates).
  {
    const e = makeEnv(30);
    for (let i = 0; i < 3; i++) { e.version++; e.fire(); await sleep(400); }
    check('events spaced apart each get their own refresh', e.fetches === 3 && e.lastRendered === e.version, e.fetches + ' fetch(es)');
  }
  // Wiring: the SSE listener goes through the coalescer.
  check("'history-changed' listener calls requestHistoryRefresh()",
    /addEventListener\('history-changed',[\s\S]{0,400}requestHistoryRefresh\(\)/.test(src));

  console.log(fails ? '\n' + fails + ' FAILED' : '\nall passed');
  process.exit(fails ? 1 : 0);
})();
