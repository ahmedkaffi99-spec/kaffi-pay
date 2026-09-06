import { supabase } from "../_shared/db.ts";
import { json, cors } from "../_shared/utils.ts";

// Vérifie qu'un email Google appartient à un agent actif — appelé au moment
// du login web, avant que l'utilisateur ait la clé admin. La table `agents`
// est réservée à service_role par RLS, donc ce lookup ne peut pas passer par
// le frontend directement : cette fonction ne renvoie jamais que oui/non pour
// l'email exact demandé (jamais la liste complète des agents).
Deno.serve(async (req: Request) => {
  const headers = cors(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return json({ ok: false, error: "POST requis" }, 405, headers);

  const body = await req.json().catch(() => ({}));
  const email = String(body.email || "").trim().toLowerCase();
  if (!email) return json({ ok: false, error: "email requis" }, 400, headers);

  // Un même agent a souvent deux lignes (rôle "paiement" + "support") partageant
  // le même email — le tri alphabétique fait gagner "paiement" (permissions web
  // les plus larges) sur "support"/"surveillance" quand les deux existent.
  const { data, error } = await supabase.from("agents")
    .select("nom,role,chat_id")
    .ilike("email", email)
    .eq("actif", true)
    .order("role", { ascending: true })
    .limit(1);

  if (error) return json({ ok: false, error: error.message }, 500, headers);
  if (!data || data.length === 0) return json({ ok: false }, 200, headers);

  const agent = data[0];
  return json({ ok: true, nom: agent.nom, role: agent.role, chat_id: agent.chat_id }, 200, headers);
});
