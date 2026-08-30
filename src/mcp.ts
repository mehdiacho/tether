/**
 * The MCP tool surface. This is what Claude Code sees.
 *
 * Design note on blocking: `ask` and `request_action` genuinely block the tool
 * call until a human answers. That is the whole point — the agent parks instead
 * of guessing or giving up. Internally it long-polls with a cap, so a held tool
 * call never pins server state it cannot rebuild after a restart.
 *
 * Every blocking tool returns the request id in its result. If the tool call is
 * interrupted, the agent can call `collect` with that id and pick the answer up
 * where it left off.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { config } from './config.ts';
import * as requests from './requests.ts';
import * as scheduler from './scheduler.ts';
import { placeCall } from './calls.ts';
import * as callsession from './callsession.ts';
import { synthesize, voiceEnabled } from './voice.ts';
import type { TetherRequest } from './types.ts';

/** One long-poll leg. Shorter than the request timeout so we re-check state. */
const POLL_LEG_MS = 55_000;

const priority = z
  .enum(['min', 'low', 'default', 'high', 'urgent'])
  .default('default')
  .describe(
    "How loudly to interrupt. 'urgent' bypasses Do Not Disturb — reserve it for a run that is stopped until the human acts.",
  );

const context = z
  .record(z.string())
  .optional()
  .describe(
    'Short key/value context shown to the human: task, repo, environment, URL. Helps them answer without asking you what you mean.',
  );

/** Wait for resolution, re-polling until the request settles or expires. */
async function awaitResolution(id: string): Promise<TetherRequest | null> {
  for (;;) {
    const r = await requests.wait(id, POLL_LEG_MS);
    if (!r) return null;
    if (r.status !== 'pending') return r;
    if (Date.now() >= r.expiresAt) return requests.get(id);
  }
}

function describe(r: TetherRequest): string {
  switch (r.status) {
    case 'answered':
      return `ANSWERED: ${r.answer ?? ''}`;
    case 'refused':
      return 'REFUSED — the human declined. Do not retry; ask what they would prefer instead.';
    case 'timed_out':
      return 'TIMED_OUT — nobody responded before the deadline. They may be away; do not assume consent.';
    case 'cancelled':
      return 'CANCELLED — this request was withdrawn.';
    default:
      return 'PENDING';
  }
}

/** A plain spoken-word answer back to the agent. */
function text_(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function result(r: TetherRequest | null, id: string) {
  if (!r) {
    return {
      content: [{ type: 'text' as const, text: `Request ${id} not found.` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: `${describe(r)}\n\n(request id: ${r.id} — pass this to \`collect\` if you get interrupted)`,
      },
    ],
  };
}

export function buildMcpServer(agentName: string): McpServer {
  const server = new McpServer(
    { name: 'tether', version: '0.1.0' },
    {
      instructions:
        'Reach the human operator and, where needed, wait for their answer. ' +
        'Use `notify` for information they do not need to act on. Use `ask` when you need a ' +
        'decision, `request_action` when you are blocked on something only they can do ' +
        '(a login, an approval, a 2FA prompt). Prefer asking over guessing when the cost of ' +
        'guessing wrong is high. Before starting long unattended work, expect to use these. ' +
        '`call` speaks a message at maximum priority and keeps the recording — for things that ' +
        'must not be missed. `schedule_create` sets up a recurring reminder that fires with no ' +
        'agent running, which is the right tool when they ask to be reminded of something daily.',
    },
  );

  /* ------------------------------------------------------------- notify -- */

  server.registerTool(
    'notify',
    {
      title: 'Notify',
      description:
        'Send a one-way notification. Does not wait for a reply. Use for "job finished", ' +
        '"build failed", "deploy is live". Do not use for routine progress — a notification ' +
        'they did not need is annoying in a way that accumulates.',
      inputSchema: {
        title: z.string().max(120).describe('Short headline. Lead with what they would act on.'),
        body: z.string().max(2000).describe('The detail.'),
        priority,
        context,
        voice: z
          .boolean()
          .default(false)
          .describe('Also render as a spoken message. Good for end-of-session summaries.'),
      },
    },
    async ({ title, body, priority: p, context: ctx, voice }) => {
      const audioId = voice ? await synthesize(`${title}. ${body}`) : null;
      const req = requests.create({
        kind: 'notify',
        title,
        body,
        priority: p,
        context: ctx ?? null,
        audioId,
        agentName,
        timeoutSec: 60,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `Sent${audioId ? ' (with voice)' : ''}. id: ${req.id}`,
          },
        ],
      };
    },
  );

  /* ---------------------------------------------------------------- ask -- */

  server.registerTool(
    'ask',
    {
      title: 'Ask and wait',
      description:
        'Ask the human a question and BLOCK until they answer. Returns their answer, or ' +
        'REFUSED / TIMED_OUT. Treat those as different: refused means they said no, timed_out ' +
        'means they never saw it — never read a timeout as consent. Supply `choices` when the ' +
        'answer is one of a few options; it becomes tappable buttons and gets answered faster.',
      inputSchema: {
        question: z.string().max(500).describe('The question, in plain language.'),
        detail: z.string().max(2000).default('').describe('Optional background.'),
        choices: z
          .array(z.string().max(60))
          .max(6)
          .optional()
          .describe('Answer options. Omit for a free-text reply.'),
        priority,
        context,
        timeout_sec: z
          .number()
          .int()
          .min(30)
          .max(config.maxTimeoutSec)
          .default(config.defaultTimeoutSec)
          .describe('How long to wait before giving up.'),
      },
    },
    async ({ question, detail, choices, priority: p, context: ctx, timeout_sec }) => {
      const req = requests.create({
        kind: 'ask',
        title: question,
        body: detail,
        choices: choices ?? null,
        priority: p,
        context: ctx ?? null,
        agentName,
        timeoutSec: timeout_sec,
      });
      return result(await awaitResolution(req.id), req.id);
    },
  );

  /* ----------------------------------------------------- request_action -- */

  server.registerTool(
    'request_action',
    {
      title: 'Request an action and wait',
      description:
        'Ask the human to do something you cannot — sign in, approve in a dashboard, plug ' +
        'something in — and BLOCK until they mark it done. Use this instead of failing the run ' +
        'when you hit a login wall or a permission gate. Say exactly what you need and what you ' +
        'will do once it is done.',
      inputSchema: {
        instruction: z
          .string()
          .max(500)
          .describe('Precisely what they should do, e.g. "Sign in at staging.example.com".'),
        why: z.string().max(1000).default('').describe('What you will continue with afterwards.'),
        priority,
        context,
        timeout_sec: z
          .number()
          .int()
          .min(30)
          .max(config.maxTimeoutSec)
          .default(config.defaultTimeoutSec),
      },
    },
    async ({ instruction, why, priority: p, context: ctx, timeout_sec }) => {
      const req = requests.create({
        kind: 'action',
        title: instruction,
        body: why,
        priority: p,
        context: ctx ?? null,
        agentName,
        timeoutSec: timeout_sec,
      });
      return result(await awaitResolution(req.id), req.id);
    },
  );

  /* ------------------------------------------------------------ collect -- */

  server.registerTool(
    'collect',
    {
      title: 'Collect a pending answer',
      description:
        'Pick up the answer to a request you started earlier — after a crash, a restart, or an ' +
        'interrupted tool call. Blocks if it is still pending. This is why every tool returns a ' +
        'request id: an interrupted ask is recoverable, not lost.',
      inputSchema: {
        request_id: z.string().describe('The id returned when the request was created.'),
      },
    },
    async ({ request_id }) => result(await awaitResolution(request_id), request_id),
  );

  /* ------------------------------------------------------------- cancel -- */

  server.registerTool(
    'cancel',
    {
      title: 'Withdraw a request',
      description:
        'Withdraw a request you no longer need answered — you solved it another way, or the task ' +
        'was abandoned. Clears it from the human\'s pending list so they are not answering ' +
        'questions that no longer matter.',
      inputSchema: { request_id: z.string() },
    },
    async ({ request_id }) => {
      const r = requests.cancel(request_id);
      return {
        content: [
          {
            type: 'text' as const,
            text: r ? `Cancelled ${request_id}.` : `${request_id} was already resolved.`,
          },
        ],
      };
    },
  );

  /* -------------------------------------------------------------- speak -- */

  if (voiceEnabled()) {
    server.registerTool(
      'speak',
      {
        title: 'Send a voice message',
        description:
          'Send a spoken message in the operator\'s chosen voice. Good for an end-of-session ' +
          'summary they can listen to rather than read. Write it to be heard: short sentences, ' +
          'no markdown, no code, no URLs.',
        inputSchema: {
          text: z.string().max(1500).describe('What to say. Plain prose meant for the ear.'),
          title: z.string().max(120).default('Voice message'),
          priority,
        },
      },
      async ({ text, title, priority: p }) => {
        const audioId = await synthesize(text);
        const req = requests.create({
          kind: 'notify',
          title,
          body: text,
          priority: p,
          agentName,
          audioId,
          timeoutSec: 60,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: audioId
                ? `Voice message sent. id: ${req.id}`
                : `Voice unavailable, sent as text. id: ${req.id}`,
            },
          ],
        };
      },
    );

    /* ------------------------------------------------------------- call -- */

    server.registerTool(
      'call',
      {
        title: 'Call the operator',
        description:
          'Place a call: speak a message at maximum priority, breaking through Do Not Disturb, ' +
          'and keep the recording so it can be replayed. Louder than `speak` or `notify` — use ' +
          'it when the message is time-critical and being missed would defeat the point ' +
          '(a reminder tied to a moment, a run that stopped and needs them now). ' +
          'Write it to be heard: short sentences, no markdown, no URLs. ' +
          'Delivery markers in square brackets are passed through to the voice, e.g. ' +
          '"[warmly] Morning. [pause] Time to put the seedlings out." ' +
          'Supply `choices` only if the call also needs an answer; without them it announces ' +
          'and does not block.',
        inputSchema: {
          text: z.string().max(1500).describe('What to say, as spoken prose.'),
          title: z.string().max(120).default('Call').describe('Headline for the notification.'),
          choices: z
            .array(z.string().max(60))
            .max(6)
            .optional()
            .describe('Answer buttons. Omit unless the call genuinely asks something.'),
          context,
          wait: z
            .boolean()
            .default(false)
            .describe('Block until they answer. Only meaningful together with `choices`.'),
        },
      },
      async ({ text, title, choices, context: ctx, wait }) => {
        const { request, audioId, session } = await placeCall({
          text,
          title,
          choices: choices ?? null,
          context: ctx ?? null,
          agentName,
        });

        if (wait && choices?.length) return result(await awaitResolution(request.id), request.id);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                audioId
                  ? 'Called. The recording is saved and replayable.'
                  : 'Voice was unavailable, so it went out as an urgent text message.',
                `id: ${request.id}`,
                // Without this the agent has no handle on the conversation and
                // every call is a monologue by construction.
                session
                  ? `call_id: ${session.id} — once they pick up, use \`call_say\` to talk with ` +
                    'them and `call_end` to hang up.'
                  : 'No device rang, so there is nothing to talk to.',
              ].join('\n'),
            },
          ],
        };
      },
    );

    /* ------------------------------------------------ live conversation -- */

    /**
     * The conversational half of calling.
     *
     * The shape is deliberately the same as waiting on a long-running command:
     * you say something, the tool blocks, and it comes back with what they said
     * — or with the fact that they hung up. Call it again to take the next turn.
     * Thinking time between turns costs nothing but silence on the line, which
     * is why this fits a turn-based agent at all.
     */
    server.registerTool(
      'call_say',
      {
        title: 'Speak on a live call and hear the reply',
        description:
          'Say something on a call that is already answered, then wait for the human to ' +
          'answer back. Returns what they said, so you can respond to it with another ' +
          'call_say. Use this for anything that needs a back-and-forth rather than an ' +
          'announcement. Write it to be heard: short sentences, no markdown, no URLs. ' +
          'If they say nothing before the timeout, or hang up, that is reported instead — ' +
          'treat a hang-up as the end of the conversation, not an error. ' +
          'Call `call_end` when the conversation is genuinely finished.',
        inputSchema: {
          call_id: z.string().describe('The call to speak on, from `call`.'),
          text: z.string().max(1500).describe('What to say, as spoken prose.'),
          listen: z
            .boolean()
            .default(true)
            .describe('Wait for a reply. Set false to say something and return at once.'),
          wait_sec: z
            .number()
            .int()
            .min(5)
            .max(600)
            .optional()
            .describe('How long to wait for them to speak. Defaults to the server setting.'),
        },
      },
      async ({ call_id, text, listen, wait_sec }) => {
        const call = callsession.get(call_id);
        if (!call) return text_(`No call ${call_id}.`);
        if (call.state !== 'answered') return text_(`That call is ${call.state}.`);

        const audioId = await synthesize(text, { keep: true });
        const turn = await callsession.speak(call_id, text, audioId);
        if (!turn) return text_('The call ended before that could be said.');
        if (!listen) return text_(`Said. Turn ${turn.seq}.`);

        const heard = await callsession.listen(
          call_id,
          turn.seq,
          (wait_sec ?? config.call.listenTimeoutSec) * 1000,
        );

        if (heard.state === 'heard') return text_(`They said: ${heard.turn.text}`);
        if (heard.state === 'ended') return text_('They hung up. The call is over.');
        return text_('They did not say anything. The call is still open.');
      },
    );

    server.registerTool(
      'call_end',
      {
        title: 'Hang up',
        description:
          'End a live call. Say goodbye with `call_say` first — hanging up mid-conversation ' +
          'with no warning reads exactly as rudely as it would on a real phone.',
        inputSchema: { call_id: z.string() },
      },
      async ({ call_id }) => {
        const ended = callsession.end(call_id);
        return text_(ended ? 'Call ended.' : 'That call was not live.');
      },
    );
  }

  /* ----------------------------------------------------------- schedules -- */

  server.registerTool(
    'schedule_create',
    {
      title: 'Create a recurring reminder',
      description:
        'Create a recurring job that Tether fires on its own, with no agent running. Use this ' +
        'when the human asks to be reminded of something regularly — it keeps working after ' +
        'this session ends, which a timer in your own process would not. ' +
        'Confirm the time and timezone with them before creating one; a reminder at the wrong ' +
        'hour is worse than none.',
      inputSchema: {
        cron: z
          .string()
          .describe(
            'Standard 5-field cron: minute hour day-of-month month day-of-week. ' +
              'e.g. "0 7 * * *" = 07:00 daily, "30 17 * * 1-5" = 17:30 on weekdays.',
          ),
        timezone: z
          .string()
          .default(config.defaultTimezone)
          .describe(`IANA zone the cron is read in. Defaults to ${config.defaultTimezone}.`),
        kind: z
          .enum(['call', 'notify', 'ask'])
          .default('call')
          .describe(
            "'call' speaks it at max priority and keeps the recording; 'notify' is a quiet " +
              "push; 'ask' records an answer for you to collect later.",
          ),
        title: z.string().max(120).describe('Headline.'),
        body: z.string().max(1500).describe('The message. For a call, write it to be spoken.'),
        choices: z.array(z.string().max(60)).max(6).optional(),
        priority,
      },
    },
    async ({ cron, timezone, kind, title, body, choices, priority: p }) => {
      try {
        const s = scheduler.createSchedule({
          cron,
          timezone,
          kind,
          title,
          body,
          choices: choices ?? null,
          priority: p,
          agentName,
        });
        const next = scheduler.nextRuns(s.cron, s.timezone);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Schedule created (${s.id}).\n${s.cron} — ${s.timezone}\n` +
                `Next: ${next.join(', ')}\n\n` +
                'Read the next firings back to the human to confirm you got the time right.',
            },
          ],
        };
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Could not create it: ${(err as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    'schedule_list',
    {
      title: 'List recurring reminders',
      description:
        'List every schedule, including ones created by other sessions. Check this before ' +
        'creating a new one — a duplicate reminder trains the human to ignore all of them.',
      inputSchema: {},
    },
    async () => {
      const all = scheduler.listSchedules();
      if (all.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No schedules.' }] };
      }
      const lines = all.map((s) => {
        const next = (() => {
          try {
            return scheduler.nextRuns(s.cron, s.timezone, 1)[0] ?? 'never';
          } catch {
            return 'INVALID CRON';
          }
        })();
        return (
          `${s.id}  [${s.enabled ? 'on' : 'off'}] ${s.kind}  "${s.title}"\n` +
          `  ${s.cron} (${s.timezone})  next: ${next}`
        );
      });
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  server.registerTool(
    'schedule_delete',
    {
      title: 'Delete a recurring reminder',
      description:
        'Delete a schedule by id. Only do this when the human has asked for it — a schedule ' +
        'you did not create belongs to them, not to your task.',
      inputSchema: { schedule_id: z.string() },
    },
    async ({ schedule_id }) => ({
      content: [
        {
          type: 'text' as const,
          text: scheduler.deleteSchedule(schedule_id)
            ? `Deleted ${schedule_id}.`
            : `No schedule ${schedule_id}.`,
        },
      ],
    }),
  );

  return server;
}
