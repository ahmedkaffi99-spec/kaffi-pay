import { supabase } from "./db.ts";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

export async function sendTelegram(token: string, chatId: string, text: string) {
  if (!token || !chatId) return;
  await fetch(`${TG(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.warn("Telegram failed:", e.message));
}

export async function sendTelegramKeyboard(
  token: string, chatId: string, text: string,
  keyboard: { text: string; callback_data?: string }[][]
) {
  if (!token || !chatId) return;
  await fetch(`${TG(token)}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML",
      reply_markup: { inline_keyboard: keyboard },
    }),
    signal: AbortSignal.timeout(8000),
  }).catch((e) => console.warn("Telegram keyboard failed:", e.message));
}

export async function answerCallback(token: string, callbackId: string, text = "") {
  if (!token || !callbackId) return;
  fetch(`${TG(token)}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

export async function notifyPaiementAgents(
  token: string, text: string,
  keyboard?: { text: string; callback_data?: string }[][]
) {
  const { data } = await supabase.from("agents")
    .select("chat_id").eq("role", "paiement").eq("actif", true);
  if (!data) return;
  for (const agent of data) {
    if (!agent.chat_id) continue;
    if (keyboard?.length) {
      await sendTelegramKeyboard(token, agent.chat_id, text, keyboard).catch(() => {});
    } else {
      await sendTelegram(token, agent.chat_id, text).catch(() => {});
    }
  }
}

export async function notifySupportAgents(supportToken: string, text: string) {
  const { data } = await supabase.from("agents")
    .select("chat_id").eq("role", "support").eq("actif", true);
  if (!data) return;
  for (const agent of data) {
    if (agent.chat_id) await sendTelegram(supportToken, agent.chat_id, text).catch(() => {});
  }
}
