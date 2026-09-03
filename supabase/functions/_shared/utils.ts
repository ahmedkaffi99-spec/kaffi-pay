import { supabase } from "./db.ts";

export function genToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function logAudit(action: string, data: Record<string, unknown> = {}) {
  supabase.from("audit_logs").insert({ action, data, source: "edge-functions" }).then(() => {});
}

export const TRANSITIONS_VALIDES: Record<string, string[]> = {
  "En attente": ["Paiement Reçu", "Paiement Non Reçu", "Annulé", "Code Validé", "Code Invalide"],
  "Paiement Reçu": ["Crédité avec succès", "Paiement Non Reçu"],
  "Crédité avec succès": [],
  "Paiement Non Reçu": ["En attente"],
  "Annulé": ["En attente"],
  "Code Validé": ["Payé", "Code Invalide"],
  "Code Invalide": ["En attente", "Code Validé"],
  "Payé": [],
};

export function transitionValide(de: string, vers: string): boolean {
  return (TRANSITIONS_VALIDES[de] || []).includes(vers);
}

// Erreurs MobCash qui ne se résoudront jamais en réessayant — typiquement un
// compte 1xBet en devise étrangère (USD/EUR). Un nouvel ID DJF est requis,
// donc webhook_status doit rester "echec_permanent" pour qu'aucun cron ne le
// reprenne en boucle et que l'admin garde l'indice affiché.
export const ERREURS_PERMANENTES = [
  "currency does not match",
  "account currency",
  "user not found",
  "invalid user",
  "account not found",
];

export function estErreurPermanente(message: string): boolean {
  const m = (message || "").toLowerCase();
  return ERREURS_PERMANENTES.some((s) => m.includes(s));
}

export function cors(req: Request) {
  const origin = req.headers.get("origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

export function json(data: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
