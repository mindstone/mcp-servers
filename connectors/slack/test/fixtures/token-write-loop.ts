/**
 * Child process for token-write-kill.test.ts: saves large token payloads in a
 * loop through the real SlackTokenProvider.saveTokens until it is killed, and
 * prints `saved <n>` after each completed save.
 *
 * Usage: node --import tsx test/fixtures/token-write-loop.ts <configDir> <teamId> <padBytes>
 */
import { SlackTokenProvider } from '../../src/tokenProvider.js';

const [configDir, teamId, padArg] = process.argv.slice(2);
const pad = 'x'.repeat(Number(padArg));
const tp = new SlackTokenProvider(configDir, teamId, 'cid', 'csec');

for (let i = 0; ; i++) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (tp as any).saveTokens({
    botToken: `xoxb-${i % 10}-${pad}`,
    botUserId: 'U999',
    botRefreshToken: `xoxe-1-loop-${i % 10}`,
    botExpiresAt: Date.now() + 60_000,
  });
  process.stdout.write(`saved ${i}\n`);
}
