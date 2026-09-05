import { supabase } from "./db.ts";

const TG = (token: string) => `https://api.telegram.org/bot${token}`;

// fetch() résout normalement pour un 429 (ce n'est pas une exception réseau)
// — le .catch() qu'avaient sendTelegram/sendTelegramKeyboard auparavant ne
// voyait donc jamais un rate-limit Telegram, seulement une vraie coupure
// réseau. Sous une rafale (ex: 10 SMS Waafi dans la même seconde, chacun
// déclenchant plusieurs envois Telegram — admin + agents), Telegram peut
// répondre 429 et le message partait silencieusement à la poubelle. Un seul
// retry, borné à 3s max (le retry_after réel peut être plus long mais on ne
// bloque pas indéfiniment un appelant synchrone comme le panel admin).
async function postTelegram(url: string, body: unknown): Promise<void> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    console.warn("Telegram fetch échoué:", (e as Error).message);
    return;
  }
  if (res.ok) return;
  if (res.status === 429) {
    const data = await res.json().catch(() => ({} as Record<string, unknown>));
    const params = data.parameters as { retry_after?: number } | undefined;
    const retryAfter = Math.min(Number(params?.retry_after) || 1, 3);
    console.warn(`Telegram 429 — retry dans ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    try {
      const retryRes = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!retryRes.ok) console.warn("Telegram retry échoué:", retryRes.status, await retryRes.text().catch(() => ""));
    } catch (e) {
      console.warn("Telegram retry fetch échoué:", (e as Error).message);
    }
    return;
  }
  console.warn("Telegram API erreur:", res.status, await res.text().catch(() => ""));
}

export async function sendTelegram(token: string, chatId: string, text: string) {
  if (!token || !chatId) return;
  await postTelegram(`${TG(token)}/sendMessage`, { chat_id: chatId, text, parse_mode: "HTML" });
}

export async function sendTelegramKeyboard(
  token: string, chatId: string, text: string,
  keyboard: { text: string; callback_data?: string }[][]
) {
  if (!token || !chatId) return;
  await postTelegram(`${TG(token)}/sendMessage`, {
    chat_id: chatId, text, parse_mode: "HTML",
    reply_markup: { inline_keyboard: keyboard },
  });
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
  keyboard?: { text: string; callback_data?: string }[][],
  excludeChatId?: string
) {
  const { data } = await supabase.from("agents")
    .select("chat_id").eq("role", "paiement").eq("actif", true);
  if (!data) return;
  for (const agent of data) {
    if (!agent.chat_id) continue;
    if (excludeChatId && agent.chat_id === excludeChatId) continue;
    if (keyboard?.length) {
      await sendTelegramKeyboard(token, agent.chat_id, text, keyboard).catch(() => {});
    } else {
      await sendTelegram(token, agent.chat_id, text).catch(() => {});
    }
  }
}

export async function notifySupportAgents(
  supportToken: string, text: string,
  keyboard?: { text: string; callback_data?: string }[][]
) {
  const { data } = await supabase.from("agents")
    .select("chat_id").eq("role", "support").eq("actif", true);
  if (!data) return;
  for (const agent of data) {
    if (!agent.chat_id) continue;
    if (keyboard?.length) {
      await sendTelegramKeyboard(supportToken, agent.chat_id, text, keyboard).catch(() => {});
    } else {
      await sendTelegram(supportToken, agent.chat_id, text).catch(() => {});
    }
  }
}
