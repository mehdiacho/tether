/**
 * Recurring jobs, evaluated by the server itself.
 *
 * WHY THIS IS NOT `cron` ON THE HOST. The point of a schedule here is that it
 * fires with no agent attached — "remind me to bring the seedlings in" has to
 * work when no Claude session is alive. Host cron could shell out to curl, but
 * then the schedule lives in a crontab the agent cannot read, edit, or reason
 * about. Keeping it in Tether's own database means an agent can create, list
 * and delete schedules through the same MCP surface as everything else.
 *
 * WHY THE TIMEZONE IS STORED PER SCHEDULE. The NAS runs UTC. Mehdi does not.
 * "07:00" is meaningless without a zone, and a DST-naive fixed offset drifts an
 * hour twice a year — which for a morning reminder is the difference between
 * useful and useless. Each schedule therefore carries an IANA zone and is
 * matched against wall-clock time in that zone.
 */

import { randomUUID } from 'node:crypto';
import * as store from './db.ts';
import * as requests from './requests.ts';
import { placeCall } from './calls.ts';
import { synthesize } from './voice.ts';
import type { Schedule } from './types.ts';

/* ------------------------------------------------------------------ cron -- */

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};
const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /** Standard cron's odd rule: when BOTH day fields are restricted, either may match. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(
  raw: string,
  min: number,
  max: number,
  names: Record<string, number> = {},
): Set<number> {
  const out = new Set<number>();

  for (const part of raw.split(',')) {
    const piece = part.trim().toLowerCase();
    if (!piece) throw new Error(`empty term in "${raw}"`);

    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${piece}"`);

    let lo: number;
    let hi: number;

    if (rangePart === '*' || rangePart === '') {
      lo = min;
      hi = max;
    } else {
      const bounds = rangePart!.split('-');
      if (bounds.length > 2) throw new Error(`bad range "${rangePart}"`);
      const value = (t: string): number => {
        const named = names[t];
        if (named !== undefined) return named;
        const n = Number.parseInt(t, 10);
        if (!Number.isInteger(n)) throw new Error(`"${t}" is not a number`);
        return n;
      };
      lo = value(bounds[0]!);
      hi = bounds.length === 2 ? value(bounds[1]!) : lo;
    }

    // Sunday is both 0 and 7 in every cron implementation worth copying.
    if (max === 6) {
      if (lo === 7) lo = 0;
      if (hi === 7) hi = 0;
    }
    if (lo < min || hi > max || hi < lo) {
      throw new Error(`"${piece}" is outside ${min}-${max}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  if (out.size === 0) throw new Error(`"${raw}" matches nothing`);
  return out;
}

/** Parse a 5-field cron expression. Throws with a human-readable reason. */
export function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron needs exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minute: parseField(m, 0, 59),
    hour: parseField(h, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(mon, 1, 12, MONTH_NAMES),
    dow: parseField(dow, 0, 6, DOW_NAMES),
    domRestricted: dom.trim() !== '*',
    dowRestricted: dow.trim() !== '*',
  };
}

/** Validate without keeping the result. Used at schedule-creation time. */
export function assertValidCron(expr: string): void {
  parseCron(expr);
}

export function assertValidTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    throw new Error(`"${tz}" is not a recognised IANA timezone (e.g. Africa/Gaborone).`);
  }
}

/* -------------------------------------------------------- zoned wall time -- */

export interface WallClock {
  minute: number;
  hour: number;
  dom: number;
  month: number;
  dow: number;
  /** Stable per-minute key, e.g. "2026-08-28T07:00". Used as the fire guard. */
  key: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    formatters.set(tz, f);
  }
  return f;
}

/**
 * Wall-clock fields in an IANA zone. Intl does the DST arithmetic, which is the
 * entire reason this is not a manual offset calculation.
 */
export function wallClock(tz: string, at: Date): WallClock {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(tz).formatToParts(at)) parts[p.type] = p.value;

  return {
    minute: Number.parseInt(parts['minute']!, 10),
    hour: Number.parseInt(parts['hour']!, 10),
    dom: Number.parseInt(parts['day']!, 10),
    month: Number.parseInt(parts['month']!, 10),
    dow: WEEKDAY_INDEX[parts['weekday'] ?? 'Sun'] ?? 0,
    key: `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}`,
  };
}

export function cronMatches(spec: CronSpec, now: WallClock): boolean {
  if (!spec.minute.has(now.minute)) return false;
  if (!spec.hour.has(now.hour)) return false;
  if (!spec.month.has(now.month)) return false;

  // Both day fields restricted -> OR. Otherwise the restricted one must match.
  if (spec.domRestricted && spec.dowRestricted) {
    return spec.dom.has(now.dom) || spec.dow.has(now.dow);
  }
  return spec.dom.has(now.dom) && spec.dow.has(now.dow);
}

/**
 * The next few firings, so a freshly created schedule can be eyeballed. Walks
 * forward a minute at a time — brute force, but "0 0 29 2 *" only costs a year
 * of trivial set lookups and it is never on a hot path.
 */
export function nextRuns(cron: string, tz: string, count = 3, from = new Date()): string[] {
  const spec = parseCron(cron);
  const out: string[] = [];
  const cursor = new Date(Math.floor(from.getTime() / 60_000) * 60_000);
  for (let i = 0; i < 366 * 24 * 60 && out.length < count; i++) {
    cursor.setTime(cursor.getTime() + 60_000);
    const wc = wallClock(tz, cursor);
    if (cronMatches(spec, wc)) out.push(`${wc.key} ${tz}`);
  }
  return out;
}

/* ----------------------------------------------------------------- firing -- */

async function fire(s: Schedule): Promise<void> {
  if (s.kind === 'call') {
    await placeCall({
      title: s.title,
      text: s.body,
      priority: s.priority,
      agentName: s.agentName,
      choices: s.choices,
      context: { schedule: s.id },
    });
    return;
  }

  const audioId = s.voice ? await synthesize(s.body) : null;
  requests.create({
    kind: s.kind,
    title: s.title,
    body: s.body,
    choices: s.choices,
    priority: s.priority,
    audioId,
    agentName: s.agentName,
    // Nothing is blocked on a scheduled question, so it expires on its own
    // rather than piling up in the pending list until the next one fires.
    timeoutSec: s.kind === 'ask' ? 12 * 60 * 60 : 60,
    context: { schedule: s.id },
  });
}

/**
 * Tick every 20s and fire anything whose minute has arrived.
 *
 * The guard is `lastFiredMinute`, not a timer: the loop deliberately runs more
 * often than once a minute (so a slow tick cannot skip a slot), and a restart
 * inside the same minute must not replay a job. Comparing the zoned minute key
 * makes both cases idempotent.
 */
export function startScheduler(intervalMs = 20_000): () => void {
  const tick = () => {
    const now = new Date();
    for (const s of store.listEnabledSchedules()) {
      let spec: CronSpec;
      try {
        spec = parseCron(s.cron);
      } catch (err) {
        console.error(`[tether] schedule ${s.id} has an unusable cron "${s.cron}":`, err);
        continue;
      }

      let wc: WallClock;
      try {
        wc = wallClock(s.timezone, now);
      } catch {
        console.error(`[tether] schedule ${s.id} has an unusable timezone "${s.timezone}"`);
        continue;
      }

      if (!cronMatches(spec, wc)) continue;
      if (s.lastFiredMinute === wc.key) continue;

      // Mark BEFORE awaiting: delivery takes seconds, and a second tick landing
      // inside the same minute must not send the message twice.
      store.markScheduleFired(s.id, wc.key);
      console.log(`[tether] schedule ${s.id} firing (${wc.key} ${s.timezone})`);
      void fire(s).catch((err) => console.error(`[tether] schedule ${s.id} failed:`, err));
    }
  };

  const handle = setInterval(tick, intervalMs);
  handle.unref?.();
  tick();
  return () => clearInterval(handle);
}

/* ------------------------------------------------------------------- CRUD -- */

export interface CreateScheduleArgs {
  cron: string;
  timezone: string;
  kind: Schedule['kind'];
  title: string;
  body: string;
  choices?: string[] | null;
  voice?: boolean;
  priority?: Schedule['priority'];
  agentName?: string;
}

export function createSchedule(a: CreateScheduleArgs): Schedule {
  assertValidCron(a.cron);
  assertValidTimezone(a.timezone);
  return store.insertSchedule({
    id: randomUUID(),
    cron: a.cron.trim().replace(/\s+/g, ' '),
    timezone: a.timezone,
    kind: a.kind,
    title: a.title,
    body: a.body,
    choices: a.choices ?? null,
    voice: a.voice ?? a.kind === 'call',
    priority: a.priority ?? (a.kind === 'call' ? 'urgent' : 'default'),
    agentName: a.agentName ?? 'agent',
  });
}

export const listSchedules = store.listSchedules;
export const getSchedule = store.getSchedule;
export const deleteSchedule = store.deleteSchedule;
export const setScheduleEnabled = store.setScheduleEnabled;
