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

// Solde du cashdesk MobCash insuffisant pour honorer le dépôt — ce n'est pas
// une faute du client, donc pas d'affichage "échec" côté client (le statut
// reste "Paiement Reçu" sans webhook_status "echec*", ce qui garde la page de
// suivi sur "Crédit en cours"). L'admin doit recharger le solde puis relancer
// manuellement — le cron ne réessaie pas cette catégorie non plus.
// Texte vérifié en direct contre l'API MobCash le 3 sept. 2026 (7000 DJF sur
// un solde de 3700) : "Deposit limit exceeded. A maximum of 4199.00 can be
// deposited". Les autres variantes restent en filet de sécurité au cas où le
// libellé change selon le motif exact du dépassement.
export const ERREURS_SOLDE_INSUFFISANT = [
  "deposit limit exceeded",
  "can be deposited",
  "insufficient",
  "not enough",
  "low balance",
  "balance too low",
];

export function estSoldeInsuffisant(message: string): boolean {
  const m = (message || "").toLowerCase();
  return ERREURS_SOLDE_INSUFFISANT.some((s) => m.includes(s));
}

// MobCash refuse un second dépôt avec le même ID + le même montant dans les
// 5 minutes suivant le premier. Texte vérifié en direct le 3 sept. 2026 :
// "A payment of 50 has already been made to customer no. 1789408881. This
// payment can be made again in 5 minutes." — entièrement auto-récupérable :
// un seul DJF de plus suffit à distinguer la transaction, pas besoin d'admin.
export const MOTIF_DOUBLON_MONTANT = ["already been made", "can be made again"];

export function estDoublonMontant(message: string): boolean {
  const m = (message || "").toLowerCase();
  return MOTIF_DOUBLON_MONTANT.every((s) => m.includes(s));
}

// Classe une erreur MobCash pour décider du webhook_status à écrire.
// echec_permanent : ID/devise invalide — le client doit fournir un nouvel ID DJF.
// echec_solde     : cashdesk à sec — l'admin doit recharger, pas le client.
// echec           : erreur transitoire — le cron peut réessayer automatiquement.
export function webhookStatusPourErreurMobcash(message: string): "echec_permanent" | "echec_solde" | "echec" {
  if (estErreurPermanente(message)) return "echec_permanent";
  if (estSoldeInsuffisant(message)) return "echec_solde";
  return "echec";
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
