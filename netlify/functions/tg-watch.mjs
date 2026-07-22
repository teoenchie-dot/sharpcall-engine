// netlify/functions/tg-watch.mjs
// Instant Telegram alerts (every 15 min), in plain English.
//  • New fast trade opens -> blast immediately.
//  • Any trade closes -> blast the result (win or loss).
// Silent unless TG_BOT_TOKEN is set. First run seeds state and sends nothing.

import { getStore } from "@netlify/blobs";

const FREE_CHAT = "-1003926123805";
const PRO_CHAT  = "-1004281002756";
const TRADES = "https://gilded-cupcake-0b1708.netlify.app/.netlify/functions/trades";

const NAMES = {
  ETH:"Ethereum", BTC:"Bitcoin", AAPL:"Apple", MSFT:"Microsoft", NVDA:"Nvidia", TSLA:"Tesla",
  DXY:"US Dollar", NASDAQ:"Nasdaq", SP500:"S&P 500", GOLD:"Gold", SILVER:"Silver",
  COPPER:"Copper", OIL:"Crude Oil", NATGAS:"Natural Gas", VIX:"Market Fear Index"
};
const nice = k => NAMES[String(k||"").toUpperCase()] || k;

async function send(token, chat, text){
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  return r.json();
}

function recordLine(rec){
  return (rec && rec.wins != null) ? `Our record: ${rec.wins} wins, ${rec.losses} losses.` : "";
}

function openMsgs(f, rec){
  const nm = f.name || nice(f.asset);
  const word = f.dir === "UP" ? "UP" : "DOWN";
  const rl = recordLine(rec);

  const free =
`⚡ NEW CALL — just now

${nm} — we think it's going ${word}
How sure are we? ${f.conf}% confident
Price right now: ${f.entry}

The exact take-profit and cut-loss prices are in Pro.
👉 getsharpcall.com/members

${rl}
Not financial advice · 18+`;

  const pro =
`⚡ NEW TRADE — ${nm}, going ${word}
How sure are we? ${f.conf}% confident

Buy in around:      ${f.entry}
Take profit at:     ${f.target}${f.targetPct != null ? `  (${f.targetPct >= 0 ? "+" : ""}${f.targetPct}%)` : ""}
Cut losses at:      ${f.stop}${f.stopPct != null ? `  (${f.stopPct}%)` : ""}
How long we hold:   ${f.horizon || "short term"}

${rl}
Not financial advice · 18+`;

  return { free, pro };
}

function closeMsg(h, rec){
  const nm = h.name || nice(h.asset);
  const win = h.result === "WIN";
  const word = h.dir === "UP" ? "up" : "down";
  const what = win
    ? `We said it would go ${word}, and it reached our take-profit price.`
    : `We said it would go ${word}. It hit our cut-loss price instead.`;

  return `${win ? "✅" : "❌"} RESULT — ${nm}: ${win ? "WE WERE RIGHT" : "WE WERE WRONG"}

${what}

${recordLine(rec)}
We post every result — the wins and the misses.
Not financial advice · 18+`;
}

export default async () => {
  const t = await (await fetch(TRADES, { headers: { "cache-control": "no-store" } })).json();
  const store = getStore("sc-tg");
  const prior = await store.get("alerts", { type: "json" });

  const openIds = [];
  const closeIds = [];
  if (t.fast && t.fast.id) openIds.push(t.fast.id);
  (t.history || []).forEach(h => {
    if (h && h.id && (h.result === "WIN" || h.result === "LOSS")) closeIds.push(h.id);
  });

  if (!prior) {
    await store.setJSON("alerts", { opened: openIds, closed: closeIds, seeded: new Date().toISOString() });
    console.log("Seeded alert state — no messages sent.");
    return;
  }

  const state = { opened: prior.opened || [], closed: prior.closed || [], seeded: prior.seeded };
  const events = [];

  if (t.fast && t.fast.id && !state.opened.includes(t.fast.id)) {
    events.push({ kind: "open", data: t.fast });
    state.opened.push(t.fast.id);
  }
  (t.history || []).forEach(h => {
    if (h && h.id && (h.result === "WIN" || h.result === "LOSS") && !state.closed.includes(h.id)) {
      events.push({ kind: "close", data: h });
      state.closed.push(h.id);
    }
  });

  if (!events.length) return;

  const token = process.env.TG_BOT_TOKEN;
  if (!token) {
    console.log(`${events.length} alert(s) pending but no token — marking seen, nothing sent.`);
    await store.setJSON("alerts", state);
    return;
  }

  for (const e of events) {
    if (e.kind === "open") {
      const m = openMsgs(e.data, t.record);
      await send(token, FREE_CHAT, m.free);
      await send(token, PRO_CHAT,  m.pro);
    } else {
      const m = closeMsg(e.data, t.record);
      await send(token, FREE_CHAT, m);
      await send(token, PRO_CHAT,  m);
    }
  }

  await store.setJSON("alerts", state);
};

export const config = { schedule: "*/15 * * * *" };
