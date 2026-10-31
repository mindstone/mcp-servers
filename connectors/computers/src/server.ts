import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Computers, type JobStatus, type Located, quoteArgs } from './computers.js';
import { ConnectorError } from './types.js';
import { wrapUntrusted } from './untrusted-content.js';
import type { ProviderId } from './provider.js';
import { providersFromEnv } from './config.js';
import { refuseRedirects } from './fetch-policy.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

const computerArg = z.string().min(1).describe('The computer\'s name, as computer_list shows it (for example "research").');
const providerArg = z.enum(['fly', 'e2b', 'gcp']);

/** Browser commands that change the page; their result also says where the browser ended up. */
const BROWSER_ACTIONS = new Set(['open', 'goto', 'navigate', 'click', 'dblclick', 'fill', 'type', 'press', 'select', 'check', 'uncheck', 'upload', 'back', 'forward', 'reload', 'batch']);

const JOB_HELP = `If the command is still running after about 45 seconds, the result has state "running" and a job id: call computer_job with that job to keep waiting (each call waits up to 45 s more and returns new output from next_offset). A running job is ended automatically if nobody waits on it for 3 minutes, so keep calling computer_job while you still want it; when the person stops your turn, it ends too.`;

type Extra = { signal?: AbortSignal };

function json(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

/** House error shape: what failed, a code, and the fix. Full details go to stderr only. */
function tool<Args>(fn: (args: Args, extra: Extra) => Promise<CallToolResult>) {
  return async (args: Args, extra: Extra): Promise<CallToolResult> => {
    try {
      return await fn(args, extra);
    } catch (error) {
      const known =
        error instanceof ConnectorError
          ? error
          : new ConnectorError('Something unexpected went wrong talking to the computer.', 'UNEXPECTED', 'Try again. If it repeats, call computer_check_setup and pass on what it says.');
      if (!(error instanceof ConnectorError)) console.error(`[computers] unexpected error (${(error as Error)?.name ?? 'error'})`);
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: known.message, code: known.code, resolution: known.resolution }) }] };
    }
  };
}

/** A setup result without the install log: the log only matters when setup fails. */
function setupSummary(status: JobStatus): JobStatus {
  if (status.state === 'finished' && status.exit_code === 0)
    return {
      ...status,
      output: status.output.includes('Some basic tools could not be installed')
        ? 'Setup finished: the browser is ready, but some basic tools could not be installed. Install what a task needs with sudo apt-get install -y …'
        : 'Setup finished: the browser and basic tools are ready.',
      more_output: false,
    };
  if (status.state === 'running')
    return { ...status, output: 'Setting up: installing the browser and basic tools, usually 1–3 minutes. computer_run already works; call computer_job with this job before using computer_browser.', more_output: false };
  const tail = status.output.replace(/^<untrusted-content[^>]*>|<\/untrusted-content>$/g, '').trim().split('\n').slice(-12).join('\n');
  return {
    ...status,
    output: wrapUntrusted(`Setup did not finish (exit code ${status.exit_code ?? 'none'}). Last lines:\n${tail}`, 'computers:command-output') ?? '',
    more_output: false,
    hint: 'computer_run still works, but the browser may be missing. Run computer_setup once more; if it fails the same way, tell the person what the last lines say.',
  };
}

/** Waits on a job; if the call is cancelled (the person stopped the turn), the job is ended at once. */
async function waitCancellable(computers: Computers, located: Located, job: string | Promise<string>, extra: Extra, offset = 0): Promise<JobStatus> {
  const id = await job;
  const end = () => void computers.cancel(located, id).catch((error) => console.error(`[computers] cancel after stop failed (${(error as Error)?.name ?? 'error'})`));
  if (extra.signal?.aborted) end();
  extra.signal?.addEventListener('abort', end, { once: true });
  try {
    return await computers.wait(located, id, offset);
  } finally {
    extra.signal?.removeEventListener('abort', end);
  }
}

export function createServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  refuseRedirects();
  const server = new McpServer({ name: 'computers', version });
  const computers = new Computers(providersFromEnv(env));
  const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
  const acts = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

  server.registerTool(
    'computer_check_setup',
    {
      description: `Check that the cloud accounts connected to Computers work, and say what each one can reach.

WHEN TO USE:
- Right after the person adds or changes a key in the connector settings, to confirm it works.
- When another computer tool fails with AUTH_FAILED, NOT_ALLOWED or NOT_CONFIGURED.

RETURNS: one line per connected account (Fly.io, E2B, Google Cloud): either what it reaches, or what's wrong and exactly how to fix it. Tell the person the result in plain words.`,
      inputSchema: {},
      annotations: readOnly,
    },
    tool(async () => {
      computers.requireAny();
      const accounts = await Promise.all(
        computers.configured.map(async (provider) => {
          try {
            return { provider: provider.id, ok: true, result: await provider.check() };
          } catch (error) {
            if (!(error instanceof ConnectorError)) console.error(`[computers] ${provider.id} check failed (${(error as Error)?.name ?? 'error'})`);
            const known = error instanceof ConnectorError ? error : new ConnectorError(`${provider.label} gave a reply the connector could not read.`, 'PROVIDER_ERROR', 'Try again in a minute.');
            return { provider: provider.id, ok: false, error: known.message, code: known.code, resolution: known.resolution };
          }
        }),
      );
      return json({ accounts });
    }),
  );

  server.registerTool(
    'computer_list',
    {
      description: `List the person's computers on every connected cloud account.

A computer is a Linux machine (with a browser) that lives in the person's own cloud account and that you can use for longer work: running commands and scripts, installing software, processing files, and using websites in its own browser. Its home folder is kept between days; a stopped computer keeps everything and costs only storage.

WHEN TO USE:
- Before using a computer, to get its exact name and whether it's running.
- When the person asks what computers they have.

RETURNS: computers (name, provider, state: running | stopped | starting | stopping), connected_providers, and problems for any account that couldn't be checked (with the fix). A stopped computer starts automatically when you use it; you never need to start one yourself.`,
      inputSchema: {},
      annotations: readOnly,
    },
    tool(async () => {
      const { computers: list, problems } = await computers.listAll();
      return json({
        computers: list.map(({ name, provider, state, region, createdAt }) => ({ name, provider, state, region, created_at: createdAt })),
        connected_providers: computers.configured.map((p) => p.id),
        ...(problems.length
          ? {
              could_not_check: problems.map((p) => p.provider),
              problems,
              note: `Not the full list: ${problems.map((p) => p.provider).join(' and ')} couldn't be checked, so any computers there are missing (not gone). Each problem says how to fix it.`,
            }
          : {}),
      });
    }),
  );

  server.registerTool(
    'computer_create',
    {
      description: `Create (buy) a new computer on one of the person's cloud accounts and set it up with a browser.

WHEN TO USE:
- The person asks for a computer, or a task needs one and computer_list shows none that fits.
- Reuse an existing computer when one will do: each computer costs the person money while it runs, and a little for storage while stopped.

COST: billed by the provider to the person's own account. Roughly: Fly.io and Google Cloud a few cents an hour while running; E2B per second while running. Computers stop (or pause) by themselves after 15 idle minutes.

SETUP: creating takes about a minute; setup then installs the browser in the background (2–5 minutes). The result includes a setup job: call computer_job with it until it finishes before using computer_browser. computer_run works straight away.

RETURNS: the computer (name, provider, state) and the setup job's status.`,
      inputSchema: {
        name: z.string().describe('A short name: lowercase letters, digits and dashes, starting with a letter (for example "research").'),
        provider: providerArg.optional().describe('Which connected account to use: "fly", "e2b" or "gcp". Omit to use the first connected one; computer_list shows which are connected.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    tool(async ({ name, provider }: { name: string; provider?: ProviderId }) => {
      const { located, setup } = await computers.create(name, provider);
      return json({ computer: { name: located.computer.name, provider: located.provider.id, state: 'running' }, setup: setupSummary(setup) });
    }),
  );

  server.registerTool(
    'computer_setup',
    {
      description: `Run a computer's setup again: reinstalls the connector's helper and the browser if they are missing or out of date. Safe to repeat; it keeps files.

WHEN TO USE:
- A tool answers NOT_SET_UP or SETUP_FAILED.
- computer_browser says the browser is missing.

RETURNS: the setup job; call computer_job with it until state is "finished".`,
      inputSchema: { computer: computerArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ computer }: { computer: string }) => json(setupSummary(await computers.setup(await computers.ready(computer))))),
  );

  server.registerTool(
    'computer_run',
    {
      description: `Run a shell command on a computer (bash, as its own user, with passwordless sudo). The computer starts by itself if it is stopped.

WHEN TO USE:
- Anything you'd do in a terminal: install software (sudo apt-get install -y …, pip install …), run scripts, convert or process files, download from the web (curl, wget), check what's there (ls, cat).
- Prefer this over computer_browser when a site has an API or a file can be downloaded directly.

GOOD TO KNOW:
- Already installed: python3 with pip, venv and matplotlib, git, curl, jq, zip/unzip, file, ping, pdftotext, and the browser (agent-browser). Install anything else with sudo apt-get install -y …, pip or npm.
- The home folder (relative paths start there) is kept between days. Keep the person's work there. On Fly.io computers, programs installed with apt outside the home folder are gone after a restart (the everyday tools above come back by themselves); pip install --user and anything under the home folder stay.
- You can start other commands while one is still running (each call is its own job).
- The person's Library is not on the computer: copy files in with computer_copy_in and results out with computer_copy_out.
- Each call starts a fresh shell: cd and exported variables don't carry over, so chain steps with && in one command.
- Output is combined stdout and stderr; long output comes back in pieces (more_output, next_offset).
- Anything the command starts in the background ends when the command finishes. To keep a program running (a server, a long download), run it in the foreground and keep waiting on the job.
- If cwd doesn't exist, nothing runs and the output says so.
- ${JOB_HELP}

RETURNS: state (finished | running | stopped), exit_code, output, job, next_offset, more_output, elapsed_sec, and sometimes a hint with the next step (for example when the disk is full or a program is missing). A "stopped" job was ended (stopped_reason: cancelled, lease (nobody waited), timeout, restart, or computer stopped).`,
      inputSchema: {
        computer: computerArg,
        command: z.string().min(1).max(200_000).describe('The bash command to run, for example "cd reports && python3 make_chart.py".'),
        cwd: z.string().optional().describe('Folder to run it in. Default: the home folder.'),
        timeout_sec: z.number().int().min(10).max(7200).default(1800).describe('End the command after this many seconds. Default 1800 (30 minutes).'),
      },
      annotations: acts,
    },
    tool(async ({ computer, command, cwd, timeout_sec }: { computer: string; command: string; cwd?: string; timeout_sec: number }, extra) => {
      const located = await computers.ready(computer);
      return json(await waitCancellable(computers, located, computers.begin(located, command, timeout_sec, cwd ? computers.absolute(located, cwd) : undefined), extra));
    }),
  );

  server.registerTool(
    'computer_job',
    {
      description: `Wait for, read more output from, or cancel a command started by computer_run, computer_browser, computer_use_tool or setup.

WHEN TO USE:
- A previous result had state "running": call this with its job until state is "finished" or "stopped".
- A result had more_output: call this with offset = next_offset to read the rest.
- To stop a command early: cancel: true (ends the command and everything it started).

RETURNS: the same shape as computer_run.`,
      inputSchema: {
        computer: computerArg,
        job: z.string().describe('The job value from the earlier result.'),
        offset: z.number().int().min(0).default(0).describe('Return output from this byte offset: pass the previous next_offset to get only new output.'),
        cancel: z.boolean().default(false).describe('true to end the command now.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ computer, job, offset, cancel }: { computer: string; job: string; offset: number; cancel: boolean }, extra) => {
      const located = await computers.ready(computer);
      if (cancel) return json(await computers.cancel(located, job));
      return json(await waitCancellable(computers, located, job, extra, offset));
    }),
  );

  server.registerTool(
    'computer_browser',
    {
      description: `Use the computer's own web browser (Chrome), with the same agent-browser commands as Browser Automation. Sign-ins and cookies are kept in the computer's browser profile between days.

WHEN TO USE:
- Websites with no API or download link: reading pages, filling forms, clicking through flows, uploading a file that's on the computer.

HOW:
- args is one agent-browser command as a list, for example:
  ["open", "https://example.com"] → opens a page
  ["snapshot", "-i"] → the page's interactive elements, each with a ref like @e3
  ["click", "@e3"], ["fill", "@e5", "jane@example.com"], ["press", "Enter"]
  ["upload", "@e7", "/home/user/report.pdf"] → uploads a file that's on the computer (copy it there first with computer_copy_in)
  ["get", "text", "body"] → the page's text
  ["screenshot"] → returns a picture of the page
- Actions (click, fill, type, press, select, check, upload, open) also return the page's address and title afterwards, so you can tell where you are.
- Several steps in one call: ["batch", "fill @e2 Jane Example", "check @e6", "click @e9"] runs them in order (each step is one agent-browser command as a single string).
- Keep snapshots small: on big sites always scope them. "-s" "main" (one part of the page), "-d 4" (depth), "-i" (interactive elements only) and "-c" (compact) combine, e.g. ["snapshot", "-i", "-c", "-s", "main"]; ["get", "text", "main"] is often all you need.
- Cookie or consent banners: snapshot -i and click its accept or reject button. If a click says the element is covered, or the banner's buttons don't appear, the banner is usually inside a frame: ["frame", "iframe[title*='consent' i]"], snapshot -i, click, then ["frame", "main"].
- Take a fresh snapshot after anything that changes the page; refs change.
- The browser is installed by setup: if it says agent-browser is missing, call computer_setup.
- ${JOB_HELP}

RETURNS: the command's output (page text, snapshot, or a result line), or an image for screenshot.`,
      inputSchema: {
        computer: computerArg,
        args: z.array(z.string().max(20_000)).min(1).max(64).describe('The agent-browser command and its arguments, for example ["open", "https://example.com"].'),
      },
      annotations: acts,
    },
    tool(async ({ computer, args }: { computer: string; args: string[] }, extra) => {
      const located = await computers.ready(computer);
      const screenshot = args[0] === 'screenshot';
      const shot = `/tmp/computer-shot-${Date.now()}.png`;
      const where = BROWSER_ACTIONS.has(args[0]) ? ' && echo "Now at: $(agent-browser get url) | $(agent-browser get title)"' : '';
      const command = `agent-browser ${quoteArgs(screenshot ? ['screenshot', shot, ...args.slice(1)] : args)}${where}`;
      const status = await waitCancellable(computers, located, computers.begin(located, command, 300, undefined, 'browser'), extra);
      if (screenshot && status.state === 'finished' && status.exit_code === 0) {
        const image = await located.provider.download(located.computer, shot);
        return { content: [{ type: 'image', data: image.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: `Screenshot of the browser on ${located.computer.name}.` }] };
      }
      return json(status);
    }),
  );

  server.registerTool(
    'computer_copy_in',
    {
      description: `Put a file on a computer: either a file from the person's Library, or text you write (a script, a config file, a list).

WHEN TO USE:
- A command or website on the computer needs one of the person's files: pass library_path.
- You need to write a file on the computer: pass content. This is easier than writing it through computer_run, with no quoting.

GOOD TO KNOW: one file at a time, up to 200 MB (zip a folder first). By default it won't overwrite a file on the computer; pass replace: true to overwrite.

RETURNS: the path it landed at on the computer and its size.`,
      inputSchema: {
        computer: computerArg,
        library_path: z.string().optional().describe('A Library file to copy, relative to the Library (for example "Reports/q3.xlsx"). Give this or content.'),
        content: z.string().max(5_000_000).optional().describe('Text to write into the file instead of copying a Library file.'),
        destination: z.string().describe('Where to put it on the computer; relative paths start in its home folder (for example "q3.xlsx" or "data/q3.xlsx").'),
        replace: z.boolean().default(false).describe('true to overwrite an existing file there.'),
      },
      annotations: acts,
    },
    tool(async ({ computer, library_path, content, destination, replace }: { computer: string; library_path?: string; content?: string; destination: string; replace: boolean }) =>
      json(await computers.copyIn(await computers.ready(computer), library_path, content, destination, replace)),
    ),
  );

  server.registerTool(
    'computer_copy_out',
    {
      description: `Copy a file from a computer into the person's Library, so they can open it.

WHEN TO USE:
- A result the person should keep or see: a report, a chart, a converted document, a download.

GOOD TO KNOW: it creates a new file and never overwrites a Library file; pick a new name if one exists. One file at a time (zip folders first, with computer_run).

RETURNS: library_path (where it was saved) and its size.`,
      inputSchema: {
        computer: computerArg,
        source: z.string().describe('The file on the computer; relative paths start in its home folder.'),
        library_path: z.string().describe('New file name in the Library, for example "Reports/q3-chart.png". The folder must exist.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    tool(async ({ computer, source, library_path }: { computer: string; source: string; library_path: string }) =>
      json(await computers.copyOut(await computers.ready(computer), source, library_path)),
    ),
  );

  server.registerTool(
    'computer_save_tool',
    {
      description: `Save a script on a computer as a named tool, so it can be used again later with computer_use_tool (by you, or in a later conversation or automation).

WHEN TO USE:
- You worked out a multi-step job that will be needed again (a weekly report, a file clean-up, a site check). Test it with computer_run first, then save it.

GOOD TO KNOW: the script is bash (or anything with a #! line); arguments arrive as $1, $2…; it runs in the home folder. Saving with an existing name replaces that tool.

RETURNS: the tool's name and where it is saved (~/tools/<name>).`,
      inputSchema: {
        computer: computerArg,
        name: z.string().describe('Tool name: lowercase letters, digits and dashes (for example "weekly-report").'),
        description: z.string().min(1).describe('One or two sentences: what it does and what arguments it takes.'),
        script: z.string().min(1).max(200_000).describe('The script.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ computer, name, description, script }: { computer: string; name: string; description: string; script: string }) =>
      json(await computers.saveTool(await computers.ready(computer), name, description, script)),
    ),
  );

  server.registerTool(
    'computer_tools',
    {
      description: `List the tools saved on a computer with computer_save_tool, with what each does.

WHEN TO USE: before redoing a job by hand on a computer that may already have a tool for it.

RETURNS: tools (name, description).`,
      inputSchema: { computer: computerArg },
      annotations: readOnly,
    },
    tool(async ({ computer }: { computer: string }) => {
      const located = await computers.ready(computer);
      return json({ computer: located.computer.name, tools: await computers.tools(located) });
    }),
  );

  server.registerTool(
    'computer_use_tool',
    {
      description: `Run a tool saved on a computer (see computer_tools), with arguments.

GOOD TO KNOW: tools work on files on the computer. To use a Library file, copy it in first (computer_copy_in); to give the person a result, copy it out afterwards (computer_copy_out).

${JOB_HELP}

RETURNS: the same shape as computer_run.`,
      inputSchema: {
        computer: computerArg,
        name: z.string().describe('The saved tool\'s name.'),
        args: z.array(z.string().max(20_000)).max(64).default([]).describe('Arguments, passed as $1, $2….'),
        timeout_sec: z.number().int().min(10).max(7200).default(1800).describe('End it after this many seconds. Default 1800.'),
      },
      annotations: acts,
    },
    tool(async ({ computer, name, args, timeout_sec }: { computer: string; name: string; args: string[]; timeout_sec: number }, extra) => {
      const located = await computers.ready(computer);
      if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new ConnectorError(`"${name}" is not a tool name.`, 'BAD_NAME', 'Call computer_tools to see the saved tools.');
      const command = `[ -x ~/tools/${name} ] || { echo "No saved tool called ${name}; call computer_tools to see them." >&2; exit 127; }; ~/tools/${name} ${quoteArgs(args)}`;
      return json(await waitCancellable(computers, located, computers.begin(located, command, timeout_sec, undefined, 'tool'), extra));
    }),
  );

  server.registerTool(
    'computer_stop',
    {
      description: `Stop (turn off) a computer now. Everything on it is kept; a stopped computer costs only storage and starts again by itself the next time a tool uses it. Running commands are ended.

WHEN TO USE: the work is done and the person won't need it for a while. Computers also stop by themselves after 15 idle minutes, so this is optional.

RETURNS: the computer's name and new state.`,
      inputSchema: { computer: computerArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    tool(async ({ computer }: { computer: string }) => {
      const located = await computers.find(computer);
      const prepared = located.computer.state === 'running' ? await computers.prepareToStop(located) : true;
      if (located.computer.state !== 'stopped') await located.provider.stop(located.computer);
      return json({
        computer: located.computer.name,
        state: 'stopped',
        ...(prepared ? {} : { warning: 'Commands that were running could not be confirmed as ended, and browser sign-ins from this session may not be saved. Check with computer_run after it next starts.' }),
      });
    }),
  );

  server.registerTool(
    'computer_remove',
    {
      description: `Delete a computer for good: the machine, its home folder, saved tools, browser sign-ins and every file on it. This can't be undone, and its cost stops.

WHEN TO USE: only when the person asks to delete it, or agrees after you suggest it. Copy out anything they want to keep first (computer_copy_out).

RETURNS: the removed computer's name.`,
      inputSchema: { computer: computerArg },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    tool(async ({ computer }: { computer: string }) => {
      const located = await computers.find(computer);
      await located.provider.remove(located.computer);
      return json({ removed: located.computer.name, provider: located.provider.id });
    }),
  );

  return server;
}
