/**
 * `tether peer` — register the agents and people that may address each other.
 *
 * Same argument as `pair`: anyone who can run a process next to the database is
 * more privileged than any token it could hold, so this writes directly rather
 * than authenticating to the HTTP API. It is also the ONLY way to mint a peer
 * token — there is deliberately no HTTP route that issues one, because an
 * endpoint that hands out identities is an endpoint that hands out identities
 * to whoever finds it.
 *
 *   docker exec -it tether node src/cli/peer.ts list
 *   docker exec -it tether node src/cli/peer.ts add astra --tool codex
 *   docker exec -it tether node src/cli/peer.ts add mehdi --human
 *   docker exec -it tether node src/cli/peer.ts revoke astra
 *
 * The token is printed ONCE, on creation. It is not recoverable afterwards:
 * revoke the peer and add it again.
 */

import * as peers from '../peers.ts';

function usage(): never {
  console.log(
    'Usage: node src/cli/peer.ts <command>\n\n' +
      '  list                       Show every registered peer.\n' +
      '  add <name> [options]       Register a peer and print its token.\n' +
      '  revoke <name>              Revoke a peer. Its token stops working immediately.\n\n' +
      'Options for add:\n' +
      '  --human                    A person, not an agent. Gets NO token: nothing may\n' +
      '                             authenticate as a human, and anything addressed to\n' +
      '                             one is answerable only from the phone or web UI.\n' +
      "  --tool <name>              What it runs as: 'claude-code', 'codex'. Display only.\n" +
      '  --description <text>       One line shown to other agents in peer_list.\n',
  );
  process.exit(1);
}

function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === 'list') {
  const all = peers.list();
  if (all.length === 0) {
    console.log('No peers registered. Add one with: node src/cli/peer.ts add <name>');
  } else {
    for (const p of all) {
      const tool = p.tool ? ` [${p.tool}]` : '';
      const desc = p.description ? ` — ${p.description}` : '';
      console.log(`${p.name.padEnd(16)} ${p.kind}${tool}${desc}`);
    }
  }
} else if (cmd === 'add') {
  const name = argv[1];
  if (!name || name.startsWith('--')) usage();

  try {
    const { peer, token } = peers.register({
      name,
      kind: argv.includes('--human') ? 'human' : 'agent',
      tool: flag(argv, '--tool') ?? '',
      description: flag(argv, '--description') ?? '',
    });

    console.log(`\nRegistered "${peer.name}" (${peer.kind}).\n`);
    if (token) {
      console.log('Token — shown once, and not recoverable:\n');
      console.log(`  ${token}\n`);
      console.log('Put it in that agent\'s MCP config as the Authorization bearer.');
      console.log('Give each agent its OWN token: a shared token means a shared identity,');
      console.log('and two agents with one identity cannot address each other at all.\n');
    } else {
      console.log('No token, by design — nothing authenticates as a human.');
      console.log('Agents reach this peer with `ask`, which rings the phone.\n');
    }
  } catch (err) {
    console.error(`\n${(err as Error).message}\n`);
    process.exit(1);
  }
} else if (cmd === 'revoke') {
  const name = argv[1];
  if (!name) usage();
  console.log(
    peers.revoke(name)
      ? `Revoked "${name}". Its token no longer authenticates.`
      : `No peer named "${name}".`,
  );
} else {
  usage();
}
