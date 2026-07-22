// netlify/functions/tg-post.mjs
// SharpCall daily Telegram poster — plain-English, no jargon.
// Token lives ONLY in the Netlify env var TG_BOT_TOKEN. Scheduled function (not HTTP-triggerable).

const FREE_CHAT = "-1003926123805";
const PRO_CHAT  = "-1004281002756";

const EP = {
  trades: "https://gilded-cupcake-0b1708.netlify.app/.netlify/functions/trades",
  signal: "https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/signal",
  calls:  "https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/calls",
};

// Friendly names — never show raw tickers to readers.
const NAMES = {
  ETH:"Ethereum", BTC:"Bitcoin", AAPL:"Apple", MSFT:"Microsoft", NVDA:"Nvidia", TSLA:"Tesla",
  DXY:"US Dollar", NASDAQ:"Nasdaq", SP500:"S&P 500", GOLD:"Gold", SILVER:"Silver",
  COPPER:"Copper", OIL:"Crude Oil", NATGAS:"Natural Gas", VIX:"Market Fear Index"
};
const nice = k => NAMES[k] || k;

async function j(u){ const r = await fetch(u, { headers: { "cache-control": "no-store" } }); return r.json(); }
function num(s){ return parseFloat(String(s).replace(/[^0-9.]/g, "")); }

export async function gather(){
  const [trades, signal, calls] = await Promise.all([j(EP.trades), j(EP.signal), j(EP.calls)]);
  return { trades, signal, calls };
}

export function buildPosts(d){
  const sig = (d.signal && d.signal.signals) || {};
  const arr = Object.keys(sig).map(k => ({ a: k.toUpperCase(), dir: sig[k].dir, conf: sig[k].conf }));
  const ups = arr.filter(x => x.dir === "UP").sort((a,b) => b.conf - a.conf);
  const dns = arr.filter(x => x.dir === "DOWN").sort((a,b) => b.conf - a.conf);
  const t = d.trades || {};
  const lead = t.fast || t.swing || null;
  const rec = t.record || {};
  const leadAsset = lead ? String(lead.asset || "").toUpperCase() : "";
  const outs = arr.filter(x => x.dir === "FLAT" && x.a !== leadAsset).map(x => nice(x.a));

  const upNames = ups.slice(0,4).map(x => nice(x.a));
  const dnNames = dns.slice(0,4).map(x => nice(x.a));

  const recordLine = (rec.wins != null)
    ? `Our record so far: ${rec.wins} wins, ${rec.losses} losses.`
    : "";

  // ---------- headline call, in plain words ----------
  let freeLead = "", proLead = "";
  if (lead) {
    const nm = lead.name || nice(leadAsset);
    const word = lead.dir === "UP" ? "UP" : "DOWN";
    let moveLine = "";
    if (lead.entry && lead.live) {
      const chg = (num(lead.live) - num(lead.entry)) / num(lead.entry) * 100;
      const good = (lead.dir === "UP" && chg >= 0) || (lead.dir === "DOWN" && chg < 0);
      moveLine = `We called it at ${lead.entry}. It's now ${lead.live} — ` +
        `${chg >= 0 ? "up" : "down"} ${Math.abs(chg).toFixed(1)}% since then. ${good ? "✅ Going our way." : "⚠️ Against us so far."}`;
    }
    freeLead =
`TODAY'S CALL: ${nm} is going ${word}
How sure are we? ${lead.conf}% confident.
${moveLine}`;

    proLead =
`TODAY'S TRADE: ${nm} — going ${word}
How sure are we? ${lead.conf}% confident.

Buy in around:      ${lead.entry}
Take profit at:     ${lead.target}${lead.targetPct != null ? `  (${lead.targetPct >= 0 ? "+" : ""}${lead.targetPct}%)` : ""}
Cut losses at:      ${lead.stop}${lead.stopPct != null ? `  (${lead.stopPct}%)` : ""}
Price right now:    ${lead.live}
How long we hold:   ${lead.horizon || "short term"}
${moveLine}`;
  } else {
    freeLead = `TODAY'S CALL: none yet — nothing looks good enough to call.\nWe'd rather say nothing than guess.`;
    proLead  = `TODAY'S TRADE: none open. Nothing currently meets our confidence bar.`;
  }

  // ---------- free post ----------
  const free = [
`📊 SharpCall — Today`,
``,
freeLead,
``,
`WHAT WE THINK ABOUT EVERYTHING ELSE`,
upNames.length ? `Heading up ↑   ${upNames.join(", ")}` : "",
dnNames.length ? `Heading down ↓ ${dnNames.join(", ")}` : "",
outs.length    ? `Sitting out —  ${outs.slice(0,4).join(", ")} (we're not confident, so we say nothing)` : "",
``,
recordLine,
`We post every call before it happens, and every result after — including the ones we get wrong.`,
``,
`Want the exact price to buy at, when to take profit, and when to cut losses?`,
`👉 getsharpcall.com/members`,
``,
`Not financial advice · 18+`
  ].filter(x => x !== "").join("\n");

  // ---------- pro post ----------
  const pro = [
`💼 SharpCall PRO — Today`,
``,
proLead,
``,
`THE FULL BOARD`,
upNames.length ? `Heading up ↑   ${ups.map(x => `${nice(x.a)} (${x.conf}% sure)`).join(", ")}` : "",
dnNames.length ? `Heading down ↓ ${dns.map(x => `${nice(x.a)} (${x.conf}% sure)`).join(", ")}` : "",
outs.length    ? `Sitting out —  ${outs.join(", ")}` : "",
``,
recordLine,
(d.calls && Array.isArray(d.calls.open)) ? `We're also tracking ${d.calls.open.length} longer-term calls, all locked in and graded.` : "",
``,
`Not financial advice · 18+`
  ].filter(x => x !== "").join("\n");

  return { free, pro };
}

async function send(token, chat, text){
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  return r.json();
}

export default async () => {
  const posts = buildPosts(await gather());
  const token = process.env.TG_BOT_TOKEN;
  if (!token) { console.log("TG_BOT_TOKEN not set — nothing sent."); return; }
  const a = await send(token, FREE_CHAT, posts.free);
  const b = await send(token, PRO_CHAT,  posts.pro);
  console.log("free ok:", a.ok, "| pro ok:", b.ok);
};

export const config = { schedule: "30 8 * * *" };
