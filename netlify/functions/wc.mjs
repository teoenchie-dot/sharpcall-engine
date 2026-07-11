// SharpCall - WORLD CUP RESULTS ENGINE (fully autonomous; server-side; no Claude, no scheduled task)
// URL (Git-linked, Blobs-backed): https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/wc
//
// WHAT IT DOES, on every run (triggered by the Netlify cron every 2h + page loads):
//  1) FREEZE — for any UPCOMING (state 'pre') knockout fixture with real teams that isn't already covered,
//     it publishes SharpCall's pick BEFORE kickoff using a fixed rule (SC Model favours the higher-rated
//     side; confidence scales with the rating gap) and stores it immutably in Netlify Blobs.
//  2) GRADE — once a match is complete, it grades the frozen/published pick against the real ESPN score.
//     A DRAW counts as a LOSS (we pick a winner). Grading never changes a frozen pick.
// The manually-published quarter-final picks live in PICKS and grade the same way. Homepage + /wc-2026.html
// read this and merge it. No device, no credit, runs 24/7.

import { getStore } from '@netlify/blobs';

// Manually published QF picks (published pre-kickoff on-site snippet 19 + Telegram). Order-independent.
const PICKS = {
  "France vs Morocco":        { pick: "France",    conf: 70 },
  "Spain vs Belgium":         { pick: "Spain",     conf: 63 },
  "Norway vs England":        { pick: "England",   conf: 73 },
  "Argentina vs Switzerland": { pick: "Argentina", conf: 57 }
};

// SC Model knockout strength (0-100). Documented rule for auto-published semi/final picks.
// Covers the 8 quarter-finalists — the semifinalists/finalists come from these.
const STRENGTH = { france:91, argentina:90, spain:89, england:87, belgium:83, morocco:80, norway:79, switzerland:78 };
const DEFAULT_STRENGTH = 75;

const ALIAS = { usa:'unitedstates', us:'unitedstates', korearepublic:'southkorea', turkiye:'turkey',
  turkey:'turkey', ivorycoast:'cotedivoire', cotedivoire:'cotedivoire' };
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z]/g,''); }
function canon(s){ var n=norm(s); return ALIAS[n]||n; }
function teamSet(a,b){ return [canon(a),canon(b)].sort().join('|'); }
function ymd(t){ var d=new Date(t); return ''+d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0'); }
function isPlaceholder(name){ return !name || /winner|runner|tbd|to be|quarter|semi|group\s|^match\b/i.test(name) || /\d/.test(name); }

function autoPick(aName, bName){
  var as = STRENGTH[canon(aName)] || DEFAULT_STRENGTH;
  var bs = STRENGTH[canon(bName)] || DEFAULT_STRENGTH;
  var pick = (as >= bs) ? aName : bName;
  var gap = Math.abs(as - bs);
  var conf = Math.max(55, Math.min(85, Math.round(55 + gap * 1.8)));
  return { pick: pick, conf: conf };
}

function eventInfo(ev){
  var c = ev.competitions && ev.competitions[0]; if(!c) return null;
  var cs = c.competitors || []; if(cs.length < 2) return null;
  var st = ev.status && ev.status.type;
  return {
    completed: !!(st && st.completed),
    state: (st && st.state) || '',
    date: (ev.date||'').slice(0,10),
    teams: cs.map(function(x){ return { name:x.team.displayName, canon:canon(x.team.displayName), score:(+x.score||0), winner:!!x.winner }; })
  };
}
async function espnDay(dateStr){
  try{ var r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=' + dateStr,
      { headers:{ 'User-Agent':'Mozilla/5.0' } });
    var j = await r.json(); return (j.events||[]).map(eventInfo).filter(Boolean);
  }catch(e){ return []; }
}

export default async () => {
  var store = getStore('sc-wc');
  var ledger = (await store.get('v1', { type:'json' })) || { auto:{}, graded:{} };
  ledger.auto = ledger.auto || {}; ledger.graded = ledger.graded || {};

  var now = Date.now(), days = [];
  for(var i=-3;i<=9;i++){ days.push(ymd(now + i*86400000)); }        // recent (grade) + upcoming (freeze)
  var pages = await Promise.all(days.map(espnDay));
  var events = []; pages.forEach(function(p){ events = events.concat(p); });

  var manualKeys = Object.keys(PICKS);
  var manualSets = {}; manualKeys.forEach(function(k){ var p=k.split(/\s+vs\s+/i); manualSets[teamSet(p[0],p[1])]=true; });

  // 1) FREEZE upcoming knockout picks (pre-kickoff)
  events.forEach(function(e){
    if(e.state !== 'pre') return;
    var A=e.teams[0], B=e.teams[1];
    if(isPlaceholder(A.name) || isPlaceholder(B.name)) return;        // matchup not decided yet
    var ts = teamSet(A.name, B.name);
    if(manualSets[ts]) return;                                        // human already published this one
    var already = Object.keys(ledger.auto).some(function(k){ return ledger.auto[k].teamSet===ts; });
    if(already) return;
    var ap = autoPick(A.name, B.name);
    ledger.auto[A.name + ' vs ' + B.name] = { a:A.name, b:B.name, teamSet:ts, pick:ap.pick, conf:ap.conf, publishedAt:new Date(now).toISOString() };
  });

  // 2) GRADE completed picks (manual + auto)
  var active = [];
  manualKeys.forEach(function(k){ var p=k.split(/\s+vs\s+/i); active.push({ key:k, a:p[0], b:p[1], pick:PICKS[k].pick, conf:PICKS[k].conf }); });
  Object.keys(ledger.auto).forEach(function(k){ var x=ledger.auto[k]; active.push({ key:k, a:x.a, b:x.b, pick:x.pick, conf:x.conf }); });

  active.forEach(function(P){
    if(ledger.graded[P.key]) return;
    var ev = events.find(function(e){ if(!e.completed) return false;
      var cs=e.teams.map(function(t){return t.canon;}); return cs.indexOf(canon(P.a))>=0 && cs.indexOf(canon(P.b))>=0; });
    if(!ev) return;
    var ta = ev.teams.find(function(t){return t.canon===canon(P.a);});
    var tb = ev.teams.find(function(t){return t.canon===canon(P.b);});
    if(!ta || !tb) return;
    var win = ev.teams.find(function(t){return t.winner;});
    var r = (win && win.canon===canon(P.pick)) ? 'W' : 'L';          // draw -> L
    ledger.graded[P.key] = { d:ev.date, m:P.key, p:P.pick, c:P.conf, s:ta.score+'-'+tb.score, r:r };
  });

  await store.setJSON('v1', ledger);

  var results = Object.keys(ledger.graded).map(function(k){return ledger.graded[k];}).sort(function(a,b){return (a.d||'').localeCompare(b.d||'');});
  var w = results.filter(function(r){return r.r==='W';}).length;
  var l = results.filter(function(r){return r.r==='L';}).length;
  var pending = active.filter(function(P){return !ledger.graded[P.key];}).map(function(P){return { m:P.key, pick:P.pick, conf:P.conf };});

  return new Response(JSON.stringify({
    updated: new Date().toISOString(),
    count: results.length,
    record: { w:w, l:l, pct:(w+l)?Math.round(w/(w+l)*100):null },
    pending: pending,
    results: results,
    rule: 'Knockout picks: SC Model favours the higher-rated side; confidence scales with the rating gap. Draw = loss.'
  }), { headers:{ 'content-type':'application/json','access-control-allow-origin':'*','cache-control':'public, max-age=600' } });
};
