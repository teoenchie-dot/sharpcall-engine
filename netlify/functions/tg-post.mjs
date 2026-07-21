// netlify/functions/tg-post.mjs
// SharpCall daily Telegram auto-poster — runs server-side on Netlify (no desktop needed).
// The bot token lives ONLY in the Netlify env var TG_BOT_TOKEN (the owner sets it; Claude never handles it).
// Channel IDs are not secret and are safe to keep here.
// Test without sending:  GET /.netlify/functions/tg-post?dry=1   -> returns composed text, sends nothing.
// Live (scheduled or GET without ?dry): composes from live data and posts to both channels.

const FREE_CHAT = "-1003926123805";
const PRO_CHAT  = "-1004281002756";

const EP = {
  trades: "https://gilded-cupcake-0b1708.netlify.app/.netlify/functions/trades",
  signal: "https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/signal",
  poly:   "https://lucky-gumdrop-5b1a14.netlify.app/.netlify/functions/poly",
  calls:  "https://dainty-froyo-d2adbe.netlify.app/.netlify/functions/calls",
};

async function j(u){ const r = await fetch(u, { headers: { "cache-control": "no-store" } }); return r.json(); }
function pct(a,b){ return (a - b) / b * 100; }
function num(s){ return parseFloat(String(s).replace(/[^0-9.]/g, "")); }

function buildPosts(d){
  const sig = (d.signal && d.signal.signals) || {};
  const arr = Object.keys(sig).map(k => ({ a: k.toUpperCase(), dir: sig[k].dir, conf: sig[k].conf }));
  const ups = arr.filter(x => x.dir === "UP").sort((a,b) => b.conf - a.conf);
  const dns = arr.filter(x => x.dir === "DOWN").sort((a,b) => b.conf - a.conf);
  const t = d.trades || {};
  const lead = t.fast || t.swing || null;
  const rec = t.record || {};
  const leadAsset = lead ? String(lead.asset || "").toUpperCase() : "";
  const flats = arr.filter(x => x.dir === "FLAT" && x.a !== leadAsset).map(x => x.a).slice(0, 3);

  const poly = ((d.poly && d.poly.edge) || []).slice().sort((a,b) => Math.abs(b.sc - b.crowd) - Math.abs(a.sc - a.crowd));
  const funs = poly.filter(e => /gta|\$1m|1,000,000|million|dip|hit/i.test(e.q || ""));
  const fun = funs[0] || poly[0];

  const upStr = ups.slice(0,3).map(x => `${x.a} +${x.conf}%`).join(" · ");
  const dnStr = dns.slice(0,3).map(x => `${x.a} −${x.conf}%`).join(" · ");

  let leadFree = "", leadPro = "";
  if (lead) {
    const nm = lead.name || String(lead.asset || "").toUpperCase();
    const onside = (lead.entry && lead.live) ? pct(num(lead.live), num(lead.entry)) : null;
    leadFree = `🔥 Fast read: *${nm} — model says ${lead.dir}, ${lead.conf}% conf.*`;
    if (lead.entry && lead.live) {
      leadFree += `\nCalled at ${lead.entry} → now ${lead.live}` +
        (onside != null ? ` (${onside >= 0 ? "+" : ""}${onside.toFixed(1)}% onside)` : "") +
        (lead.progress ? `, ~${lead.progress}% to target` : "") + ` 🎯\n_(Exact target & stop are in Pro.)_`;
    }
    leadPro = `${lead.dir === "UP" ? "🟢" : "🔴"} *Trade of the Day — ${nm}${lead.id ? ` (${lead.id})` : ""} · ${lead.type || ""} · ${lead.conf}%*\n` +
      `Entry ${lead.entry} · Now ${lead.live}` +
      (onside != null ? ` (${onside >= 0 ? "+" : ""}${onside.toFixed(1)}%${lead.progress ? `, ${lead.progress}% to target` : ""})` : "") + `\n` +
      `🎯 Target ${lead.target}${lead.targetPct != null ? ` (${lead.targetPct >= 0 ? "+" : ""}${lead.targetPct}%)` : ""} · ` +
      `🛑 Stop ${lead.stop}${lead.stopPct != null ? ` (${lead.stopPct}%)` : ""}` +
      `${lead.rr ? ` · R:R ${lead.rr}` : ""}${lead.horizon ? ` · ${lead.horizon}` : ""}`;
  }

  const free = [
    `📊 *SharpCall — Free Daily*`, ``,
    leadFree, ``,
    `🧭 Model board peek:`,
    upStr ? `🟢 ${upStr}` : "",
    dnStr ? `🔴 ${dnStr}` : "",
    flats.length ? `⚪ ${flats.join(" · ")} → *NO CALL* (model's staying out)` : "", ``,
    fun ? `🎮 Fun one: Polymarket crowd ~${fun.crowd}% on "${fun.q}" — our model? *${fun.sc}%.*` : "", ``,
    (rec.wins != null) ? `📒 Honest scoreboard: *${rec.wins}W–${rec.losses}L* (${rec.winRate}%) — every call graded in public, misses included.` : "", ``,
    `🔓 Full entry / target / stop on every call → *Pro*  👉 getsharpcall.com/members`,
    `_Not financial advice · 18+_`
  ].filter(x => x != null).join("\n").replace(/\n{3,}/g, "\n\n");

  const board = [...ups, ...dns].map(x => `${x.dir === "UP" ? "🟢" : "🔴"} ${x.a} ${x.conf}`).join(" · ");
  const callsLine = (d.calls && Array.isArray(d.calls.open)) ? `🧾 ${d.calls.open.length} market calls tracked & frozen` : "";
  const recLine = (rec.wins != null) ? `📒 Record *${rec.wins}W–${rec.losses}L (${rec.winRate}%${rec.netR != null ? `, ${rec.netR >= 0 ? "+" : ""}${rec.netR}R` : ""})*` : "";

  const pro = [
    `💼 *SharpCall PRO — Daily Board*`, ``,
    leadPro, ``,
    board ? `📊 Signal board: ${board}` : "",
    flats.length ? `⚪ NO CALL: ${flats.join(" · ")}` : "", ``,
    [callsLine, recLine].filter(Boolean).join("  ·  "),
    `_Not financial advice · 18+_`
  ].filter(Boolean).join("\n").replace(/\n{3,}/g, "\n\n");

  return { free, pro };
}

async function send(token, chat, text){
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: "Markdown", disable_web_page_preview: true })
  });
  return r.json();
}

export default async (req) => {
  let dry = false;
  try { dry = new URL(req.url).searchParams.get("dry") === "1"; } catch (e) {}

  const [trades, signal, poly, calls] = await Promise.all([j(EP.trades), j(EP.signal), j(EP.poly), j(EP.calls)]);
  const posts = buildPosts({ trades, signal, poly, calls });

  if (dry) {
    return new Response(JSON.stringify(posts, null, 2), { status: 200, headers: { "content-type": "application/json" } });
  }

  const token = process.env.TG_BOT_TOKEN;
  if (!token) {
    console.log("TG_BOT_TOKEN not set — nothing sent. Add it in Netlify env vars to go live.");
    return new Response(JSON.stringify({ sent: false, reason: "no token yet" }), { status: 200, headers: { "content-type": "application/json" } });
  }

  const rFree = await send(token, FREE_CHAT, posts.free);
  const rPro  = await send(token, PRO_CHAT, posts.pro);
  console.log("free ok:", rFree.ok, "| pro ok:", rPro.ok);
  return new Response(JSON.stringify({ sent: true, free: rFree.ok, pro: rPro.ok }), { status: 200, headers: { "content-type": "application/json" } });
};

// Every day at 08:30 UTC. Adjustable.
export const config = { schedule: "30 8 * * *" };
