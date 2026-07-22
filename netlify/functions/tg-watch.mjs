// netlify/functions/tg-watch.mjs
// Instant Telegram alerts — runs every 15 min.
//  • Blasts the moment a NEW fast trade opens (time-sensitive, can't wait for the daily digest).
//  • Blasts the RESULT when any trade closes (win or loss) — the honest-scoreboard play.
// Silent unless TG_BOT_TOKEN is set. First run SEEDS state and sends nothing (no backlog spam).

import { getStore } from "@netlify/blobs";

const FREE_CHAT = "-1003926123805";
const PRO_CHAT  = "-1004281002756";
const TRADES = "https://gilded-cupcake-0b1708.netlify.app/.netlify/functions/trades";

async function send(token, chat, text){
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true })
  });
  return r.json();
}

function openMsgs(f, rec){
  const nm = f.name || String(f.asset || "").toUpperCase();
  const recLine = rec && rec.wins != null ? `\nRunning record: ${rec.wins}W-${rec.losses}L` : "";
  const free =
`⚡ FAST CALL JUST FIRED

${nm} — ${f.dir}, ${f.conf}% confidence
Entry ${f.entry}${f.horizon ? ` · horizon ${f.horizon}` : ""}

Exact target & stop are in Pro.${recLine}

🔓 getsharpcall.com/members
Not financial advice · 18+`;

  const pro =
`⚡ FAST CALL — ${nm}${f.id ? ` (${f.id})` : ""} · ${f.dir} · ${f.conf}%

Entry ${f.entry}
🎯 Target ${f.target}${f.targetPct != null ? ` (${f.targetPct >= 0 ? "+" : ""}${f.targetPct}%)` : ""}
🛑 Stop ${f.stop}${f.stopPct != null ? ` (${f.stopPct}%)` : ""}${f.rr ? `\nR:R ${f.rr}` : ""}${f.horizon ? ` · horizon ${f.horizon}` : ""}${recLine}

Not financial advice · 18+`;
  return { free, pro };
}

function closeMsg(h, rec){
  const nm = h.name || String(h.asset || "").toUpperCase();
  const win = h.result === "WIN";
  const rLine = h.r != null ? ` (${h.r >= 0 ? "+" : ""}${h.r}R)` : (win ? " (+1.6R)" : " (-1.0R)");
  const recLine = rec && rec.wins != null ? `\nRunning record: ${rec.wins}W-${rec.losses}L` : "";
  return `${win ? "✅" : "❌"} RESULT — ${nm}${h.id ? ` (${h.id})` : ""} · ${h.type || ""} · ${h.dir || ""}

${h.result}${rLine}${recLine}

Every call graded in public — wins and misses.
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

  // FIRST RUN: seed everything as already-seen, send nothing.
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
    console.log(`${events.length} alert(s) pending but TG_BOT_TOKEN not set — marking seen, nothing sent.`);
    await store.setJSON("alerts", state);
    return;
  }

  for (const e of events) {
    if (e.kind === "open") {
      const m = openMsgs(e.data, t.record);
      await send(token, FREE_CHAT, m.free);
      await send(token, PRO_CHAT,  m.pro);
      console.log("Sent FAST OPEN alert:", e.data.id);
    } else {
      const m = closeMsg(e.data, t.record);
      await send(token, FREE_CHAT, m);
      await send(token, PRO_CHAT,  m);
      console.log("Sent RESULT alert:", e.data.id, e.data.result);
    }
  }

  await store.setJSON("alerts", state);
};

// Every 15 minutes — fast trades are short-horizon, so they can't wait for the daily digest.
export const config = { schedule: "*/15 * * * *" };
