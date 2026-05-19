import type { Chat, ChatMessage, Client } from '@mindstone/mcp-server-microsoft-shared';

export class TeamsBusinessError extends Error {
  readonly nextStep: string;

  constructor(message: string, nextStep: string) {
    super(message);
    this.name = 'TeamsBusinessError';
    this.nextStep = nextStep;
  }
}

interface MaybeValue<T> {
  value?: T[] | null;
}

type ArgBag = Record<string, unknown>;

function stringArg(args: ArgBag, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function numberArg(args: ArgBag, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function clampTop(value: number | undefined, defaultValue: number, maxValue: number): number {
  if (value == null) return defaultValue;
  return Math.max(1, Math.min(value, maxValue));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function messageScopePath(args: ArgBag, nextStep: string): string {
  const chatId = stringArg(args, 'chatId', 'chat_id');
  const teamId = stringArg(args, 'teamId', 'team_id');
  const channelId = stringArg(args, 'channelId', 'channel_id');
  if (chatId) return `/me/chats/${chatId}/messages`;
  if (teamId && channelId) return `/teams/${teamId}/channels/${channelId}/messages`;
  throw new TeamsBusinessError(
    'Provide either "chatId" for a chat message operation, or both "teamId" and "channelId" for a channel message operation.',
    nextStep,
  );
}

function messagePath(args: ArgBag, nextStep: string): string {
  const messageId = stringArg(args, 'messageId', 'message_id', 'id');
  if (!messageId) {
    throw new TeamsBusinessError(
      'Missing required parameter: "messageId" (the Teams message ID).',
      nextStep,
    );
  }
  return `${messageScopePath(args, nextStep)}/${messageId}`;
}

function formatMessage(msg: ChatMessage): Record<string, unknown> {
  return {
    id: msg.id,
    from: msg.from?.user?.displayName ?? 'Unknown',
    content: stripHtml(msg.body?.content ?? ''),
    contentType: msg.body?.contentType,
    createdAt: msg.createdDateTime,
  };
}

export async function listChats(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const top = clampTop(numberArg(args, 'top'), 25, 50);

  const response = (await client
    .api('/me/chats')
    .options({ signal })
    .top(top)
    .select('id,topic,chatType,createdDateTime,lastUpdatedDateTime')
    .get()) as MaybeValue<Chat>;

  const chats = (response.value ?? []).sort((a, b) => {
    const dateA = a.lastUpdatedDateTime ? new Date(a.lastUpdatedDateTime).getTime() : 0;
    const dateB = b.lastUpdatedDateTime ? new Date(b.lastUpdatedDateTime).getTime() : 0;
    return dateB - dateA;
  });

  return {
    count: chats.length,
    chats: chats.map((chat) => ({
      id: chat.id,
      topic: chat.topic ?? '(No topic)',
      type: chat.chatType,
      createdAt: chat.createdDateTime,
      lastUpdated: chat.lastUpdatedDateTime,
    })),
  };
}

export async function listMessages(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const top = clampTop(numberArg(args, 'top'), 50, 50);
  const path = messageScopePath(args, 'list_messages');

  const response = (await client.api(path).options({ signal }).top(top).get()) as MaybeValue<ChatMessage>;
  const messages = response.value ?? [];

  return {
    chatId: stringArg(args, 'chatId', 'chat_id'),
    teamId: stringArg(args, 'teamId', 'team_id'),
    channelId: stringArg(args, 'channelId', 'channel_id'),
    count: messages.length,
    messages: messages.map(formatMessage),
  };
}

export async function searchMessages(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const query = stringArg(args, 'query');
  if (!query) {
    throw new TeamsBusinessError(
      'Missing required parameter: "query" (search text). Example: { "query": "project update", "top": 20 }',
      'search_messages',
    );
  }
  const size = clampTop(numberArg(args, 'top'), 25, 50);

  const response = (await client
    .api('/search/query')
    .options({ signal })
    .post({
      requests: [
        {
          entityTypes: ['chatMessage'],
          query: { queryString: query },
          from: 0,
          size,
        },
      ],
    })) as {
    value?: Array<{
      hitsContainers?: Array<{
        hits?: Array<{ hitId?: string; summary?: string; resource?: Record<string, unknown> }>;
      }>;
    }>;
  };

  const hits = response.value?.flatMap((container) =>
    container.hitsContainers?.flatMap((hitContainer) => hitContainer.hits ?? []) ?? [],
  ) ?? [];

  return {
    query,
    count: hits.length,
    messages: hits.map((hit) => ({
      id: hit.hitId,
      summary: stripHtml(hit.summary ?? ''),
      resource: hit.resource,
    })),
  };
}

export async function getMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const msg = (await client.api(messagePath(args, 'get_message')).options({ signal }).get()) as ChatMessage;
  return formatMessage(msg);
}

interface Team {
  id: string;
  displayName?: string;
  description?: string;
}

interface Channel {
  id: string;
  displayName?: string;
  description?: string;
  membershipType?: string;
}

function formatChannel(channel: Channel): Record<string, unknown> {
  return {
    id: channel.id,
    name: channel.displayName,
    description: channel.description,
    membershipType: channel.membershipType,
  };
}

export async function listTeamChannels(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = stringArg(args, 'teamId', 'team_id');
  if (teamId) {
    const response = (await client
      .api(`/teams/${teamId}/channels`)
      .options({ signal })
      .select('id,displayName,description,membershipType')
      .get()) as MaybeValue<Channel>;
    const channels = response.value ?? [];
    return {
      teamId,
      count: channels.length,
      channels: channels.map(formatChannel),
    };
  }

  const teamsResponse = (await client
    .api('/me/joinedTeams')
    .options({ signal })
    .select('id,displayName,description')
    .get()) as MaybeValue<Team>;
  const teams = teamsResponse.value ?? [];
  const teamsWithChannels = await Promise.all(
    teams.map(async (team) => {
      const channelResponse = (await client
        .api(`/teams/${team.id}/channels`)
        .options({ signal })
        .select('id,displayName,description,membershipType')
        .get()) as MaybeValue<Channel>;
      const channels = channelResponse.value ?? [];
      return {
        id: team.id,
        name: team.displayName,
        description: team.description,
        channelCount: channels.length,
        channels: channels.map(formatChannel),
      };
    }),
  );

  return {
    count: teamsWithChannels.reduce((sum, team) => sum + team.channelCount, 0),
    teams: teamsWithChannels,
  };
}

export async function sendMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const content = stringArg(args, 'content', 'body', 'message');
  if (!content) {
    throw new TeamsBusinessError(
      'Missing required parameter: "content" (message body).',
      'send_message',
    );
  }
  const response = (await client.api(messageScopePath(args, 'send_message')).options({ signal }).post({
    body: {
      contentType: content.includes('<') ? 'html' : 'text',
      content,
    },
  })) as { id?: string };

  return {
    success: true,
    messageId: response.id,
    message: 'Message sent successfully',
  };
}

export async function replyMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const content = stringArg(args, 'content', 'body', 'message');
  if (!content) {
    throw new TeamsBusinessError(
      'Missing required parameter: "content" (reply body).',
      'reply_message',
    );
  }
  const response = (await client.api(`${messagePath(args, 'reply_message')}/replies`).options({ signal }).post({
    body: {
      contentType: content.includes('<') ? 'html' : 'text',
      content,
    },
  })) as { id?: string };

  return {
    success: true,
    messageId: response.id,
    message: 'Reply sent successfully',
  };
}
