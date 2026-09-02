export async function sendWhatsApp(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const instanceId = Deno.env.get("GREEN_API_ID");
  const token = Deno.env.get("GREEN_API_TOKEN");
  if (!instanceId || !token || !phone) {
    return { ok: false, reason: "missing_config" };
  }
  try {
    const digits = phone.replace(/\D/g, "");
    const fullNum = digits.startsWith("253") ? digits : "253" + digits;
    const chatId = fullNum + "@c.us";
    const apiUrl = `https://${instanceId.slice(0, 4)}.api.greenapi.com/waInstance${instanceId}/sendMessage/${token}`;
    const resp = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId, message }),
      signal: AbortSignal.timeout(30000),
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok || json.error) return { ok: false, reason: JSON.stringify(json) };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
