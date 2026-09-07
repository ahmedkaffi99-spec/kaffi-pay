async function postGreenApi(chatId: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const instanceId = Deno.env.get("GREEN_API_ID");
  const token = Deno.env.get("GREEN_API_TOKEN");
  if (!instanceId || !token || !chatId) {
    return { ok: false, reason: "missing_config" };
  }
  try {
    const apiUrl = `https://${instanceId.slice(0, 4)}.api.greenapi.com/waInstance${instanceId}/sendMessage/${token}`;
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
      signal: AbortSignal.timeout(8000),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.error) return { ok: false, reason: JSON.stringify(json) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// Pour un numéro LOCAL djiboutien à 8 chiffres saisi par un client dans un
// formulaire (jamais un indicatif pays) — préfixe 253 ajouté si absent.
export async function sendWhatsApp(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  if (!phone) return { ok: false, reason: "missing_config" };
  const digits = phone.replace(/\D/g, "");
  const fullNum = digits.startsWith("253") ? digits : "253" + digits;
  return postGreenApi(fullNum + "@c.us", message);
}

// Pour répondre à un expéditeur WhatsApp entrant dont le chatId réel est déjà
// connu (avec son vrai indicatif pays, pas forcément 253) — ne JAMAIS lui
// imposer le préfixe Djibouti comme le fait sendWhatsApp() : un numéro
// éthiopien (251...) ou autre se faisait sinon préfixer en "253251..."
// (chatId invalide, échec silencieux, aucune réponse au client).
export async function sendWhatsAppToChatId(chatId: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  return postGreenApi(chatId, message);
}
