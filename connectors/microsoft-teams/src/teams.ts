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

function requireStringArg(args: ArgBag, name: string, label: string, nextStep: string): string {
  const value = stringArg(args, name);
  if (value) return value;
  throw new TeamsBusinessError(
    `Missing required parameter: "${name}" (${label}).`,
    nextStep,
  );
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

interface ChatMember {
  displayName: string;
  email?: string;
  roles?: string[];
}

type ChatWithMembers = Omit<Chat, 'members'> & { members?: ChatMember[] };

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

export async function getChat(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const chatId = requireStringArg(args, 'chatId', 'chat ID', 'get_chat');
  const chat = (await client
    .api(`/me/chats/${chatId}`)
    .options({ signal })
    .expand('members')
    .get()) as ChatWithMembers;

  return {
    id: chat.id,
    topic: chat.topic ?? '(No topic)',
    type: chat.chatType,
    createdAt: chat.createdDateTime,
    lastUpdated: chat.lastUpdatedDateTime,
    members: chat.members?.map((member) => ({
      displayName: member.displayName,
      email: member.email,
      roles: member.roles,
    })),
  };
}

export async function listChatMessages(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const chatId = requireStringArg(args, 'chatId', 'chat ID', 'list_chat_messages');
  const top = clampTop(numberArg(args, 'top'), 50, 50);

  const response = (await client
    .api(`/me/chats/${chatId}/messages`)
    .options({ signal })
    .top(top)
    .get()) as MaybeValue<ChatMessage>;
  const messages = response.value ?? [];

  return {
    chatId,
    count: messages.length,
    messages: messages.map(formatMessage),
  };
}

export async function sendChatMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const chatId = requireStringArg(args, 'chatId', 'chat ID', 'send_chat_message');
  const content = requireStringArg(args, 'content', 'message body', 'send_chat_message');
  const response = (await client.api(`/me/chats/${chatId}/messages`).options({ signal }).post({
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

export async function listTeams(
  client: Client,
  _args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const response = (await client
    .api('/me/joinedTeams')
    .options({ signal })
    .select('id,displayName,description')
    .get()) as MaybeValue<Team>;
  const teams = response.value ?? [];

  return {
    count: teams.length,
    teams: teams.map((team) => ({
      id: team.id,
      name: team.displayName,
      description: team.description,
    })),
  };
}

export async function listChannels(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = requireStringArg(args, 'teamId', 'team ID', 'list_channels');
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

interface Presence {
  availability?: string;
  activity?: string;
  statusMessage?: {
    message?: {
      content?: string | null;
    } | null;
  } | null;
}

export async function getPresence(
  client: Client,
  _args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const presence = (await client.api('/me/presence').options({ signal }).get()) as Presence;
  return {
    availability: presence.availability,
    activity: presence.activity,
    statusMessage: presence.statusMessage?.message?.content,
  };
}
