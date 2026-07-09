// SharpCall - TRADE LEDGER (Trade of the Day, logged + auto-resolved + history)
// URL: https://<site>.netlify.app/.netlify/functions/trades
//
// Each day the model publishes a FAST (intraday) and SWING (1-3d) trade. The moment a trade is
// published its entry/target/stop are FROZEN and written to Netlify Blobs. It is then graded against
// the real bar highs/lows:
//   target touched -> WIN (+1.6R)   stop touched -> LOSS (-1.0R)
//   both touched in the same bar -> LOSS (conservative: we assume the stop hit first)
//   horizon reached with neither -> EXPIRED, graded by direction (R = actual move / risk)
// Nothing is ever rewritten once open. Systematic model output, not financial advice.

import { getStore } from '@netlify/blobs';

const SYM  = { sp500:'%5EGSPC', nasdaq:'%5EIXIC', gold:'GC=F', oil:'CL=F', btc:'BTC-USD', nvda:'NVDA' };
const NAME = { sp500:'S&P 500', nasdaq:'Nasdaq', gold:'Gold', oil:'Crude Oil', btc:'Bitcoin', nvda:'NVIDIA' };
const PFX  = { sp500:'', nasdaq:'', gold:'$', oil:'$', btc:'$', nvda:'$' };
const MIN_CONF = 58;
const FAST_HOURS = 8;       // fast trade horizon (capped at session close)
const SWING_DAYS = 3;       // swing trade horizon

function mean(a){ return a.reduce(function(s,x){return s+x;},0)/a.length; }
function clamp(x,lo,hi){ return Math.max(lo,Math.min(hi,x)); }
function retsOf(c){ var r=[]; for(var i=1;i<c.length;i++) r.push(c[i]/c[i-1]-1); return r; }
function stdev(a){ if(a.length<2) return 0; var m=mean(a); return Math.sqrt(mean(a.map(function(x){return (x-m)*(x-m);}))); }
function rnd(x){ var a=Math.abs(x); if(a>=1000) return Math.round(x); if(a>=100) return Math.round(x*10)/10; if(a>=1) return Math.round(x*100)/100; return Math.round(x*10000)/10000; }
function fmt(v,p){ if(v==null) return '-'; var a=Math.abs(v); var s=a>=1000?Math.round(v).toLocaleString():(a>=1?(+v).toFixed(2):(+v).toFixed(4)); return (p||'')+s; }

async function bars(sym, interval, range){
  var r=await fetch('https://query1.finance.yahoo.com/v8/finance/chart/'+sym+'?interval='+interval+'&range='+range,{headers:{'User-Agent':'Mozilla/5.0'}});
  var j=await r.json();
  var res=j&&j.chart&&j.chart.result&&j.chart.result[0];
  if(!res) return null;
  var q=res.indicators&&res.indicators.quote&&res.indicators.quote[0];
  if(!q||!q.close) return null;
  return { t:res.timestamp||[], h:q.high||[], l:q.low||[], c:q.close||[], meta:res.meta||{} };
}
function closes(B){ return (B&&B.c?B.c:[]).filter(function(x){return x!=null&&isFinite(x);}); }

// Is this asset's exchange in its regular session RIGHT NOW? We never open a trade into a
// closed market: entry would be a stale close and the next open could gap straight through
// the stop, booking a loss the model never had a chance to trade.
function regular(B){ var m=B&&B.meta&&B.meta.currentTradingPeriod&&B.meta.currentTradingPeriod.regular; return (m&&m.start&&m.end)?m:null; }
function openNow(B){ var p=regular(B); if(!p) return false; var n=Math.floor(Date.now()/1000); return n>=p.start && n<p.end; }
function sessionEndMs(B){ var p=regular(B); return p?p.end*1000:null; }

function setup(c, cfg){
  if(c.length<cfg.need) return null;
  var price=c[c.length-1];
  var sS=mean(c.slice(-cfg.sMA)), sL=mean(c.slice(-cfg.lMA));
  var mom=c.length>cfg.mom+1 ? (price/c[c.length-1-cfg.mom]-1) : 0;
  var vol=stdev(retsOf(c.slice(-cfg.volN)));
  var dir='FLAT';
  if(price>sS && sS>sL && mom>0) dir='UP';
  else if(price<sS && sS<sL && mom<0) dir='DOWN';
  var sep=Math.abs(sS-sL)/sL, conf=0;
  if(dir!=='FLAT'){ conf=Math.round(clamp(50+Math.min(18,Math.abs(mom)*100*cfg.momW)+Math.min(12,sep*100*cfg.sepW),50,85)); }
  var score=Math.abs(mom)*100*cfg.momW + sep*100*cfg.sepW + (dir!=='FLAT'?10:0);
  var unit=price*clamp(vol*Math.sqrt(cfg.hz), cfg.minMove, cfg.maxMove);
  var target=null, stop=null;
  if(dir==='UP'){ target=price+1.6*unit; stop=price-1.0*unit; }
  else if(dir==='DOWN'){ target=price-1.6*unit; stop=price+1.0*unit; }
  return { dir:dir, conf:conf, score:score, price:price, target:target, stop:stop };
}
function best(rows){
  var d=rows.filter(function(r){return r.s && r.s.dir!=='FLAT';});
  if(!d.length) return null;
  d.sort(function(a,b){return b.s.score-a.s.score;});
  return d[0];
}

function fin(tr, result, exit, ts, R){
  tr.result=result; tr.exit=rnd(exit); tr.closeDate=new Date(ts*1000).toISOString();
  tr.R=Math.round(R*100)/100; return tr;
}
// grade an open trade against real bars (highs/lows). returns resolved trade or null.
function resolveTrade(tr, B, nowMs){
  if(!B||!B.t||!B.t.length) return null;
  var openTs=Date.parse(tr.openDate)/1000;
  var risk=Math.abs(tr.entry-tr.stop); if(!(risk>0)) return null;
  var expTs=Date.parse(tr.expires)/1000;
  for(var i=0;i<B.t.length;i++){
    if(B.t[i]<openTs) continue;
    var hi=B.h[i], lo=B.l[i];
    if(hi!=null&&lo!=null){
      if(tr.dir==='UP'){
        if(lo<=tr.stop)   return fin(tr,'LOSS',tr.stop,B.t[i],-1.0);
        if(hi>=tr.target) return fin(tr,'WIN', tr.target,B.t[i],(tr.target-tr.entry)/risk);
      } else {
        if(hi>=tr.stop)   return fin(tr,'LOSS',tr.stop,B.t[i],-1.0);
        if(lo<=tr.target) return fin(tr,'WIN', tr.target,B.t[i],(tr.entry-tr.target)/risk);
      }
    }
    // horizon reached: grade at THIS bar's close (the price at expiry), not at today's price
    if(B.t[i]>=expTs){
      var cx=B.c[i];
      if(cx!=null&&isFinite(cx)){
        var Rx = tr.dir==='UP' ? (cx-tr.entry)/risk : (tr.entry-cx)/risk;
        return fin(tr, Rx>0?'WIN':'LOSS', cx, B.t[i], Rx);
      }
    }
  }
  if(nowMs >= Date.parse(tr.expires)){
    var last=null; for(var k=B.c.length-1;k>=0;k--){ if(B.c[k]!=null&&isFinite(B.c[k])){ last=B.c[k]; break; } }
    if(last==null) return null;
    var R = tr.dir==='UP' ? (last-tr.entry)/risk : (tr.entry-last)/risk;
    return fin(tr, R>0?'WIN':'LOSS', last, Math.floor(nowMs/1000), R);
  }
  return null;
}

export default async () => {
  var store=getStore('sc-trades');
  var L=(await store.get('v1',{type:'json'})) || { open:{}, history:[], seq:0, lastFastDate:null };
  var now=Date.now();
  var keys=Object.keys(SYM);

  var intra={}, day={};
  await Promise.all(keys.map(async function(k){
    try{ intra[k]=await bars(SYM[k],'60m','5d'); }catch(e){ intra[k]=null; }
    try{ day[k]=await bars(SYM[k],'1d','3mo'); }catch(e){ day[k]=null; }
  }));

  // 1) resolve any open trades against real bars
  var closedNow=[];
  ['fast','swing'].forEach(function(type){
    var tr=L.open[type]; if(!tr) return;
    var B = type==='fast' ? intra[tr.asset] : day[tr.asset];
    var done=resolveTrade(tr, B, now);
    if(done){ L.history.push(done); closedNow.push(done); delete L.open[type]; }
  });

  // 2) open new trades (freeze) if none open
  var fastCfg={need:30,sMA:8,lMA:24,mom:6,volN:24,momW:12,sepW:6,hz:6,minMove:0.003,maxMove:0.05};
  var swingCfg={need:25,sMA:5,lMA:20,mom:3,volN:20,momW:8,sepW:5,hz:2,minMove:0.01,maxMove:0.12};
  var today=new Date(now).toISOString().slice(0,10);

  // only consider assets whose market is OPEN right now
  var openKeys=keys.filter(function(k){ return openNow(intra[k]); });
  var fastPick=best(openKeys.map(function(k){return {k:k,s:setup(closes(intra[k]),fastCfg)};}));
  var swingPick=best(openKeys.map(function(k){return {k:k,s:setup(closes(day[k]),swingCfg)};}));
  var marketOpen={}; keys.forEach(function(k){ marketOpen[k]=openNow(intra[k]); });
  var anyOpen=openKeys.length>0;

  function openTrade(type, pick, hours){
    if(!pick||!pick.s||pick.s.conf<MIN_CONF) return null;
    if(!openNow(intra[pick.k])) return null;                 // never open into a closed market
    var exp = now + hours*3600000;
    if(type==='fast'){                                       // an intraday trade dies at the bell
      var se=sessionEndMs(intra[pick.k]);
      if(se){ exp=Math.min(exp, se); }
      if(exp - now < 45*60000) return null;                  // too little session left to be meaningful
    }
    L.seq++;
    var s=pick.s;
    return { id:'T'+String(L.seq).padStart(4,'0'), type:type, asset:pick.k, name:NAME[pick.k], pfx:PFX[pick.k],
      dir:s.dir, conf:s.conf, entry:rnd(s.price), target:rnd(s.target), stop:rnd(s.stop),
      openDate:new Date(now).toISOString(), expires:new Date(exp).toISOString(), status:'OPEN' };
  }
  if(!L.open.fast && L.lastFastDate!==today){
    var f=openTrade('fast',fastPick,FAST_HOURS);
    if(f){ L.open.fast=f; L.lastFastDate=today; }
  }
  if(!L.open.swing){
    var sw=openTrade('swing',swingPick,SWING_DAYS*24);
    if(sw) L.open.swing=sw;
  }

  await store.setJSON('v1', L);

  // 3) stats
  var w=0,l=0,netR=0, byType={fast:{w:0,l:0,R:0}, swing:{w:0,l:0,R:0}};
  L.history.forEach(function(t){
    if(t.result==='WIN'){ w++; byType[t.type].w++; } else { l++; byType[t.type].l++; }
    netR+=(t.R||0); byType[t.type].R+=(t.R||0);
  });
  var total=w+l;

  function live(k){ var c=closes(intra[k]); return c.length?c[c.length-1]:null; }
  function decorate(tr){
    if(!tr) return null;
    var lp=live(tr.asset);
    var risk=Math.abs(tr.entry-tr.stop);
    var prog = (lp!=null && risk>0) ? Math.round(((tr.dir==='UP'?(lp-tr.entry):(tr.entry-lp))/Math.abs(tr.target-tr.entry))*100) : null;
    return { id:tr.id,type:tr.type,asset:tr.asset,name:tr.name,dir:tr.dir,conf:tr.conf,
      entry:fmt(tr.entry,tr.pfx), target:fmt(tr.target,tr.pfx), stop:fmt(tr.stop,tr.pfx),
      live: lp!=null?fmt(rnd(lp),tr.pfx):null, progress:prog,
      targetPct: Math.round((tr.target/tr.entry-1)*1000)/10, stopPct: Math.round((tr.stop/tr.entry-1)*1000)/10,
      rr: Math.round(Math.abs(tr.target-tr.entry)/risk*10)/10,
      horizon: tr.type==='fast'?('Intraday \u00b7 to session close'):(SWING_DAYS+' days'),
      openDate:tr.openDate, expires:tr.expires, status:'OPEN' };
  }

  var hist=L.history.slice(-20).reverse().map(function(t){
    return { id:t.id,type:t.type,name:t.name,dir:t.dir,conf:t.conf,result:t.result,R:t.R,
      entry:fmt(t.entry,t.pfx), exit:fmt(t.exit,t.pfx), target:fmt(t.target,t.pfx), stop:fmt(t.stop,t.pfx),
      openDate:t.openDate.slice(0,10), closeDate:(t.closeDate||'').slice(0,10) };
  });

  return new Response(JSON.stringify({
    updated:new Date(now).toISOString(),
    fast: decorate(L.open.fast), swing: decorate(L.open.swing),
    marketOpen: marketOpen, anyMarketOpen: anyOpen,
    fastReason: L.open.fast ? null : (anyOpen ? 'No setup clears the confidence threshold right now.' : 'Markets are closed \u2014 no intraday trade is published outside session hours.'),
    swingReason: L.open.swing ? null : (anyOpen ? 'No setup clears the confidence threshold right now.' : 'Markets are closed \u2014 waiting for the open.'),
    closedToday: closedNow.map(function(t){return {id:t.id,type:t.type,name:t.name,result:t.result,R:t.R};}),
    record:{ wins:w, losses:l, total:total, winRate: total?Math.round(w/total*100):null, netR:Math.round(netR*100)/100,
             breakevenRate:38, byType:byType },
    history: hist,
    rules:'Target touched = WIN (+1.6R). Stop touched = LOSS (-1.0R). Same bar both = LOSS (conservative). Horizon reached = graded by direction.',
    disclaimer:'Systematic model output for education only. Not financial advice.'
  }), { headers:{ 'content-type':'application/json','access-control-allow-origin':'*','cache-control':'public, max-age=300' } });
};
