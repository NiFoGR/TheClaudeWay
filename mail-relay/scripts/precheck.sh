#!/usr/bin/env bash
# Run by .github/workflows/deploy-relay.yml before the mail relay is deployed. Checks that GitHub has every setting
# the deploy needs, and that the Cloudflare API token can reach Workers (and the email routing rules when
# INBOUND_ADDRESS is set). Each problem is printed with its fix in plain English, and any problem exits 1, so
# nothing half-set-up is deployed.
# Reads: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, APP_URL, INBOUND_ADDRESS, FORWARD_COPY_TO,
# PRECHECK_REPORT (a file that gets each problem, one per line, for the workflow's last step to repeat), and CF_API
# (tests only). The token is only ever sent to Cloudflare, never printed.
set -uo pipefail

API="${CF_API:-https://api.cloudflare.com/client/v4}"
API="${API%/}"
TOKEN="${CLOUDFLARE_API_TOKEN:-}"
ACC="${CLOUDFLARE_ACCOUNT_ID:-}"
D1_ID="${D1_DATABASE_ID:-}"
APP="${APP_URL:-}"
INBOUND="${INBOUND_ADDRESS:-}"
COPY_TO="${FORWARD_COPY_TO:-}"
REPORT="${PRECHECK_REPORT:-}"

GH="GitHub → Settings → Secrets and variables → Actions"
TOKEN_FIX="Your Cloudflare API token can't deploy Workers. Fix: Cloudflare → My Profile → API Tokens → edit the token GitHub uses → add Account · Workers Scripts · Edit, and Zone · Email Routing Rules · Edit → Save. Then re-run this workflow."
BAD_TOKEN="Cloudflare didn't accept the API token GitHub uses at all: it's wrong, expired or deleted, or it was pasted with a space or line break. Fix: Cloudflare → My Profile → API Tokens → that token → Roll, then paste the new value into $GH → Secrets → CLOUDFLARE_API_TOKEN. Then re-run this workflow."
# Values end up inside quotes in wrangler.toml, so no spaces, quotes or backslashes get through.
EMAIL_RE='^[A-Za-z0-9._+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$'
URL_RE='^https://[A-Za-z0-9.-]+(:[0-9]+)?/?$'
ACCOUNT_RE='^[0-9A-Fa-f]{32}$' # a Cloudflare Account ID is 32 hex characters
UUID_RE='^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$' # a D1 Database ID

problems=0
said=" "
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -z "$REPORT" ] || : > "$REPORT"

# One problem and its fix. In GitHub Actions it's an error annotation, so it also shows on the run's page.
problem() {
  problems=$((problems + 1))
  [ -z "$REPORT" ] || printf '%s\n' "$1" >> "$REPORT"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    local m="${1//\%/%25}"
    m="${m//$'\r'/%0D}"
    echo "::error::${m//$'\n'/%0A}"
  else
    echo "$1"
  fi
}
# Something worth knowing that doesn't stop the deploy (a warning annotation in GitHub Actions).
note() {
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::warning::$1"; else echo "$1"; fi
}
# The same problem found by two checks is said once.
once() {
  case "$said" in *" $1 "*) return ;; esac
  said="$said$1 "
  problem "$2"
}

# GET $API$1 with the token. Sets STATUS (000 when Cloudflare couldn't be reached), BODY and CURL_ERR. The token goes
# in through a file descriptor, so it isn't in curl's command line either.
cf_get() {
  BODY="$WORK/body"
  : > "$BODY"
  STATUS="$(curl -q -sS --connect-timeout 10 --max-time 20 -o "$BODY" -w '%{http_code}' \
    -H @<(printf 'Authorization: Bearer %s\n' "$TOKEN") "$API$1" 2> "$WORK/err")" || true
  [[ "$STATUS" =~ ^[0-9]{3}$ ]] || STATUS=000
  CURL_ERR="$(head -c 300 "$WORK/err" | tr '\n' ' ' | sed 's/ *$//')"
}

# True when the last answer says the token itself isn't valid (as opposed to valid but missing a permission).
# Cloudflare answers a wrong token with HTTP 401 (code 10000) on /workers/scripts but HTTP 403 with "Invalid access
# token" (code 9109) on /zones, and a malformed one (a space, a line break, cut short) with HTTP 400: code 9106, or
# 6003 with 6111 "Invalid format for Authorization header". Code 9109 alone is also used for a missing permission
# ("Unauthorized to access requested resource"), so for it only the message counts.
token_rejected() {
  [ "$STATUS" = 401 ] && return 0
  jq -e '[.errors[]? | ., (.error_chain[]?)] | any(.code == 9106 or .code == 6003 or .code == 6111
    or ((.message // "") | tostring | test("invalid (access|api) token"; "i")))' "$BODY" > /dev/null 2>&1
}

# 0 when the last cf_get worked. Otherwise says what's wrong and returns 1; $1 is the fix for any other 4xx answer.
answered_ok() {
  local errors
  case "$STATUS" in 2??) return 0 ;; 000) ;; *) token_rejected && { once badtoken "$BAD_TOKEN"; return 1; } ;; esac
  case "$STATUS" in
    000) once unreachable "Couldn't reach Cloudflare's API (${CURL_ERR:-no answer}). Wait a minute, then re-run this workflow." ;;
    403) once 403 "$TOKEN_FIX" ;;
    5??) once 5xx "Cloudflare's API isn't working right now (HTTP $STATUS). Wait a few minutes, then re-run this workflow." ;;
    *)
      errors="$(jq -r '[.errors[]?.message | strings] | join("; ")' "$BODY" 2> /dev/null | head -c 300)"
      problem "Cloudflare answered HTTP $STATUS${errors:+ ($errors)}. $1"
      ;;
  esac
  return 1
}

# 1. The settings the deploy fills into wrangler.toml.
if [ -z "$APP" ]; then
  problem "Add a repository variable CONTROL_ROOM_URL (e.g. https://control.aetoswebsites.com): $GH → Variables."
elif ! [[ "$APP" =~ $URL_RE ]]; then
  problem "CONTROL_ROOM_URL must be just the Control Room's address, starting with https:// and with nothing after it (e.g. https://control.aetoswebsites.com). Fix it in $GH → Variables."
fi
[ -n "$TOKEN" ] || problem "Add the repository secret CLOUDFLARE_API_TOKEN (the Cloudflare API token the lead scraper already uses): $GH → Secrets."
if [ -z "$ACC" ]; then
  problem "Add the repository secret CLOUDFLARE_ACCOUNT_ID (Cloudflare → Workers & Pages → Account ID, on the right): $GH → Secrets."
elif ! [[ "$ACC" =~ $ACCOUNT_RE ]]; then
  problem "CLOUDFLARE_ACCOUNT_ID must be just the Account ID: 32 letters and numbers (Cloudflare → Workers & Pages, on the right), with no spaces. Fix it in $GH → Secrets."
  ACC=""
fi
if [ -z "$D1_ID" ]; then
  problem "Add the repository secret D1_DATABASE_ID (Cloudflare → Storage & Databases → D1 → goldbarwebsites → Database ID): $GH → Secrets."
elif ! [[ "$D1_ID" =~ $UUID_RE ]]; then
  problem "D1_DATABASE_ID must be just the Database ID of goldbarwebsites, like 1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f (Cloudflare → Storage & Databases → D1), with no spaces. Fix it in $GH → Secrets."
fi
if [ -n "$INBOUND" ] && ! [[ "$INBOUND" =~ $EMAIL_RE ]]; then
  problem "INBOUND_ADDRESS isn't an email address. Set it to replies@ followed by your receive-only domain (e.g. replies@aetos-mail.co.uk), or delete it: $GH → Variables."
  INBOUND=""
fi
if [ -n "$COPY_TO" ] && ! [[ "$COPY_TO" =~ $EMAIL_RE ]]; then
  problem "FORWARD_COPY_TO isn't an email address. Set it to the Gmail address you verified in Cloudflare Email Routing (Setup → Receiving replies, option B, step 3), or delete it: $GH → Variables."
fi

# 2. The token can reach the account's Workers.
if [ -n "$TOKEN" ] && [ -n "$ACC" ]; then
  cf_get "/accounts/$ACC/workers/scripts"
  if answered_ok "Check CLOUDFLARE_ACCOUNT_ID is your Account ID (Cloudflare → Workers & Pages, on the right): $GH → Secrets. Then re-run this workflow."; then
    echo "OK: the Cloudflare API token can reach your Workers."
  fi
fi

# 3. With INBOUND_ADDRESS, the token can reach its domain's email routing rules (the deploy sets the rule).
# Finding the domain's zone id needs Zone · Zone · Read, which the deploy itself doesn't (wrangler sets the rule with
# Email Routing Rules alone). So a lookup the token isn't allowed, or a domain that isn't on Cloudflare, doesn't stop
# the deploy: the deploy tries the rule, and if it can't, the run ends with how to set it by hand (step A4).
if [ -n "$TOKEN" ] && [ -n "$INBOUND" ]; then
  domain="$(printf '%s' "${INBOUND##*@}" | tr '[:upper:]' '[:lower:]')"
  cf_get "/zones?name=$domain"
  if [[ "$STATUS" == 2?? || ( "$STATUS" == 4?? && "$STATUS" != 429 ) ]] && ! token_rejected; then
    zone=""
    if [[ "$STATUS" == 2?? ]] && command -v jq > /dev/null 2>&1; then
      zone="$(jq -r '.result[0].id // empty' "$BODY" 2> /dev/null)"
    fi
    if [[ "$zone" =~ ^[A-Za-z0-9]+$ ]]; then
      cf_get "/zones/$zone/email/routing/rules"
      if answered_ok "Check Email Routing is switched on for $domain (Setup → Receiving replies, step A3), then re-run this workflow."; then
        echo "OK: the token can reach the email routing rules for $domain."
      fi
    else
      note "Couldn't look up $domain, the domain in INBOUND_ADDRESS: either it isn't on Cloudflare yet (Setup → Receiving replies, steps A1 to A3), or the API token can't list domains (that needs Zone · Zone · Read, which the deploy itself doesn't need). So the email routing rules weren't checked. The deploy still tries to set the rule; if it can't, this run ends with how to set it by hand."
    fi
  else
    answered_ok "Wait a minute, then re-run this workflow." # a rejected token, a 429 or 5xx, or no answer: says which
  fi
fi

if [ "$problems" -gt 0 ]; then
  echo "Nothing was deployed. Fix what's listed above, then re-run this workflow: GitHub → Actions → Deploy mail relay → Run workflow."
  exit 1
fi
echo "All set: deploying the mail relay."
