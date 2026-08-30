/**
 * `tether pair` — put a pairing QR on the terminal.
 *
 * The point of this command is that setting up a phone should not require
 * already having a credential in your hand. Anyone who can run a process next
 * to the database is, by definition, more privileged than any client token, so
 * this mints its code directly rather than authenticating to the HTTP API.
 *
 *   docker exec -it tether node src/cli/pair.ts
 *   npm run pair -- --url https://tether.example.com
 *
 * Nothing secret is printed: the QR carries a server address and a code that
 * expires in five minutes and dies the moment it is used.
 */

import { networkInterfaces } from 'node:os';
import { config } from '../config.ts';
import * as devices from '../devices.ts';
import { encodeQr, toAnsi } from '../qr.ts';

function parseArgs(argv: readonly string[]): { url?: string; wait: boolean } {
  const out: { url?: string; wait: boolean } = { wait: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--url' || arg === '-u') out.url = argv[++i];
    else if (arg === '--no-wait') out.wait = false;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node src/cli/pair.ts [--url <server address>] [--no-wait]\n\n' +
          '  --url      The address the PHONE should use. Defaults to PUBLIC_URL,\n' +
          '             then to this host\'s first LAN address.\n' +
          '  --no-wait  Print the code and exit instead of waiting for the scan.',
      );
      process.exit(0);
    }
  }
  return out;
}

/** Where a phone should be told to connect, in descending order of confidence. */
function defaultUrl(): string | null {
  if (config.publicUrl) return config.publicUrl;
  for (const addresses of Object.values(networkInterfaces())) {
    for (const addr of addresses ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return `http://${addr.address}:${config.port}`;
    }
  }
  return null;
}

const args = parseArgs(process.argv.slice(2));
const url = (args.url ?? defaultUrl())?.replace(/\/+$/, '');

if (!url) {
  console.error(
    'Could not work out an address for the phone to use.\n' +
      'Set PUBLIC_URL in the environment, or pass --url http://<host>:<port>.',
  );
  process.exit(1);
}

const { code, expiresAt } = devices.createPairingCode();
const uri = devices.pairingUri(url, code);

console.log();
console.log(toAnsi(encodeQr(uri, 'M')));
console.log();
console.log(`  Server   ${url}`);
console.log(`  Code     ${code}`);
console.log(`  Expires  in ${Math.round((expiresAt - Date.now()) / 1000)}s`);
console.log();
console.log('  Open Tether on the phone and tap "Scan QR code".');
console.log('  No camera? Type the address and the code by hand — same result.');
console.log();

if (!args.wait) process.exit(0);

/**
 * Poll rather than wire up an event bus: this is a one-shot command watching a
 * single row for at most five minutes, and the database is the thing that
 * actually knows. A second of latency on a human scanning a code is invisible.
 */
console.log('  Waiting for the scan... (Ctrl-C to stop)');

const timer = setInterval(() => {
  const status = devices.pairingStatus(code);

  if (status.state === 'claimed') {
    clearInterval(timer);
    console.log(`\n  Paired with ${status.device?.name ?? 'a device'}.\n`);
    process.exit(0);
  }

  if (status.state !== 'pending') {
    clearInterval(timer);
    console.log('\n  That code expired before it was used. Run this again for a fresh one.\n');
    process.exit(1);
  }
}, 1000);

process.on('SIGINT', () => {
  clearInterval(timer);
  console.log('\n  Stopped waiting. The code stays valid until it expires.\n');
  process.exit(0);
});
