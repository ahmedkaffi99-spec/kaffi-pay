# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Kaffi Pay is a **1xBet ↔ Waafi mobile-money exchange platform** serving the Djibouti market (UI is entirely in French). Clients deposit Waafi funds to receive 1xBet credits, or withdraw 1xBet winnings back to Waafi. The project is a Firebase-hosted Progressive Web App (PWA) with no build step.

## Repository Structure

This is not a standard Node/framework project. There is no `src/`, no bundler, and no test suite.

```
index-19-1.html       # Entire frontend application (~2500 lines, inline JS + CSS)
functions_index.js    # Firebase Cloud Functions backend (Node.js 20)
functions_package.json
firebase.json         # Hosting + Functions deployment config
manifest.json         # PWA manifest
sw.js                 # Service Worker (network-first for API, cache-first for assets)
```

## Deployment Commands

```bash
# Install Cloud Functions dependencies (run once from repo root)
npm install --prefix functions   # or manually: cd functions && npm install

# Deploy everything
firebase deploy

# Deploy only hosting (the HTML file)
firebase deploy --only hosting

# Deploy only Cloud Functions
firebase deploy --only functions

# Local emulation
firebase emulators:start --only functions   # Functions only
firebase serve                              # Full local hosting preview

# View function logs
firebase functions:log
```

There is no linting, no build script, and no automated tests configured.

## Architecture

### Frontend (`index-19-1.html`)

The entire client app lives in a single HTML file with inline `<script>` and `<style>` blocks.

**Screen routing** is manual — `showScreen('screen-name')` swaps visibility between:
- `login-screen` — username/password form
- `client-screen` — order submission (Dépôt / Retrait tabs)
- `admin-screen` — dashboard, orders table, reserves, agents

**Authentication** uses plain-text credentials stored in `config/agents` Firestore document. There is no Firebase Auth. Role-based access distinguishes `créateur` (admin) from `opérateur` (agent).

**State management** uses in-memory caches (`_txsCache`, `_agentsCache`, `_reservesCache`) kept in sync via Firestore `onSnapshot()` real-time listeners.

### Backend (`functions_index.js`)

Five Cloud Functions, all triggered by Firestore writes:

| Function | Trigger | Purpose |
|---|---|---|
| `onNouvelOrdre` | New doc in `orders/` | Duplicate Transfer ID check + Gemini fraud score (0–100) |
| `onOrdreUpdated` | Status field change in `orders/` | WhatsApp notification (pending Meta API setup) |
| `geminiAnalyseAdmin` | New doc in `admin_analyses/` | Gemini summary of last 100 transactions |
| `geminiVerifPreuve` | New doc in `verif_requests/` | Gemini Vision validates payment proof image |
| `autoConfirmation` | New doc in `waafi_notifications/` | Parses MacroDroid SMS → auto-confirms matching order → triggers 1xBet webhook |

### Data Flow

```
MacroDroid (Android app)
  ↓ intercepts Waafi SMS
  ↓ writes to waafi_notifications/
Cloud Function: autoConfirmation
  ↓ matches SMS to pending order (Transfer ID or amount+number, ±5 DJF tolerance)
  ↓ updates orders/{id}.status = "Confirmé"
  ↓ calls MacroDroid webhook → credits 1xBet account
```

### Firestore Collections

- **`orders/`** — transactions (fields: `type`, `montant`, `status`, `userId1xBet`, `waafitranfertID`, `numeroPayment`, `waafiNumber`, `ia_score_fraude`, `confirmedBy`, `webhookStatus`, etc.)
- **`config/agents`** — single doc with `list[]` of `{name, user, pass, role}`
- **`config/reserves`** — single doc with `data.r1x`, `data.rW`, `data.r1x_base`, `data.rW_base` (float balances in DJF)
- **`waafi_notifications/`** — SMS payloads from MacroDroid (`status`: `nouveau` → `traité` / `non_matché` / `montant_incorrect`)
- **`admin_analyses/`** / **`verif_requests/`** — trigger collections for on-demand Gemini calls

## Key Conventions

- **Firebase config** is embedded in `index-19-1.html` (lines ~24–33). The public API key is intentional for web apps; security is enforced via Firestore Rules.
- **`GEMINI_KEY`** is a Firebase Secret (`defineSecret("GEMINI_KEY")`), not in source.
- **MacroDroid webhook secret** `"KaffiPay2026"` is hardcoded in `functions_index.js` — treat as sensitive.
- The Gemini model in use is `gemini-2.0-flash`.
- Order IDs are date-prefixed strings (`"20260XXXXXX"` format).
- All monetary values are in **DJF (Djiboutian Franc)**.
- Dépôt minimum: 50 DJF. Retrait minimum: 250 DJF.
- Firebase Functions are deployed to **europe-west1** region.

## External Integrations

- **MacroDroid** — Android automation app that intercepts Waafi payment SMS and writes to `waafi_notifications/`. It also receives outbound webhooks to credit 1xBet accounts.
- **Waafi** — Djibouti mobile money service. Payments go to account `77275572`.
- **Google Gemini API** — Used for fraud detection, transaction analysis, and proof image verification.
- **WhatsApp Business API** (Meta) — Integrated in code but not yet live; requires Meta API credentials.
