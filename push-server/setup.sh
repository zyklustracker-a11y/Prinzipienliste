#!/usr/bin/env bash
#
# Einrichtung des Push-Servers – einmal ausfuehren, danach nie wieder noetig.
#
# Legt an: KV-Namespace, VAPID-Schluesselpaar, die drei Worker-Secrets.
# Deployt anschliessend den Worker und gibt am Ende genau die zwei Werte aus,
# die in index.html eingetragen werden muessen.
#
# Voraussetzungen:
#   - Node 18 oder neuer
#   - CLOUDFLARE_API_TOKEN und CLOUDFLARE_ACCOUNT_ID als Umgebungsvariablen
#     (alternativ: vorher `npx wrangler login`)
#
# Aufruf (aus dem Ordner push-server/):
#   bash setup.sh
#
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n\033[31mFehler: %s\033[0m\n\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Node ist nicht installiert."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] && [ ! -f "$HOME/.wrangler/config/default.toml" ]; then
  cat >&2 <<'EOF'

Kein Cloudflare-Zugang gefunden. Zwei Moeglichkeiten:

  a) Token setzen (Dashboard -> My Profile -> API Tokens ->
     Vorlage "Edit Cloudflare Workers"):

       export CLOUDFLARE_API_TOKEN="dein-token"
       export CLOUDFLARE_ACCOUNT_ID="deine-account-id"

  b) Oder interaktiv anmelden:

       npx wrangler login

EOF
  die "Zugang fehlt."
fi

WRANGLER="npx --yes wrangler@latest"

# ── 1. KV-Namespace ────────────────────────────────────────────────────
say "1/5  KV-Namespace fuer die Abos anlegen"
if grep -q 'HIER_TRAEGT_SETUP_SH' wrangler.toml; then
  KV_OUT="$($WRANGLER kv namespace create SUBS 2>&1 || true)"
  echo "$KV_OUT"
  # Wrangler gibt die id je nach Fassung als id = "..." oder "id": "..." aus.
  KV_ID="$(printf '%s' "$KV_OUT" | grep -oE '(id *= *"|"id" *: *")[a-f0-9]{32}' | grep -oE '[a-f0-9]{32}' | head -1)"
  [ -n "$KV_ID" ] || die "Konnte die KV-Namespace-ID nicht aus der Ausgabe lesen. Bitte oben nachsehen und in wrangler.toml bei id = eintragen."
  # Plattformunabhaengig ersetzen (macOS-sed braucht ein Argument bei -i).
  node -e '
    const fs=require("fs");
    const p="wrangler.toml";
    fs.writeFileSync(p, fs.readFileSync(p,"utf8").replace("HIER_TRAEGT_SETUP_SH_DIE_KV_ID_EIN", process.argv[1]));
  ' "$KV_ID"
  echo "   -> KV-Namespace $KV_ID in wrangler.toml eingetragen"
else
  echo "   -> wrangler.toml enthaelt bereits eine KV-ID, uebersprungen"
fi

# ── 2. VAPID-Schluessel ────────────────────────────────────────────────
say "2/5  VAPID-Schluesselpaar erzeugen"
VAPID_JSON="$(node generate-vapid.mjs --json)"
VAPID_PUBLIC="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).publicKey)'  "$VAPID_JSON")"
VAPID_PRIVATE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).privateKey)' "$VAPID_JSON")"
echo "   -> erzeugt (der private Schluessel wird gleich nur als Secret abgelegt)"

# ── 3. Gemeinsames Geheimnis ───────────────────────────────────────────
say "3/5  Gemeinsames Geheimnis erzeugen"
SHARED="$(node -e 'process.stdout.write(Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url"))')"
echo "   -> erzeugt"

# ── 4. Secrets setzen ──────────────────────────────────────────────────
say "4/5  Worker-Secrets setzen"
printf '%s' "$VAPID_PUBLIC"  | $WRANGLER secret put VAPID_PUBLIC_KEY
printf '%s' "$VAPID_PRIVATE" | $WRANGLER secret put VAPID_PRIVATE_KEY
printf '%s' "$SHARED"        | $WRANGLER secret put SHARED_SECRET

# ── 5. Deploy ──────────────────────────────────────────────────────────
say "5/5  Worker veroeffentlichen"
DEPLOY_OUT="$($WRANGLER deploy 2>&1)"
echo "$DEPLOY_OUT"
WORKER_URL="$(printf '%s' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)"

cat <<EOF

────────────────────────────────────────────────────────────────────
  FERTIG. Diese drei Werte in index.html eintragen
  (Abschnitt "PUSH-SERVER" ganz oben im grossen <script>):
────────────────────────────────────────────────────────────────────

  PUSH_SERVER_URL = "${WORKER_URL:-<siehe Ausgabe oben>}";

  VAPID_PUBLIC_KEY = "$VAPID_PUBLIC";

  PUSH_SHARED_SECRET = "$SHARED";

────────────────────────────────────────────────────────────────────
  Der private VAPID-Schluessel liegt ausschliesslich als Worker-Secret
  und wurde nirgends gespeichert. Braucht man ihn erneut, erzeugt man
  einfach ein neues Paar (dann muss der oeffentliche Schluessel in
  index.html mit und die Erinnerung einmal neu aktiviert werden).

  Kurzer Funktionstest:
    curl ${WORKER_URL:-<worker-url>}/health
────────────────────────────────────────────────────────────────────

EOF
