/**
 * The only code that makes Things do anything. Small and injectable, so tests use a fake that
 * records calls, and nothing outside the writer can reach it.
 */
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { wrapUntrusted } from './untrusted-content.js';

const run = promisify(execFile);

const THINGS_PREFS = join(
  homedir(),
  'Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/Library/Preferences/JLMPQHK86H.com.culturedcode.ThingsMac.plist',
);

export interface ThingsExecutor {
  /** Open a `things:///` URL without bringing Things to the front. */
  openUrl(url: string): Promise<void>;
  /** Run an AppleScript `on run argv` handler. Arguments go in as argv, never into the script text. */
  appleScript(script: string, args: string[]): Promise<string>;
  /** Whether "Enable Things URLs" is on. A URL command sent while it is off pops up an alert. */
  urlSchemeEnabled(): Promise<boolean>;
  /** Whether Things is running (a first command may take longer while it starts). */
  thingsRunning(): Promise<boolean>;
}

async function isRunning(): Promise<boolean> {
  try {
    await run('/usr/bin/pgrep', ['-x', 'Things3']);
    return true;
  } catch {
    return false;
  }
}

export const macExecutor: ThingsExecutor = {
  async openUrl(url) {
    if (!url.startsWith('things:///')) throw new Error('Refusing to open a non-Things URL.');
    // `-g`: in the background, so Things doesn't jump in front of the user.
    await run('/usr/bin/open', ['-g', url], { timeout: 15_000 });
  },
  async appleScript(script, args) {
    // An Apple event to a closed Things would launch it in front; launch it in the background first.
    if (!(await isRunning())) {
      await run('/usr/bin/open', ['-g', '-a', 'Things3']);
      await new Promise((r) => setTimeout(r, 3000));
    }
    try {
      const { stdout } = await run('/usr/bin/osascript', ['-e', script, ...args], { timeout: 30_000 });
      return stdout.trim();
    } catch (e) {
      const stderr = String((e as { stderr?: unknown }).stderr ?? '');
      if (/-1743|not authori[sz]ed to send apple events/i.test(stderr)) {
        throw new Error(
          'macOS did not allow this app to control Things. Allow it in System Settings > Privacy & Security > Automation (the app this server runs in > Things3), then retry.',
        );
      }
      // stderr can quote the item; it is the user's text.
      throw new Error(`AppleScript failed: ${wrapUntrusted(stderr.trim() || (e as Error).message, 'things')}`);
    }
  },
  async urlSchemeEnabled() {
    try {
      const { stdout } = await run('/usr/bin/defaults', ['read', THINGS_PREFS, 'uriSchemeEnabled']);
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  },
  thingsRunning: isRunning,
};
