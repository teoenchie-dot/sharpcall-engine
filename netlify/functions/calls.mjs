// SharpCall — MARKET-CALL LEDGER (the track-record engine)
// URL when deployed:  https://<site>.netlify.app/.netlify/functions/calls
//
// WHAT IT DOES (self-contained, server-side, no Claude credit, never stops):
//   On every run it (1) loads the ledger from Netlify Blobs, (2) resolves any OPEN call whose
//   FROZEN target/invalidation was hit (or whose 90d horizon passed), (3) opens ONE new call per
//   asset when none is open and the live signal is directional & strong (conf >= 58) — freezing
//   entry/target/invalidation/date at that instant, (4) saves the ledger, (5) returns record +
//   open positions + resolved history + calibration.
//
//   FREEZING: a call's numbers are written once, at open, and never recomputed while OPEN
//   (the open-branch is skipped whenever a call already exists for that asset). That is what makes
//   the track record honest — a published target/invalidation can never be edited after the fact.
//
//   EXPIRED rule (documented, applied always): at horizon with neither level hit, resolve by
//   direction — final price on the predicted side of entry = WIN, else LOSS.

import { getStore } from '@netlify/blobs';

const SYMBOLS = {
  sp500:'%5EGSPC', nasdaq:'%5EIXIC', nvda:'NVDA', tsla:'TSLA', aapl:'AAPL', msft:'MSFT',
  gold:'GC=F', silver:'SI=F', oil:'CL=F', copper:'HG=F', natgas:'NG=F',
  vix:'%5EVIX', dxy:'DX-Y.NYB', btc:'BTC-USD', eth:'ETH-USD'
};
const HORIZON_DAYS = 90;
const OPEN_MIN_CONF = 58;

const mean = a => a.reduce((s,x)=>s+x,0)/a.length;
const clamp = (x,lo,hi)=>Math.max(lo,Math.min(hi,x));
function round(x){const a=Math.abs(x);if(a>=1000)return Math.round(x);if(a>=100)return Math.round(x*10)/10;if(a>=1)return Math.round(x*100)/100;return Math.round(x*10000)/10000;}

// ── the fixed trend+level rule (same as signal.js) ──
function computeSignal(closes){
  const c = closes.filter(x=>x!=null&&isFinite(x));
  if (c.length < 55) return {ok:false,reason:'insufficient-history'};
  const price=c[c.length-1], sma20=mean(c.slice(-20)), sma50=mean(c.slice(-50));
  const mom10 = c.length>11 ? (price/c[c.length-11]-1) : 0;
  const rets=[]; for(let i=c.length-20;i<c.length;i++) if(i>0) rets.push(c[i]/c[i-1]-1);
  const rmean=mean(rets), vol=Math.sqrt(mean(rets.map(r=>(r-rmean)*(r-rmean))));
  const sep=Math.abs(sma20-sma50)/sma50, side=c.slice(-20).filter(x=>x>sma50).length/20;
  let dir = (price>sma50&&sma20>sma50)?'UP':((price<sma50&&sma20<sma50)?'DOWN':'FLAT');
  if(dir==='UP'&&mom10<-0.02) dir='FLAT';
  if(dir==='DOWN'&&mom10>0.02) dir='FLAT';
  let conf=0;
  if(dir!=='FLAT'){
    const persist=dir==='UP'?side:(1-side);
    conf=50+Math.min(15,Math.abs(mom10)*100)+Math.min(12,sep*100*4)+Math.max(0,(persist-0.5)*2)*8;
    conf=Math.round(clamp(conf,0,85));
    if(conf<55){dir='FLAT';conf=0;}
  }
  let target=null, invalidation=null;
  if(dir!=='FLAT'){
    const move=clamp(2.0*vol*Math.sqrt(20),0.03,0.25);
    if(dir==='UP'){target=round(price*(1+move));invalidation=round(Math.min(sma50,price*(1-0.7*move)));}
    else{target=round(price*(1-move));invalidation=round(Math.max(sma50,price*(1+0.7*move)));}
  }
  return {ok:true,dir,conf,price:round(price),target,invalidation,horizonDays:HORIZON_DAYS};
}

async function fetchCloses(sym){
  const r=await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=6mo`,{headers:{'User-Agent':'Mozilla/5.0'}});
  const j=await r.json();
  const res=j&&j.chart&&j.chart.result&&j.chart.result[0];
  const q=res&&res.indicators&&res.indicators.quote&&res.indicators.quote[0];
  return (q&&q.close)?q.close:[];
}

function resolveOpen(call, price, now){
  const t=call.target, iv=call.invalidation;
  if(call.dir==='UP'){ if(price>=t) return {status:'HIT',win:true}; if(price<=iv) return {status:'MISSED',win:false}; }
  else { if(price<=t) return {status:'HIT',win:true}; if(price>=iv) return {status:'MISSED',win:false}; }
  const ageDays=(now-new Date(call.openDate).getTime())/86400000;
  if(ageDays>=call.horizonDays){ const moved=call.dir==='UP'?price>call.entry:price<call.entry; return {status:'EXPIRED',win:moved}; }
  return null;
}

export default async () => {
  const store = getStore('sc-ledger');
  let ledger = (await store.get('v1',{type:'json'})) || { open:{}, resolved:[], seq:0 };
  const now = Date.now();
  const signals = {};

  await Promise.all(Object.entries(SYMBOLS).map(async ([key,sym])=>{
    try{
      const sig = computeSignal(await fetchCloses(sym));
      signals[key]=sig;
      if(!sig.ok) return;
      const price=sig.price;
      // resolve
      if(ledger.open[key]){
        const r=resolveOpen(ledger.open[key], price, now);
        if(r){ const c=ledger.open[key]; c.status=r.status; c.win=r.win; c.exit=price; c.resolvedDate=new Date(now).toISOString(); ledger.resolved.push(c); delete ledger.open[key]; }
      }
      // open (freeze)
      if(!ledger.open[key] && (sig.dir==='UP'||sig.dir==='DOWN') && sig.conf>=OPEN_MIN_CONF){
        ledger.seq++;
        ledger.open[key]={ id:'SC'+String(ledger.seq).padStart(4,'0'), asset:key, dir:sig.dir, conf:sig.conf,
          entry:price, target:sig.target, invalidation:sig.invalidation, horizonDays:sig.horizonDays,
          openDate:new Date(now).toISOString(), status:'OPEN' };
      }
    }catch(e){ signals[key]={ok:false,reason:'fetch-failed'}; }
  }));

  await store.setJSON('v1', ledger);

  // calibration
  const B={'55-59':{n:0,w:0,s:0},'60-69':{n:0,w:0,s:0},'70-79':{n:0,w:0,s:0},'80+':{n:0,w:0,s:0}};
  const bkt=c=>c<60?'55-59':(c<70?'60-69':(c<80?'70-79':'80+'));
  let wins=0, losses=0;
  ledger.resolved.forEach(c=>{ const b=B[bkt(c.conf)]; b.n++; b.s+=c.conf; if(c.win){b.w++;wins++;}else losses++; });
  const calibration=Object.entries(B).filter(([,v])=>v.n>0).map(([k,v])=>({bucket:k,n:v.n,statedAvg:Math.round(v.s/v.n),actual:Math.round(v.w/v.n*100)}));

  const open=Object.values(ledger.open).sort((a,b)=>new Date(b.openDate)-new Date(a.openDate));
  const resolved=ledger.resolved.slice(-40).reverse();

  return new Response(JSON.stringify({
    updated:new Date(now).toISOString(), rule:'trend+level v1', horizonDays:HORIZON_DAYS, openMinConf:OPEN_MIN_CONF,
    record:{ wins, losses, total:wins+losses, winPct:(wins+losses)?Math.round(wins/(wins+losses)*100):null },
    open, resolved, calibration, signals
  }), { headers:{'content-type':'application/json','access-control-allow-origin':'*','cache-control':'public, max-age=300'} });
};
