// SharpCall — MARKET SIGNAL engine (deterministic trend + level rule)
// URL when deployed:  https://<site>.netlify.app/.netlify/functions/signal
// Server-side on Netlify (no CORS, no key, no Claude credit, never stops).
//
// ── THE RULE (fixed & documented — the market equivalent of the Elo rule) ────
// Inputs: ~6 months of daily closes per asset.
//   sma20, sma50            = 20- and 50-day simple moving averages
//   mom10                   = 10-day return  (price / close[-11] - 1)
//   vol                     = stdev of last-20 daily returns (fraction)
//   sep                     = |sma20 - sma50| / sma50   (trend separation)
//   persist                 = share of last 20 closes on the trend side of sma50
// Direction:
//   UP    if price > sma50 AND sma20 > sma50
//   DOWN  if price < sma50 AND sma20 < sma50
//   FLAT  otherwise (mixed structure = no call)
//   Momentum veto: an UP with mom10 < -2% (or DOWN with mom10 > +2%) -> FLAT.
// Confidence (directional calls only), starts at 50, capped 85, floor-to-FLAT below 55:
//   + min(15, |mom10|*100)      momentum strength
//   + min(12, sep*100*4)        trend separation
//   + max(0,(persist-0.5)*2)*8  persistence
// Targets (volatility-scaled, deterministic):
//   move = clamp(2.0 * vol * sqrt(20), 0.03, 0.25)
//   UP:   target = price*(1+move),  invalidation = min(sma50, price*(1-0.7*move))
//   DOWN: target = price*(1-move),  invalidation = max(sma50, price*(1+0.7*move))
//   horizon = 90 days from call date.
// EXPIRED-call handling (documented, applied always): at horizon with neither level hit,
//   resolve by direction — final price on the predicted side of entry = WIN, else LOSS.
// ─────────────────────────────────────────────────────────────────────────────

const SYMBOLS = {
  sp500:  '%5EGSPC', nasdaq: '%5EIXIC', nvda: 'NVDA', tsla: 'TSLA',
  aapl:   'AAPL',    msft:   'MSFT',    gold: 'GC=F', silver: 'SI=F',
  oil:    'CL=F',    copper: 'HG=F',    natgas:'NG=F', vix: '%5EVIX',
  dxy:    'DX-Y.NYB', btc:   'BTC-USD', eth: 'ETH-USD'
};

const HORIZON_DAYS = 90;

function mean(a){ return a.reduce((s,x)=>s+x,0) / a.length; }
function clamp(x,lo,hi){ return Math.max(lo, Math.min(hi, x)); }
function round(x){
  const a = Math.abs(x);
  if (a >= 1000) return Math.round(x);
  if (a >= 100)  return Math.round(x*10)/10;
  if (a >= 1)    return Math.round(x*100)/100;
  return Math.round(x*10000)/10000;
}

// PURE RULE — testable in isolation. closes: oldest -> newest.
function computeSignal(closes){
  const c = closes.filter(x => x != null && isFinite(x));
  if (c.length < 55) return { ok:false, reason:'insufficient-history', n:c.length };

  const price = c[c.length-1];
  const sma20 = mean(c.slice(-20));
  const sma50 = mean(c.slice(-50));
  const mom10 = c.length > 11 ? (price / c[c.length-11] - 1) : 0;

  const rets = [];
  for (let i = c.length-20; i < c.length; i++) if (i>0) rets.push(c[i]/c[i-1]-1);
  const rmean = mean(rets);
  const vol = Math.sqrt(mean(rets.map(r => (r-rmean)*(r-rmean))));

  const sep = Math.abs(sma20 - sma50) / sma50;
  const side = c.slice(-20).filter(x => (x > sma50)).length / 20; // share above sma50

  let dir;
  if (price > sma50 && sma20 > sma50) dir = 'UP';
  else if (price < sma50 && sma20 < sma50) dir = 'DOWN';
  else dir = 'FLAT';

  // momentum veto
  if (dir === 'UP'   && mom10 < -0.02) dir = 'FLAT';
  if (dir === 'DOWN' && mom10 >  0.02) dir = 'FLAT';

  let conf = 0;
  if (dir !== 'FLAT'){
    const persist = dir === 'UP' ? side : (1 - side);
    conf = 50
      + Math.min(15, Math.abs(mom10)*100)
      + Math.min(12, sep*100*4)
      + Math.max(0, (persist - 0.5)*2) * 8;
    conf = Math.round(clamp(conf, 0, 85));
    if (conf < 55){ dir = 'FLAT'; conf = 0; }
  }

  let target = null, invalidation = null;
  if (dir !== 'FLAT'){
    const move = clamp(2.0 * vol * Math.sqrt(20), 0.03, 0.25);
    if (dir === 'UP'){
      target = round(price*(1+move));
      invalidation = round(Math.min(sma50, price*(1-0.7*move)));
    } else {
      target = round(price*(1-move));
      invalidation = round(Math.max(sma50, price*(1+0.7*move)));
    }
  }

  return {
    ok:true, dir, conf,
    price: round(price), sma20: round(sma20), sma50: round(sma50),
    mom10: round(mom10*100), vol: round(vol*100),
    target, invalidation, horizonDays: HORIZON_DAYS
  };
}

async function fetchCloses(sym){
  const r = await fetch(
    `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=6mo`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  const j = await r.json();
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  const q = res && res.indicators && res.indicators.quote && res.indicators.quote[0];
  return (q && q.close) ? q.close : [];
}

exports.handler = async () => {
  const signals = {};
  await Promise.all(Object.entries(SYMBOLS).map(async ([key, sym]) => {
    try { signals[key] = computeSignal(await fetchCloses(sym)); }
    catch (e){ signals[key] = { ok:false, reason:'fetch-failed' }; }
  }));
  return {
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=900'   // 15-min edge cache; signals move slowly
    },
    body: JSON.stringify({ updated: new Date().toISOString(), rule:'trend+level v1', signals })
  };
};

// exported for local testing
exports.computeSignal = computeSignal;
