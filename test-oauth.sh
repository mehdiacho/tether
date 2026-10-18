#!/usr/bin/env bash
# End-to-end test of the OAuth flow a claude.ai connector runs: discovery,
# registration, consent answered on the "phone", PKCE code exchange, an MCP
# call with the access token, and refresh-token rotation.
#
# Needs a server running with OAUTH_ENABLED=1 and the .env tokens.
set -uo pipefail

BASE="${BASE:-http://localhost:8790}"
set -a; . "$(dirname "$0")/.env"; set +a
CLIENT="${CLIENT_TOKENS%%,*}"

pass=0; fail=0
check() { if [ "$1" = "$2" ]; then echo "  PASS  $3"; pass=$((pass+1)); else echo "  FAIL  $3 (got '$1' want '$2')"; fail=$((fail+1)); fi; }
json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const v=JSON.parse(s)$1;console.log(v===undefined?'':v)})"; }

echo "== 1. discovery =="
hdr=$(curl -s -D - -o /dev/null -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}' | tr -d '\r' | grep -i '^www-authenticate' || true)
echo "$hdr" | grep -q 'resource_metadata=' && check ok ok "401 from /mcp names the resource metadata" || check "$hdr" "resource_metadata" "401 header"
as=$(curl -s "$BASE/.well-known/oauth-protected-resource" | json '.authorization_servers[0]')
check "$as" "$BASE" "protected resource points at this server"
tok_ep=$(curl -s "$BASE/.well-known/oauth-authorization-server" | json '.token_endpoint')
check "$tok_ep" "$BASE/oauth/token" "authorization server metadata"

echo "== 2. registration =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/register" -H 'Content-Type: application/json' -d '{"redirect_uris":["http://evil.example/cb"]}')
check "$code" "400" "plain-http non-loopback redirect refused"
REDIRECT="https://claude.ai/api/mcp/auth_callback"
CID=$(curl -s -X POST "$BASE/oauth/register" -H 'Content-Type: application/json' \
  -d "{\"client_name\":\"Claude\",\"redirect_uris\":[\"$REDIRECT\"]}" | json '.client_id')
[ -n "$CID" ] && check ok ok "client registered" || check "" "client_id" "register"

echo "== 3. consent =="
VERIFIER=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
CHALLENGE=$(node -e "console.log(require('crypto').createHash('sha256').update('$VERIFIER').digest('base64url'))")
q="response_type=code&client_id=$CID&redirect_uri=$REDIRECT&code_challenge=$CHALLENGE&code_challenge_method=S256&state=xyz&resource=$BASE/mcp"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/oauth/authorize?${q/S256/plain}")
check "$code" "400" "non-S256 PKCE refused"
page=$(curl -s "$BASE/oauth/authorize?$q")
PID=$(echo "$page" | grep -o '/oauth/authorize/[0-9a-f-]*/status' | head -1 | cut -d/ -f4)
[ -n "$PID" ] && check ok ok "consent page served" || check "" "pending id" "consent page"
state=$(curl -s "$BASE/oauth/authorize/$PID/status" | json '.state')
check "$state" "pending" "waits for the human"
RID=$(curl -s "$BASE/api/requests" -H "Authorization: Bearer $CLIENT" | json ".requests.find(r=>r.title==='Connect Claude to Tether?').id")
[ -n "$RID" ] && check ok ok "consent ask reached the phone queue" || check "" "request" "consent ask"
curl -s -o /dev/null -X POST "$BASE/api/requests/$RID/answer" -H "Authorization: Bearer $CLIENT" -H 'Content-Type: application/json' -d '{"answer":"Allow"}'
loc=$(curl -s "$BASE/oauth/authorize/$PID/status" | json '.redirect')
case "$loc" in "$REDIRECT?code="*"state=xyz"*) check ok ok "Allow redirects with a code and the state" ;; *) check "$loc" "code+state" "redirect" ;; esac
CODE=$(node -e "console.log(new URL('$loc').searchParams.get('code'))")

echo "== 4. token =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/token" -d "grant_type=authorization_code&code=$CODE&client_id=$CID&redirect_uri=$REDIRECT&code_verifier=wrong")
check "$code" "400" "wrong PKCE verifier refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/token" -d "grant_type=authorization_code&code=$CODE&client_id=$CID&redirect_uri=$REDIRECT&code_verifier=$VERIFIER")
check "$code" "400" "a code is single-use, even after a failed attempt"

# A fresh code, exchanged properly this time.
page=$(curl -s "$BASE/oauth/authorize?$q")
PID=$(echo "$page" | grep -o '/oauth/authorize/[0-9a-f-]*/status' | head -1 | cut -d/ -f4)
loc=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/oauth/authorize/$PID" --data-urlencode "client_token=$CLIENT")
CODE=$(node -e "console.log(new URL('$loc').searchParams.get('code'))")
[ -n "$CODE" ] && check ok ok "client token on the page approves too" || check "" "code" "token approval"
tokens=$(curl -s -X POST "$BASE/oauth/token" -d "grant_type=authorization_code&code=$CODE&client_id=$CID&redirect_uri=$REDIRECT&code_verifier=$VERIFIER")
AT=$(echo "$tokens" | json '.access_token'); RT=$(echo "$tokens" | json '.refresh_token')
[ -n "$AT" ] && [ -n "$RT" ] && check ok ok "code exchanged for access + refresh" || check "$tokens" "tokens" "exchange"

echo "== 5. MCP with the access token =="
tools=$(curl -sS -X POST "$BASE/mcp" -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')
echo "$tools" | grep -q '"ask"' && check ok ok "tools/list works" || check "$tools" "ask" "tools/list"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/requests" -H "Authorization: Bearer $AT")
check "$code" "401" "an access token cannot read or answer the client API"

echo "== 6. refresh =="
new=$(curl -s -X POST "$BASE/oauth/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID")
AT2=$(echo "$new" | json '.access_token')
[ -n "$AT2" ] && [ "$AT2" != "$AT" ] && check ok ok "refresh issues a new access token" || check "$new" "new token" "refresh"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/oauth/token" -d "grant_type=refresh_token&refresh_token=$RT&client_id=$CID")
check "$code" "400" "a used refresh token is dead"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
