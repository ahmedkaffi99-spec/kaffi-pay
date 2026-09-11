import { crypto } from "https://deno.land/std@0.208.0/crypto/mod.ts";
import { estDoublonMontant, logAudit } from "./utils.ts";

const MOBCASH_BASE = "https://partners.servcul.com/CashdeskBotAPI";

async function hexDigest(algorithm: string, input: string): Promise<string> {
  const buf = await crypto.subtle.digest(algorithm, new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Un compte 1xBet a une devise fixée à sa création (DJF ou USD) — MobCash ne
// convertit rien : chaque cashdesk (hash+cashierpass+cashdeskid) est lié à
// UNE devise chez 1xBet, et ne peut créditer/débiter qu'un compte de cette
// même devise ("currency does not match" sinon, voir ERREURS_PERMANENTES).
// Le hash est partagé entre les deux cashdesks (fourni par Ahmed) ; seuls
// cashierpass et cashdeskid changent pour le cashdesk USD.
export async function callMobcash(
  type: "Dépôt" | "Retrait",
  userId1xbet: string,
  montant: number,
  withdrawalCode: string,
  devise: "DJF" | "USD" = "DJF"
) {
  const hash = Deno.env.get("MOBCASH_HASH")!;
  const cashierpass = devise === "USD"
    ? Deno.env.get("MOBCASH_CASHIERPASS_USD")!
    : Deno.env.get("MOBCASH_CASHIERPASS")!;
  const cashdeskId = devise === "USD"
    ? Deno.env.get("MOBCASH_CASHDESKID_USD")!
    : Deno.env.get("MOBCASH_CASHDESKID")!;
  if (!hash || !cashierpass || !cashdeskId) throw new Error(`Secrets MobCash (${devise}) non configurés`);

  const userId = String(userId1xbet);
  const lng = "en";
  const isDepot = type !== "Retrait";
  const endpoint = isDepot ? "Add" : "Payout";

  const part1 = await hexDigest("SHA-256", `hash=${hash}&lng=${lng}&userid=${userId}`);
  const part2 = isDepot
    ? await hexDigest("MD5", `summa=${montant}&cashierpass=${cashierpass}&cashdeskid=${cashdeskId}`)
    : await hexDigest("MD5", `code=${withdrawalCode}&cashierpass=${cashierpass}&cashdeskid=${cashdeskId}`);
  const sign = await hexDigest("SHA-256", part1 + part2);
  const confirm = await hexDigest("MD5", `${userId}:${hash}`);

  const body = isDepot
    ? { cashdeskid: Number(cashdeskId), lng, summa: montant, confirm }
    : { cashdeskid: Number(cashdeskId), lng, code: String(withdrawalCode || ""), confirm };

  const resp = await fetch(`${MOBCASH_BASE}/Deposit/${userId}/${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", sign },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw Object.assign(new Error(`MobCash ${endpoint} HTTP ${resp.status}: ${errText}`), { rawData: { httpStatus: resp.status, body: errText } });
  }
  const data = await resp.json();
  const isSuccess = data.Success ?? data.success;
  const msgId = data.MessageId ?? data.messageId;
  const msgText = data.Message || data.message || JSON.stringify(data);
  if (isSuccess === false || (msgId && msgId !== 0)) {
    throw Object.assign(new Error(`MobCash ${endpoint}: ${msgText}`), { rawData: data });
  }
  return data;
}

// Dépôt avec retry automatique sur le refus MobCash "même ID + même montant
// dans les 5 dernières minutes" (message vérifié en prod le 3 sept. 2026).
// Ce n'est pas une erreur du client ni un souci de solde — un seul DJF de
// plus suffit à distinguer la transaction, donc on le fait nous-mêmes plutôt
// que de bloquer l'ordre ou de solliciter l'admin.
export async function callMobcashDepot(userId1xbet: string, montant: number, devise: "DJF" | "USD" = "DJF") {
  // +1 DJF est négligeable, mais +1$ doublerait presque un petit dépôt USD
  // (ex: 1$ → 2$) — l'ajustement anti-doublon reste un centime en USD.
  const ajustement = devise === "USD" ? 0.01 : 1;
  try {
    return await callMobcash("Dépôt", userId1xbet, montant, "", devise);
  } catch (e) {
    const err = e as Error;
    if (!estDoublonMontant(err.message || "")) throw e;
    logAudit("mobcash_doublon_montant_ajuste", {
      userId1xbet, devise, montantOriginal: montant, montantEnvoye: montant + ajustement, err: err.message,
    });
    return await callMobcash("Dépôt", userId1xbet, montant + ajustement, "", devise);
  }
}
