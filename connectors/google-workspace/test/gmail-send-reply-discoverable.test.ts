/**
 * FOX-11926: after a person approved a reply, an agent searched for a reply tool,
 * found only the draft tool, and held the reply back: send_workspace_email's
 * opening line said only "Send an email", and its reply section demanded the
 * whole earlier thread be quoted. Tool search and summaries read the opening
 * first, so it must say the tool replies in a thread, and quoting must stay a
 * good habit, never a reason to hold an approved reply.
 */
import { describe, expect, it } from 'vitest';
import { gmailTools } from '../src/tools/definitions/gmail.js';

const send = gmailTools.find(tool => tool.name === 'send_workspace_email');

describe('send_workspace_email reply discoverability', () => {
  it('says in its opening line that it replies in an existing thread', () => {
    const firstLine = send?.description.split('\n')[0] ?? '';
    expect(firstLine).toMatch(/repl/i);
    expect(firstLine).toMatch(/reply_to_message_id/);
  });

  it('never makes quoting a condition of sending a reply', () => {
    expect(send?.description).not.toMatch(/MUST include quoted/i);
    expect(send?.description).toMatch(/send the reply anyway/i);
  });
});
