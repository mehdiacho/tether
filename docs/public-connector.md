# Tether as a claude.ai connector

**Status:** built and tested end to end against a local server (`test-oauth.sh`), 2026-10-17. Not yet deployed behind the tunnel.

Cloud agents (claude.ai project threads, the Claude apps, cloud Claude Code sessions) cannot reach a LAN-only Tether, and claude.ai connectors authenticate with OAuth rather than a static bearer header. With `OAUTH_ENABLED=1`, `/mcp` speaks the MCP authorization spec so Tether can be added under **Settings → Connectors → Add custom connector** with the URL `https://<your tunnel host>/mcp`.

## What a connection looks like

1. claude.ai calls `/mcp`, gets a 401 whose `WWW-Authenticate` header points at `/.well-known/oauth-protected-resource`.
2. It reads the authorization-server metadata, registers itself (`POST /oauth/register`, dynamic client registration) and opens `/oauth/authorize` with a PKCE S256 challenge.
3. **Tether asks you.** The authorize page raises an `ask` on your phone: *Connect Claude to Tether?* with Allow and Deny. Only Allow issues a code. A client token typed into the page also approves, for when the phone is not to hand.
4. claude.ai exchanges the code for an access token (1 hour) and a refresh token (90 days, rotated on every use).

Each connected client becomes a **peer**, named after the client (`claude`, `claude-2`, …). It shows up in `peer list`, other agents can address it, and `peer revoke <name>` cuts it off: its tokens stop working immediately.

## Why consent goes through the phone

Registration is open by design; that is what dynamic client registration means. What stops a stranger is the consent ask, and nothing an agent holds can answer an ask addressed to the human (`requests.resolve` refuses it). So a connector can only be approved by the person Tether exists to protect. At most three consents can be pending at once, which bounds how often a stranger who finds the URL can make the phone ask.

Codes, access tokens and refresh tokens are stored as SHA-256 hashes.

## Exposing it

- Set `OAUTH_ENABLED=1`, and `OAUTH_ISSUER=https://<tunnel host>` so the issuer is stable.
- Route the tunnel hostname to the container. The client API and the web UI stay behind their own client tokens as before.
- **Rotate any agent token that has ever leaked before exposing the server.** A LAN-only leak becomes an internet one the moment the tunnel is up.
