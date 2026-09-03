# Règles critiques — kaffi-pay

## Architecture secrets
- Les secrets (TELEGRAM_TOKEN, GREEN_API_ID, etc.) sont dans **Google Secret Manager**
- Utiliser `defineSecret()` de `firebase-functions/params` + `secrets: ALL_SECRETS` sur chaque fonction
- **NE JAMAIS** supprimer `defineSecret()` ni passer à `mkEnv()` / `process.env`
- **NE JAMAIS** supprimer les fonctions gen2 avec `gcloud functions delete --gen2` sauf si absolument nécessaire — cela détruit les liaisons Secret Manager et casse toutes les notifications

## Sécurité — NE PAS TOUCHER
- Clé admin : `kp2026_9f3aXmQ7` — ne pas changer sans permission explicite
- Numéro Waafi : `77275572` — ne pas changer sans permission explicite
- Captcha mathématique — ne pas supprimer sans permission explicite
- Secret `Kafia&77105640` — ne jamais exposer côté client

## Green API (WhatsApp)
- Instance autorisée : téléphone `25377275572`
- Format chatId : `25377XXXXXXXX@c.us` (préfixe 253 obligatoire)
- URL API : `https://${instanceId.slice(0,4)}.api.greenapi.com/waInstance${instanceId}/sendMessage/${token}`

## CI/CD
- Branche de déploiement : `claude/fait-fix-DjJ6q`
- GitHub Actions se déclenche automatiquement sur push
- `GOOGLE_CREDENTIALS` est le seul secret GitHub nécessaire (auth GCP)
- Pas besoin de GitHub Secrets pour les tokens app — tout est dans Secret Manager

## Leçon apprise (26 août 2026)
- Runs #220–#228 ont échoué en tentant de remplacer Secret Manager par `.env.kaffi-pay`
- Run #229 a supprimé les services Cloud Run gen2 → liaisons Secret Manager perdues → Telegram + WhatsApp cassés
- Fix : restaurer `defineSecret()` + redéployer (run #231) → tout fonctionne

## Supabase Edge Functions — pièges

### CORS : le préflight 204 doit avoir un body `null`
```ts
return new Response(null, { status: 204, headers });   // ✅
return new Response("",   { status: 204, headers });   // ❌ TypeError
```
204 est un *null body status* (spec Fetch) : construire une `Response` avec un
body non-null lève un `TypeError`, et `""` **est** non-null. Deno applique la
spec strictement → le handler throw → 500 `EDGE_FUNCTION_ERROR` + `EarlyDrop`.

C'était la cause du bug « aucun ordre en base » (2 sept. 2026) : les 11
fonctions avaient cette ligne, donc **tous** les préflights navigateur
échouaient et aucun POST du site n'atteignait jamais le backend.

Piège de diagnostic : MacroDroid (POST direct) et pg_cron (GET direct)
continuaient de marcher, car aucun des deux n'envoie de préflight. Un backend
qui « marche » sur ces chemins peut donc être totalement inaccessible au
navigateur. Pour tester un OPTIONS depuis l'extérieur, `pg_net` ne suffit pas
(GET/POST/DELETE uniquement) — déployer une fonction sonde qui fait le `fetch`
avec `method: 'OPTIONS'`.

### RLS — qui peut lire quoi
- `depot_orders`, `retrait_orders` : `anon` SELECT (page suivi) + `service_role` ALL
- toutes les autres (`agents`, `audit_logs`, `waafi_notifications`,
  `ordre_traite`, `config`, `reserves`) : **`service_role` uniquement**

Donc tout accès du frontend à ces tables doit passer par une Edge Function,
jamais par `/rest/v1/` avec la clé anon — sinon la requête revient vide en
silence. C'est ce qui cassait la liste des agents dans le panel admin.

### Webhooks Telegram — non gérés par le CI
Les bots pointaient encore vers Firebase (`europe-west1-kaffi-pay.cloudfunctions.net/adminBot`)
longtemps après la migration, en 503 permanent. Les notifications **sortantes**
marchaient quand même, ce qui masquait le problème : seul l'**entrant** était
mort — boutons inline, commandes admin, et tout le bot support.

URLs correctes, à re-poser après tout changement de projet Supabase :
- admin → `https://pasotcpwvdtpidelrqic.supabase.co/functions/v1/admin-bot`
- support → `https://pasotcpwvdtpidelrqic.supabase.co/functions/v1/support-client`

`allowed_updates` doit contenir `["message","callback_query"]`, sinon les
boutons ne remontent pas. Le CI ne configure rien de tout ça.

Piège : la commande `webhook admin` du bot répare le webhook, mais elle arrive
*par* le webhook — inutilisable quand il est cassé. Passer par l'API Telegram.

### `.catch()` interdit sur une requête Supabase
```ts
await supabase.from("t").update({...}).eq("id", x).catch(() => {});  // ❌ TypeError
await supabase.from("t").update({...}).eq("id", x);                  // ✅
```
Le query builder est un `PromiseLike` : il a `then()` mais **pas `catch()`**.
L'appeler lève avant même l'envoi de la requête. Ça a bloqué tous les dépôts à
`Paiement Reçu` (MobCash jamais appelé) et cassé le bouton « Terminer ».
Ces requêtes ne rejettent pas — elles renvoient `{data, error}`, à tester.

### NULL en SQL n'est pas `TRUE`
`.neq("webhook_status","ok")` excluait les lignes à `NULL`, donc exactement les
ordres bloqués avant tout appel MobCash que le cron doit rattraper. Utiliser
`.or("webhook_status.is.null,webhook_status.neq.ok")`.

### Nommage de colonnes
`retrait_orders` a historiquement `waafi_number`, mais le code utilise
`numero_waafi` partout. La colonne `numero_waafi` a été ajoutée et les données
recopiées — c'est elle qui fait foi.
