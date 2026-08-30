#!/usr/bin/env bash
# The session registry, end to end: a session registers itself, says things,
# blocks, gets a message from the phone, and a relay delivers it.
#
# Companion to test-flow.sh, which covers requests and calls. Kept separate
# because it needs the hook script and the relay script as well as the server,
# and a failure in one should not obscure the other.
set -uo pipefail

BASE="${BASE:-http://localhost:8790}"
HERE="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$HERE/.env"; set +a
AGENT="${AGENT_TOKENS%%,*}"
CLIENT="${CLIENT_TOKENS%%,*}"
RELAY="${TETHER_RELAY:-test-relay}"

pass=0; fail=0
check() { if echo "$3" | grep -q "$2"; then echo "  PASS  $1"; pass=$((pass+1));
          else echo "  FAIL  $1 — wanted [$2] in: $3"; fail=$((fail+1)); fi; }

A=(-H "Authorization: Bearer $AGENT")
C=(-H "Authorization: Bearer $CLIENT")
J=(-H 'Content-Type: application/json')

# Distinct ids per run: the registry is durable, and a rerun must not collide
# with the rows the last one left behind.
STAMP=$$
S="test-session-$STAMP"
G="test-agent-$STAMP"

hook() { TETHER_URL="$BASE" TETHER_AGENT_TOKEN="$AGENT" TETHER_RELAY="$RELAY" \
         node "$HERE/hooks/tether-hook.mjs"; }
relay() { TETHER_URL="$BASE" TETHER_AGENT_TOKEN="$AGENT" TETHER_RELAY="$RELAY" \
          node "$HERE/relay/relay.mjs" "$@"; }
sessions() { curl -sS "${C[@]}" "$BASE/api/sessions"; }
one() { curl -sS "${C[@]}" "$BASE/api/sessions/$1"; }

echo "== 1. a session registers itself through its hooks =="
echo "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$S\",\"cwd\":\"/srv/example\"}" | hook
V=$(sessions)
check "it appears" "\"externalId\":\"$S\"" "$V"
check "titled from its working directory" '"title":"example"' "$V"
check "and is addressable" '"transport":"relay"' "$V"

SID=$(sessions | python3 -c "
import json,sys
for s in json.load(sys.stdin)['sessions']:
    if s['externalId']=='$S': print(s['id'])")
[ -n "$SID" ] || { echo "  FATAL no session id"; exit 1; }

echo "== 2. hooks keep its state honest =="
echo "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"$S\"}" | hook
check "a prompt means working" '"state":"working"' "$(one "$SID")"
echo "{\"hook_event_name\":\"Stop\",\"session_id\":\"$S\",\"last_assistant_message\":\"Deployed and healthy.\"}" | hook
check "the end of a turn means idle" '"state":"idle"' "$(one "$SID")"
check "and what it said is kept" 'Deployed and healthy' "$(curl -sS "${C[@]}" "$BASE/api/sessions/$SID/messages")"

echo "== 3. agents are not sessions =="
echo "{\"hook_event_name\":\"SubagentStart\",\"session_id\":\"$S\",\"agent_id\":\"$G\",\"agent_type\":\"Explore\"}" | hook
V=$(sessions)
check "a subagent nests under its parent" '"agentType":"Explore"' "$V"
check "and is not a top-level row" 'nested-only' "$(echo "$V" | python3 -c "
import json,sys
d=json.load(sys.stdin)['sessions']
print('TOP-LEVEL' if any(s['externalId']=='$G' for s in d) else 'nested-only')")"
AID=$(one "$G" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
check "a subagent refuses messages, and explains" 'no inbox' \
  "$(curl -sS -X POST "${C[@]}" "${J[@]}" "$BASE/api/sessions/$AID/messages" -d '{"text":"hi"}')"
echo "{\"hook_event_name\":\"SubagentStop\",\"session_id\":\"$S\",\"agent_id\":\"$G\",\"last_assistant_message\":\"Found 3 call sites.\"}" | hook
check "it leaves its findings behind" 'Found 3 call sites' \
  "$(curl -sS "${C[@]}" "$BASE/api/sessions/$AID/messages")"

echo "== 4. blocking reaches the human =="
echo "{\"hook_event_name\":\"Notification\",\"session_id\":\"$S\",\"notification_type\":\"permission\",\"notification_text\":\"Claude needs permission to run: rm -rf build\"}" | hook
V=$(one "$SID")
check "it is marked waiting" '"state":"waiting"' "$V"
check "with the reason attached" 'permission to run' "$V"
# The alert is raised out of band — rendering a call to speech outlives the
# hook that triggered it — so this polls rather than reading once.
ALERT=""
for _ in $(seq 1 20); do
  ALERT=$(curl -sS "${C[@]}" "$BASE/api/requests" | grep -o 'example needs you' | head -1)
  [ -n "$ALERT" ] && break
  sleep 1
done
check "and the human is alerted" 'example needs you' "$ALERT"

BEFORE=$(curl -sS "${C[@]}" "$BASE/api/requests?all=1" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["requests"]))')
echo "{\"hook_event_name\":\"Notification\",\"session_id\":\"$S\",\"notification_type\":\"permission\",\"notification_text\":\"Claude needs permission to run: rm -rf build\"}" | hook
AFTER=$(curl -sS "${C[@]}" "$BASE/api/requests?all=1" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["requests"]))')
check "reporting it twice does not alert twice" "^$BEFORE\$" "$AFTER"

echo "== 5. the phone sends, the relay delivers =="
Q=$(curl -sS -X POST "${C[@]}" "${J[@]}" "$BASE/api/sessions/$SID/messages" -d '{"text":"yes, go ahead"}')
check "queued rather than claimed as sent" '"delivery":"queued"' "$Q"
MID=$(echo "$Q" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')

O=$(relay poll --wait 2)
check "the relay is handed the text" 'yes, go ahead' "$O"
check "and told how to address the target" "to: $S" "$O"
check "another relay is handed nothing" 'nothing queued' \
  "$(TETHER_URL="$BASE" TETHER_AGENT_TOKEN="$AGENT" TETHER_RELAY=someone-else \
     node "$HERE/relay/relay.mjs" poll --wait 1)"

relay ack "$MID" >/dev/null
check "acking marks it delivered" '"delivery":"delivered"' \
  "$(curl -sS "${C[@]}" "$BASE/api/sessions/$SID/messages")"
check "and empties the queue" 'nothing queued' "$(relay poll --wait 1)"

echo "== 6. a failed delivery stays visible =="
Q2=$(curl -sS -X POST "${C[@]}" "${J[@]}" "$BASE/api/sessions/$SID/messages" -d '{"text":"this one is lost"}')
MID2=$(echo "$Q2" | python3 -c 'import json,sys;print(json.load(sys.stdin)["id"])')
relay poll --wait 1 >/dev/null
relay fail "$MID2" "no peer named $S" >/dev/null
M=$(curl -sS "${C[@]}" "$BASE/api/sessions/$SID/messages")
check "marked failed, not delivered" '"delivery":"failed"' "$M"
check "with the reason the relay gave" "no peer named $S" "$M"

echo "== 7. the hook cannot break a session =="
OUT=$(echo 'not json' | hook 2>&1; echo "exit=$?")
check "malformed input is silent and clean" '^exit=0$' "$OUT"
OUT=$(TETHER_URL=http://127.0.0.1:9 sh -c "echo '{\"hook_event_name\":\"Stop\",\"session_id\":\"$S\"}' | TETHER_AGENT_TOKEN=$AGENT node '$HERE/hooks/tether-hook.mjs'" 2>&1; echo "exit=$?")
check "an unreachable server is silent and clean" '^exit=0$' "$OUT"

echo "== 8. auth is not decorative =="
check "a client token cannot register a session" '401' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${C[@]}" "${J[@]}" "$BASE/api/sessions/register" -d '{"externalId":"x"}')"
check "an agent token cannot read the list" '401' \
  "$(curl -sS -o /dev/null -w '%{http_code}' "${A[@]}" "$BASE/api/sessions")"
check "an agent token cannot speak as the human" '401' \
  "$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${A[@]}" "${J[@]}" "$BASE/api/sessions/$SID/messages" -d '{"text":"x"}')"

echo "== 9. ending is tidy =="
echo "{\"hook_event_name\":\"SessionEnd\",\"session_id\":\"$S\",\"reason\":\"exit\"}" | hook
check "the session ends" '"state":"ended"' "$(one "$SID")"
check "and takes its subagents with it" '"state":"ended"' "$(one "$AID")"
check "it leaves the home page" 'gone' "$(sessions | python3 -c "
import json,sys
d=json.load(sys.stdin)['sessions']
print('STILL THERE' if any(s['externalId']=='$S' for s in d) else 'gone')")"
check "but its transcript survives" 'Deployed and healthy' \
  "$(curl -sS "${C[@]}" "$BASE/api/sessions/$SID/messages")"

echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ]
