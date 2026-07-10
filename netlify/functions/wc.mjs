// SharpCall - WORLD CUP RESULTS (grades PUBLISHED picks against real ESPN scores)
// URL (Git-linked, Blobs-backed): https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/wc
//
// Every pick below was published BEFORE kickoff (on-site snippet 19 + Telegram). This function only
// GRADES them once the match is complete — it never invents a pick after the fact. A draw counts as a
// LOSS (we pick a winner). Results are stored in Netlify Blobs and merged into the site's record.
// To add semis/final: append to PICKS here and commit — Git-linked, so the ledger is never wiped.

import { getStore } from '@netlify/blobs';

// match-name (as published) -> the winner we called + our stated confidence.
const PICKS = {
  "France vs Morocco":        { pick: "France",    conf: 70 },
  "Spain vs Belgium":         { pick: "Spain",     conf: 63 },
  "Norway vs England":        { pick: "England",   conf: 73 },
  "Argentina vs Switzerland": { pick: "Argentina", conf: 57 }
  // semis / 3rd place / final go here as the brackets are set (published before kickoff).
};

const ALIAS = { usa:'unitedstates', us:'unitedstates', korearepublic:'southkorea', southkorea:'southkorea',
  turkiye:'turkey', turkey:'turkey', ivorycoast:'cotedivoire', cotedivoire:'cotedivoire',
  czechia:'czechrepublic', czechrepublic:'czechrepublic' };
function norm(s){ return (s||'').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^a-z]/g,''); }
function canon(s){ var n=norm(s); return ALIAS[n]||n; }
function ymd(t){ var d=new Date(t); return ''+d.getUTCFullYear()+String(d.getUTCMonth()+1).padStart(2,'0')+String(d.getUTCDate()).padStart(2,'0'); }

function eventInfo(ev){
  var c = ev.competitions && ev.competitions[0]; if(!c) return null;
  var cs = c.competitors || []; if(cs.length < 2) return null;
  return {
    completed: !!(ev.status && ev.status.type && ev.status.type.completed),
    date: (ev.date||'').slice(0,10),
    teams: cs.map(function(x){ return { canon: canon(x.team.displayName), score: (+x.score||0), winner: !!x.winner }; })
  };
}
// grade one published pick against a completed event. returns a result row or null.
function grade(key, pick, conf, ev){
  var parts = key.split(/\s+vs\s+/i); if(parts.length < 2) return null;
  var a = canon(parts[0]), b = canon(parts[1]);
  var ta = ev.teams.find(function(t){return t.canon===a;});
  var tb = ev.teams.find(function(t){return t.canon===b;});
  if(!ta || !tb) return null;
  var win = ev.teams.find(function(t){return t.winner;});
  var isDraw = !win;                       // no winner flagged = draw
  var r = (!isDraw && win && win.canon === canon(pick)) ? 'W' : 'L';   // draw -> L
  return { d: ev.date, m: key, p: pick, c: conf, s: ta.score + '-' + tb.score, r: r };
}

async function espnDay(dateStr){
  try{
    var r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=' + dateStr,
      { headers: { 'User-Agent':'Mozilla/5.0' } });
    var j = await r.json();
    return (j.events || []).map(eventInfo).filter(Boolean);
  }catch(e){ return []; }
}

export default async () => {
  var store = getStore('sc-wc');
  var ledger = (await store.get('v1', { type:'json' })) || { graded: {} };
  var keys = Object.keys(PICKS);
  var ungraded = keys.filter(function(k){ return !ledger.graded[k]; });

  if(ungraded.length){
    var now = Date.now(), days = [];
    for(var i=0;i<=13;i++){ days.push(ymd(now - i*86400000)); }   // knockouts fall inside ~2 weeks
    var pages = await Promise.all(days.map(espnDay));
    var events = []; pages.forEach(function(p){ events = events.concat(p); });
    ungraded.forEach(function(k){
      var ev = events.find(function(e){
        if(!e.completed) return false;
        var parts = k.split(/\s+vs\s+/i); var a=canon(parts[0]), b=canon(parts[1]);
        var cs = e.teams.map(function(t){return t.canon;});
        return cs.indexOf(a)>=0 && cs.indexOf(b)>=0;
      });
      if(!ev) return;
      var row = grade(k, PICKS[k].pick, PICKS[k].conf, ev);
      if(row) ledger.graded[k] = row;
    });
    await store.setJSON('v1', ledger);
  }

  var results = keys.filter(function(k){return ledger.graded[k];}).map(function(k){return ledger.graded[k];})
                    .sort(function(a,b){ return (a.d||'').localeCompare(b.d||''); });
  var w = results.filter(function(r){return r.r==='W';}).length;
  var l = results.filter(function(r){return r.r==='L';}).length;

  return new Response(JSON.stringify({
    updated: new Date().toISOString(),
    count: results.length,
    record: { w:w, l:l, pct: (w+l)?Math.round(w/(w+l)*100):null },
    pending: keys.filter(function(k){return !ledger.graded[k];}),
    results: results
  }), { headers: { 'content-type':'application/json','access-control-allow-origin':'*','cache-control':'public, max-age=600' } });
};

export { grade, eventInfo, canon };   // for local tests
