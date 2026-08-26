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
