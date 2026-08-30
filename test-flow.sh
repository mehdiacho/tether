#!/usr/bin/env bash
# End-to-end smoke test: an agent asks a blocking question, a client answers it,
# and the agent's blocked call returns with the answer.
#
# This is the one behaviour that has to work. Everything else is packaging.
set -uo pipefail

BASE="${BASE:-http://localhost:8790}"
set -a; . "$(dirname "$0")/.env"; set +a
AGENT="${AGENT_TOKENS%%,*}"
CLIENT="${CLIENT_TOKENS%%,*}"

pass=0; fail=0
check() { if [ "$1" = "$2" ]; then echo "  PASS  $3"; pass=$((pass+1)); else echo "  FAIL  $3 (got '$1' want '$2')"; fail=$((fail+1)); fi; }

mcp() {
  curl -sS --max-time 120 -X POST "$BASE/mcp" \
    -H "Authorization: Bearer $AGENT" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d "$1"
}

echo "== 1. auth =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" -H 'Content-Type: application/json' -d '{}')
check "$code" "401" "unauthenticated MCP call rejected"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/requests" -H "Authorization: Bearer $AGENT")
check "$code" "401" "agent token cannot read the client API"

echo "== 2. tool discovery =="
tools=$(mcp '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | tr -d '\r')
for t in notify ask request_action collect cancel speak call schedule_create schedule_list schedule_delete; do
  echo "$tools" | grep -q "\"$t\"" && { echo "  PASS  tool: $t"; pass=$((pass+1)); } || { echo "  FAIL  tool: $t"; fail=$((fail+1)); }
done

echo "== 3. notify =="
out=$(mcp '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"notify","arguments":{"title":"Smoke test","body":"notify works","priority":"low"}}}')
echo "$out" | grep -q "Sent" && { echo "  PASS  notify returned"; pass=$((pass+1)); } || { echo "  FAIL  notify: $out"; fail=$((fail+1)); }

echo "== 4. blocking ask =="
# Fire the ask in the background; it must NOT return until answered.
mcp '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"ask","arguments":{"question":"Deploy to prod?","choices":["Yes","No"],"timeout_sec":60}}}' > /tmp/ask.out 2>&1 &
ASK_PID=$!
sleep 3

[ -s /tmp/ask.out ] && { echo "  FAIL  ask returned early (should block)"; fail=$((fail+1)); } \
                    || { echo "  PASS  ask is blocking"; pass=$((pass+1)); }

ID=$(curl -sS "$BASE/api/requests" -H "Authorization: Bearer $CLIENT" \
     | python -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['id'] if r else '')")
[ -n "$ID" ] && { echo "  PASS  request visible to client ($ID)"; pass=$((pass+1)); } \
             || { echo "  FAIL  no pending request"; fail=$((fail+1)); }

curl -sS -X POST "$BASE/api/requests/$ID/answer" -H "Authorization: Bearer $CLIENT" \
  -H 'Content-Type: application/json' -d '{"answer":"Yes"}' > /dev/null

wait $ASK_PID
grep -q "ANSWERED: Yes" /tmp/ask.out && { echo "  PASS  agent resumed with the answer"; pass=$((pass+1)); } \
                                     || { echo "  FAIL  agent got: $(cat /tmp/ask.out)"; fail=$((fail+1)); }

echo "== 5. double-answer race =="
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/requests/$ID/answer" \
       -H "Authorization: Bearer $CLIENT" -H 'Content-Type: application/json' -d '{"answer":"No"}')
check "$code" "409" "second answer rejected"

echo "== 6. collect after the fact =="
out=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"collect\",\"arguments\":{\"request_id\":\"$ID\"}}}")
echo "$out" | grep -q "ANSWERED: Yes" && { echo "  PASS  resolved answer is recoverable"; pass=$((pass+1)); } \
                                      || { echo "  FAIL  collect: $out"; fail=$((fail+1)); }

echo "== 7. refusal is distinct from timeout =="
mcp '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"ask","arguments":{"question":"Delete prod DB?","timeout_sec":60}}}' > /tmp/ask2.out 2>&1 &
P2=$!
sleep 2
ID2=$(curl -sS "$BASE/api/requests" -H "Authorization: Bearer $CLIENT" \
      | python -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['id'] if r else '')")
curl -sS -X POST "$BASE/api/requests/$ID2/answer" -H "Authorization: Bearer $CLIENT" \
  -H 'Content-Type: application/json' -d '{"refused":true}' > /dev/null
wait $P2
grep -q "REFUSED" /tmp/ask2.out && { echo "  PASS  refusal surfaced distinctly"; pass=$((pass+1)); } \
                                || { echo "  FAIL  got: $(cat /tmp/ask2.out)"; fail=$((fail+1)); }


echo "== 8. one-tap action token =="
mcp '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ask","arguments":{"question":"One-tap probe","choices":["Go"],"timeout_sec":60}}}' > /tmp/ask3.out 2>&1 &
P3=$!
sleep 2
read -r ID3 TOK3 <<<"$(curl -sS "$BASE/api/requests" -H "Authorization: Bearer $CLIENT"   | python -c "import sys,json; r=json.load(sys.stdin)['requests']; print(r[0]['id'], r[0]['actionToken']) if r else print(' ')")"

# A wrong token must not answer, or the notification payload becomes a skeleton key.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/a/$ID3/wrongtoken?answer=Go")
check "$code" "404" "wrong action token rejected"

# The right token answers exactly this one request.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/a/$ID3/$TOK3?answer=Go")
check "$code" "200" "correct action token accepted"

wait $P3
grep -q "ANSWERED: Go" /tmp/ask3.out && { echo "  PASS  one-tap answer reached the agent"; pass=$((pass+1)); }                                      || { echo "  FAIL  got: $(cat /tmp/ask3.out)"; fail=$((fail+1)); }

# Replaying a spent token must not resolve anything else.
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/a/$ID3/$TOK3?answer=Go")
check "$code" "409" "spent action token cannot re-answer"

echo "== 9. web UI =="
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/")
check "$code" "200" "web UI served"

echo "== 10. call: speaks, and the recording survives =="
out=$(mcp '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"call","arguments":{"text":"[warmly] Smoke test. The recording should be replayable.","title":"Smoke call"}}}')
echo "$out" | grep -q "recording is saved" && { echo "  PASS  call placed with voice"; pass=$((pass+1)); } || { echo "  FAIL  call: $out"; fail=$((fail+1)); }

read -r CID CTOK CAUD <<<"$(curl -sS "$BASE/api/requests?all=1" -H "Authorization: Bearer $CLIENT" | python -c "import sys,json; r=[x for x in json.load(sys.stdin)['requests'] if x['kind']=='call']; print(r[0]['id'], r[0]['actionToken'], r[0]['audioId']) if r else print('  ')")"
[ -n "$CAUD" ] && [ "$CAUD" != "None" ] && { echo "  PASS  call has a recording"; pass=$((pass+1)); } || { echo "  FAIL  call has no audio"; fail=$((fail+1)); }

# Playback is authorised by the request's own token, not a client token, because
# the URL rides inside a notification payload.
code=$(curl -s -o ./.call-test.mp3 -w '%{http_code}' "$BASE/v/$CID/$CTOK")
check "$code" "200" "recording plays back via the action token"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v/$CID/wrongtoken")
check "$code" "404" "wrong token cannot fetch the recording"

size=$(wc -c < ./.call-test.mp3)
[ "$size" -gt 4000 ] && { echo "  PASS  recording is real audio ($size bytes)"; pass=$((pass+1)); } || { echo "  FAIL  recording too small ($size bytes)"; fail=$((fail+1)); }

# The lead-in is the whole point: the file must open with silent frames, not speech.
lead=$(python -c "
d=open('./.call-test.mp3','rb').read()
f=d[:417]
n=0
while d[n*417:(n+1)*417] == f:
    n+=1
print(n)
")
[ "${lead:-0}" -ge 20 ] && { echo "  PASS  lead-in present ($lead silent frames, ~$((lead*26))ms)"; pass=$((pass+1)); } || { echo "  FAIL  lead-in missing (got '$lead' frames)"; fail=$((fail+1)); }
rm -f ./.call-test.mp3

echo "== 11. schedules =="
out=$(mcp '{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"schedule_create","arguments":{"cron":"0 25 * * *","timezone":"Africa/Gaborone","title":"bad","body":"bad"}}}')
echo "$out" | grep -q "Could not create it" && { echo "  PASS  invalid cron rejected"; pass=$((pass+1)); } || { echo "  FAIL  bad cron accepted: $out"; fail=$((fail+1)); }

out=$(mcp '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"schedule_create","arguments":{"cron":"0 7 * * *","timezone":"Not/AZone","title":"bad","body":"bad"}}}')
echo "$out" | grep -q "not a recognised IANA timezone" && { echo "  PASS  invalid timezone rejected"; pass=$((pass+1)); } || { echo "  FAIL  bad tz accepted: $out"; fail=$((fail+1)); }

out=$(mcp '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"schedule_create","arguments":{"cron":"0 7 * * *","timezone":"Africa/Gaborone","kind":"call","title":"Seedlings out","body":"Morning. Time to put the seedlings out in the sun."}}}')
echo "$out" | grep -q "T07:00 Africa/Gaborone" && { echo "  PASS  schedule created, next run in the right zone"; pass=$((pass+1)); } || { echo "  FAIL  schedule_create: $out"; fail=$((fail+1)); }

SID=$(curl -sS "$BASE/api/schedules" -H "Authorization: Bearer $CLIENT" | python -c "import sys,json; s=json.load(sys.stdin)['schedules']; print(s[0]['id'] if s else '')")
[ -n "$SID" ] && { echo "  PASS  schedule visible over REST"; pass=$((pass+1)); } || { echo "  FAIL  schedule not listed"; fail=$((fail+1)); }

out=$(mcp '{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"schedule_list","arguments":{}}}')
echo "$out" | grep -q "Seedlings out" && { echo "  PASS  schedule_list shows it"; pass=$((pass+1)); } || { echo "  FAIL  schedule_list: $out"; fail=$((fail+1)); }

out=$(mcp "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"tools/call\",\"params\":{\"name\":\"schedule_delete\",\"arguments\":{\"schedule_id\":\"$SID\"}}}")
echo "$out" | grep -q "Deleted" && { echo "  PASS  schedule deleted"; pass=$((pass+1)); } || { echo "  FAIL  schedule_delete: $out"; fail=$((fail+1)); }


echo
echo "passed $pass, failed $fail"
[ "$fail" -eq 0 ] || exit 1
