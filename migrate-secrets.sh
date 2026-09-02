#!/usr/bin/env bash
# migrate-secrets.sh — Lit les secrets depuis GCP Secret Manager et les pousse vers Supabase
# Usage : SUPABASE_ACCESS_TOKEN=<ton_token> ./migrate-secrets.sh
# Pré-requis : gcloud (authentifié), npx supabase

set -euo pipefail

GCP_PROJECT="kaffi-pay"
SUPABASE_REF="pasotcpwvdtpidelrqic"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "❌  SUPABASE_ACCESS_TOKEN manquant."
  echo "    Crée un token sur https://supabase.com/dashboard/account/tokens"
  echo "    Puis : SUPABASE_ACCESS_TOKEN=xxx ./migrate-secrets.sh"
  exit 1
fi

read_secret() {
  local name="$1"
  gcloud secrets versions access latest \
    --secret="$name" \
    --project="$GCP_PROJECT" 2>/dev/null || echo ""
}

echo "📖  Lecture des secrets depuis GCP Secret Manager (projet : $GCP_PROJECT)..."

TELEGRAM_TOKEN=$(read_secret "TELEGRAM_TOKEN")
TELEGRAM_ADMIN_CHAT_ID=$(read_secret "TELEGRAM_ADMIN_CHAT_ID")
SUPPORT_BOT_TOKEN=$(read_secret "SUPPORT_BOT_TOKEN")
GREEN_API_ID=$(read_secret "GREEN_API_ID")
GREEN_API_TOKEN=$(read_secret "GREEN_API_TOKEN")
MACRODROID_SECRET=$(read_secret "MACRODROID_SECRET")
MOBCASH_HASH=$(read_secret "MOBCASH_HASH")
MOBCASH_CASHIERPASS=$(read_secret "MOBCASH_CASHIERPASS")
MOBCASH_CASHDESKID=$(read_secret "MOBCASH_CASHDESKID")
CRON_SECRET=$(read_secret "CRON_SECRET")

echo "✅  Secrets récupérés. Push vers Supabase..."

export SUPABASE_ACCESS_TOKEN

npx supabase secrets set \
  TELEGRAM_TOKEN="$TELEGRAM_TOKEN" \
  TELEGRAM_ADMIN_CHAT_ID="$TELEGRAM_ADMIN_CHAT_ID" \
  SUPPORT_BOT_TOKEN="$SUPPORT_BOT_TOKEN" \
  GREEN_API_ID="$GREEN_API_ID" \
  GREEN_API_TOKEN="$GREEN_API_TOKEN" \
  MACRODROID_SECRET="$MACRODROID_SECRET" \
  MOBCASH_HASH="$MOBCASH_HASH" \
  MOBCASH_CASHIERPASS="$MOBCASH_CASHIERPASS" \
  MOBCASH_CASHDESKID="$MOBCASH_CASHDESKID" \
  CRON_SECRET="$CRON_SECRET" \
  --project-ref "$SUPABASE_REF"

echo ""
echo "🎉  Tous les secrets sont configurés sur Supabase !"
echo "    Vérifie sur : https://supabase.com/dashboard/project/$SUPABASE_REF/functions"
