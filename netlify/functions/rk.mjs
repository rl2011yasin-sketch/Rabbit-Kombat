// RabbitKombat — Netlify Function: referral tracking, saving, bot webhook.
// Env vars (Netlify → Site settings → Environment variables): BOT_TOKEN, WEBHOOK_SECRET (any random string)
import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const TOKEN = process.env.BOT_TOKEN, SECRET = process.env.WEBHOOK_SECRET || "";
const SITE = process.env.URL || "";
const CHANNEL_URL = "https://t.me/RabbitKombats", CHANNEL_ID = "@RabbitKombats";

const store = () => getStore({ name: "rabbitkombat", consistency: "strong" });
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "Content-Type": "application/json" } });
const tg = (m, b) => fetch(`https://api.telegram.org/bot${TOKEN}/${m}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(r => r.json());
const blank = () => ({ name: "", refBy: null, refs: [], coins: 0, total: 0 });

// Counts a referral ONLY for a brand-new user, a valid inviter, and never for self-invites.
async function register(id, name, inviter) {
  id = String(id);
  const s = store();
  let u = await s.get("u_" + id, { type: "json" });
  const isNew = !u;
  if (!u) u = blank();
  if (name) u.name = name;
  let counted = null;
  if (isNew && inviter && /^\d+$/.test(String(inviter)) && String(inviter) !== id) {
    inviter = String(inviter);
    const inv = (await s.get("u_" + inviter, { type: "json" })) || blank();
    u.refBy = inviter;
    if (!inv.refs.find(r => r.id === id)) {
      inv.refs.push({ id, name: u.name || "Friend" });
      await s.setJSON("u_" + inviter, inv);
      counted = inviter;
    }
  }
  await s.setJSON("u_" + id, u);
  return counted;
}

// Verifies Telegram Mini App initData signature
function verify(initData) {
  if (!initData || !TOKEN) return null;
  const p = new URLSearchParams(initData), hash = p.get("hash"); p.delete("hash");
  const str = [...p.entries()].map(([k, v]) => k + "=" + v).sort().join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(TOKEN).digest();
  if (crypto.createHmac("sha256", secret).update(str).digest("hex") !== hash) return null;
  try { return JSON.parse(p.get("user")); } catch { return null; }
}

async function bot(req, d) {
  if (SECRET && req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) return json({ error: "forbidden" }, 403);
  const m = d.message;
  if (!m || !m.text || !m.from) return json({ ok: true });
  const mt = /^\/start(?:\s+ref_(\d+))?/.exec(m.text);
  if (!mt) return json({ ok: true });
  const inviter = await register(m.from.id, m.from.first_name, mt[1]);
  await tg("sendMessage", {
    chat_id: m.chat.id,
    text: "🐰 Welcome to RabbitKombat!\n\nTap the coin, complete tasks, invite friends and climb the leagues.",
    reply_markup: { inline_keyboard: [[{ text: "🎮 Play RabbitKombat", web_app: { url: SITE } }], [{ text: "📢 Official Channel", url: CHANNEL_URL }]] },
  });
  if (inviter) await tg("sendMessage", { chat_id: inviter, text: `👥 ${m.from.first_name || "A friend"} joined RabbitKombat through your link! Open the app to collect your bonus.` });
  return json({ ok: true });
}

export default async (req) => {
  if (req.method !== "POST") return json({ ok: true });
  let d; try { d = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (d.update_id !== undefined) return bot(req, d);

  const user = verify(d.initData);
  if (!user) return json({ error: "unauthorized" }, 401);
  const id = String(user.id);

  if (d.action === "referral") { await register(id, user.first_name, d.inviter); return json({ ok: true }); }
  if (d.action === "pull") {
    await register(id, user.first_name, null);
    const u = (await store().get("u_" + id, { type: "json" })) || blank();
    return json({ refs: u.refs, refBy: u.refBy });
  }
  if (d.action === "save") {
    const s = store(), u = (await s.get("u_" + id, { type: "json" })) || blank();
    u.coins = Number(d.coins) || 0; u.total = Number(d.total) || 0; u.name = user.first_name || u.name;
    await s.setJSON("u_" + id, u);
    return json({ ok: true });
  }
  if (d.action === "check_channel") {
    const r = await tg("getChatMember", { chat_id: CHANNEL_ID, user_id: Number(id) });
    if (!r.ok) return json({ unverified: true }); // bot isn't channel admin → app falls back to simple check
    return json({ member: ["creator", "administrator", "member", "restricted"].includes(r.result.status) });
  }
  return json({ error: "unknown action" }, 400);
};

export const config = { path: "/api" };
