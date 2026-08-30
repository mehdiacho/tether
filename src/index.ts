/** Entry point. Wires the pieces together and handles shutdown. */

import { assertStartupConfig } from './config.ts';
import { start } from './server.ts';
import { startExpiryLoop } from './requests.ts';
import { startFanout, startTelegramPoller } from './channels.ts';
import { startScheduler } from './scheduler.ts';
import { startRingTimeoutLoop } from './callsession.ts';
import { startSweeper } from './sessions.ts';

try {
  assertStartupConfig();
} catch (err) {
  console.error(`[tether] ${(err as Error).message}`);
  process.exit(1);
}

const stopFanout = startFanout();
const stopTelegram = startTelegramPoller();
const stopExpiry = startExpiryLoop();
const stopScheduler = startScheduler();
const stopRingTimeout = startRingTimeoutLoop();
const stopSweeper = startSweeper();
const server = start();

function shutdown(signal: string): void {
  console.log(`[tether] ${signal} — shutting down`);
  stopFanout();
  stopTelegram();
  stopExpiry();
  stopScheduler();
  stopRingTimeout();
  stopSweeper();
  server.close(() => process.exit(0));
  // Don't hang forever on a held long-poll.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
