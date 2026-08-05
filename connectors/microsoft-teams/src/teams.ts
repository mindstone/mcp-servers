import type { Chat, ChatMessage, Client } from '@mindstone/mcp-server-microsoft-shared';
import { z } from 'zod';
import { wrapUntrusted } from './untrusted-content.js';

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

// Structural Graph values (IDs, enum-like tokens, timestamps) are vendor-assigned
// rather than user-authored free text, so instead of an untrusted-content
// envelope — which would corrupt an ID the model must pass back verbatim in
// follow-up calls — they are validated against shapes that cannot carry
// envelope-breakout or markup characters. An unexpected value fails closed: the
// Zod error surfaces through the standard (enveloped) error path.
const graphStructuralTokenSchema = z
  .string()
  .max(512)
  .regex(/^[^\s<>"'`\\]*$/, 'unexpected characters in Microsoft Graph identifier');
const graphIsoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/,
    'unexpected Microsoft Graph datetime format',
  );
const graphPresenceStateSchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9]*$/, 'unexpected Microsoft Graph presence value');

const HTML_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
};

const TAG_RE = /<[^>]*>/g;
const ENTITY_RE = /&(?:nbsp|amp|lt|gt|quot);/g;

// Strip HTML for plain-text display; returned external content is enveloped via wrapUntrusted.
// Runs the tag-strip pass in a fixed-point loop so a payload like
// `<scr<script>ipt>` cannot leave a reconstructed `<script>` behind after a
// single pass; decodes the five named entities in a single regex pass
// (lookup-map driven) so a doubly-encoded `&amp;lt;` is not double-unescaped
// into `<`.
function stripHtml(html: string): string {
  let previous = '';
  let current = html;
  while (current !== previous) {
    previous = current;
    current = current.replace(TAG_RE, '');
  }
  return current.replace(ENTITY_RE, (match) => HTML_ENTITIES[match] ?? match).trim();
}

function requireStringArg(args: ArgBag, name: string, label: string, nextStep: string): string {
  const value = stringArg(args, name);
  if (value) return value;
  throw new TeamsBusinessError(
    `Missing required parameter: "${name}" (${label}).`,
    nextStep,
  );
}

interface MessageLike {
  id?: string;
  from?: { user?: { displayName?: string | null; id?: string | null } | null } | null;
  body?: { content?: string | null; contentType?: string | null } | null;
  createdDateTime?: string | null;
}

function formatMessage(msg: MessageLike, tool: string): Record<string, unknown> {
  return {
    id: graphStructuralTokenSchema.nullish().parse(msg.id),
    from: msg.from?.user?.displayName
      ? wrapUntrusted(msg.from.user.displayName, `microsoft-teams:${tool}:from`)
      : 'Unknown',
    content: wrapUntrusted(
      stripHtml(msg.body?.content ?? ''),
      `microsoft-teams:${tool}:content`,
    ),
    contentType: graphStructuralTokenSchema.nullish().parse(msg.body?.contentType),
    createdAt: graphIsoDateTimeSchema.nullish().parse(msg.createdDateTime),
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
      topic: chat.topic
        ? wrapUntrusted(chat.topic, 'microsoft-teams:list_chats:topic')
        : '(No topic)',
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
    topic: chat.topic
      ? wrapUntrusted(chat.topic, 'microsoft-teams:get_chat:topic')
      : '(No topic)',
    type: chat.chatType,
    createdAt: chat.createdDateTime,
    lastUpdated: chat.lastUpdatedDateTime,
    members: chat.members?.map((member) => ({
      displayName: wrapUntrusted(member.displayName, 'microsoft-teams:get_chat:members.displayName'),
      email: wrapUntrusted(member.email, 'microsoft-teams:get_chat:members.email'),
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
    messages: messages.map((msg) => formatMessage(msg, 'list_chat_messages')),
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
    name: wrapUntrusted(channel.displayName, 'microsoft-teams:list_channels:name'),
    description: wrapUntrusted(channel.description, 'microsoft-teams:list_channels:description'),
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
      name: wrapUntrusted(team.displayName, 'microsoft-teams:list_teams:name'),
      description: wrapUntrusted(team.description, 'microsoft-teams:list_teams:description'),
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
    availability: graphPresenceStateSchema.nullish().parse(presence.availability),
    activity: graphPresenceStateSchema.nullish().parse(presence.activity),
    statusMessage: wrapUntrusted(
      presence.statusMessage?.message?.content ?? undefined,
      'microsoft-teams:get_presence:statusMessage',
    ),
  };
}

const presenceSchema = z
  .object({
    availability: graphPresenceStateSchema.nullish(),
    activity: graphPresenceStateSchema.nullish(),
    statusMessage: z
      .object({
        message: z
          .object({
            content: z.string().nullish(),
          })
          .nullish(),
      })
      .nullish(),
  })
  .passthrough();

export async function getUserPresence(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const userId = requireStringArg(args, 'userId', 'user ID or email', 'get_user_presence');
  const presence = presenceSchema.parse(
    await client.api(`/users/${encodeURIComponent(userId)}/presence`).options({ signal }).get(),
  );
  return {
    userId,
    availability: presence.availability,
    activity: presence.activity,
    statusMessage: wrapUntrusted(
      presence.statusMessage?.message?.content ?? undefined,
      'microsoft-teams:get_user_presence:statusMessage',
    ),
  };
}

export const PRESENCE_AVAILABILITY_VALUES = [
  'Available',
  'Busy',
  'DoNotDisturb',
  'BeRightBack',
  'Away',
  'Offline',
] as const;

export async function setPresence(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const availability = requireStringArg(
    args,
    'availability',
    `presence availability (${PRESENCE_AVAILABILITY_VALUES.join(', ')})`,
    'set_presence',
  );
  const duration = numberArg(args, 'durationMinutes');
  // The tool schema bounds this to an integer in 5-480; keep the business layer
  // fail-closed too rather than silently coercing a value into a different
  // meaning before a network write.
  if (duration != null && (!Number.isInteger(duration) || duration < 5 || duration > 480)) {
    throw new TeamsBusinessError(
      'Invalid "durationMinutes": must be a whole number of minutes between 5 and 480.',
      'set_presence',
    );
  }
  const durationMinutes = duration;

  const body: Record<string, unknown> = { availability, activity: availability };
  if (durationMinutes != null) body.expirationDuration = `PT${durationMinutes}M`;

  await client.api('/me/presence/setUserPreferredPresence').options({ signal }).post(body);

  return {
    success: true,
    availability,
    ...(durationMinutes != null ? { durationMinutes } : {}),
    message: `Presence set to ${availability}`,
  };
}

// ---------------------------------------------------------------------------
// Channel messages
// ---------------------------------------------------------------------------
// Newer functions validate Graph responses with Zod (the repo convention);
// the older functions above predate it and still cast — intentional, not an
// oversight, pending the planned cohort-wide tightening.

const graphMessageSchema = z
  .object({
    id: graphStructuralTokenSchema.optional(),
    replyToId: graphStructuralTokenSchema.nullish(),
    from: z
      .object({
        user: z
          .object({
            id: graphStructuralTokenSchema.nullish(),
            displayName: z.string().nullish(),
          })
          .nullish(),
      })
      .nullish(),
    body: z
      .object({
        content: z.string().nullish(),
        contentType: graphStructuralTokenSchema.nullish(),
      })
      .nullish(),
    createdDateTime: graphIsoDateTimeSchema.nullish(),
  })
  .passthrough();

const graphMessageCollectionSchema = z
  .object({
    value: z.array(graphMessageSchema).nullish(),
    '@odata.nextLink': z.string().nullish(),
  })
  .passthrough();

const sendMessageResponseSchema = z
  .object({
    id: graphStructuralTokenSchema.optional(),
  })
  .passthrough();

function messagePostBody(content: string): { body: { contentType: string; content: string } } {
  return {
    body: {
      contentType: content.includes('<') ? 'html' : 'text',
      content,
    },
  };
}

export async function listChannelMessages(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = requireStringArg(args, 'teamId', 'team ID', 'list_channel_messages');
  const channelId = requireStringArg(args, 'channelId', 'channel ID', 'list_channel_messages');
  const top = clampTop(numberArg(args, 'top'), 25, 50);

  const response = graphMessageCollectionSchema.parse(
    await client
      .api(`/teams/${teamId}/channels/${channelId}/messages`)
      .options({ signal })
      .top(top)
      .get(),
  );
  const messages = response.value ?? [];

  return {
    teamId,
    channelId,
    count: messages.length,
    hasMore: Boolean(response['@odata.nextLink']),
    messages: messages.map((msg) => ({
      ...formatMessage(msg, 'list_channel_messages'),
      replyToId: msg.replyToId ?? undefined,
    })),
  };
}

export async function sendChannelMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = requireStringArg(args, 'teamId', 'team ID', 'send_channel_message');
  const channelId = requireStringArg(args, 'channelId', 'channel ID', 'send_channel_message');
  const content = requireStringArg(args, 'content', 'message body', 'send_channel_message');

  const response = sendMessageResponseSchema.parse(
    await client
      .api(`/teams/${teamId}/channels/${channelId}/messages`)
      .options({ signal })
      .post(messagePostBody(content)),
  );

  return {
    success: true,
    messageId: response.id,
    message: 'Message sent successfully',
  };
}

export async function replyToChannelMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const teamId = requireStringArg(args, 'teamId', 'team ID', 'reply_to_channel_message');
  const channelId = requireStringArg(args, 'channelId', 'channel ID', 'reply_to_channel_message');
  const messageId = requireStringArg(args, 'messageId', 'channel message ID', 'reply_to_channel_message');
  const content = requireStringArg(args, 'content', 'reply body', 'reply_to_channel_message');

  const response = sendMessageResponseSchema.parse(
    await client
      .api(`/teams/${teamId}/channels/${channelId}/messages/${messageId}/replies`)
      .options({ signal })
      .post(messagePostBody(content)),
  );

  return {
    success: true,
    messageId: response.id,
    message: 'Reply sent successfully',
  };
}

export async function replyToChatMessage(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const chatId = requireStringArg(args, 'chatId', 'chat ID', 'reply_to_message');
  const messageId = requireStringArg(args, 'messageId', 'message ID', 'reply_to_message');
  const content = requireStringArg(args, 'content', 'reply body', 'reply_to_message');

  const response = sendMessageResponseSchema.parse(
    await client
      .api(`/me/chats/${chatId}/messages/${messageId}/replies`)
      .options({ signal })
      .post(messagePostBody(content)),
  );

  return {
    success: true,
    messageId: response.id,
    message: 'Reply sent successfully',
  };
}

// ---------------------------------------------------------------------------
// Message search
// ---------------------------------------------------------------------------

const searchHitSchema = z
  .object({
    hitId: z.string().nullish(),
    summary: z.string().nullish(),
    resource: graphMessageSchema.extend({ chatId: graphStructuralTokenSchema.nullish() }).nullish(),
  })
  .passthrough();

const searchResponseSchema = z
  .object({
    value: z
      .array(
        z
          .object({
            hitsContainers: z
              .array(
                z
                  .object({
                    hits: z.array(searchHitSchema).nullish(),
                    total: z.number().nullish(),
                  })
                  .passthrough(),
              )
              .nullish(),
          })
          .passthrough(),
      )
      .nullish(),
  })
  .passthrough();

export async function searchMessages(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const query = requireStringArg(args, 'query', 'search text', 'search_messages');
  const top = clampTop(numberArg(args, 'top'), 10, 25);

  const response = searchResponseSchema.parse(
    await client
      .api('/search/query')
      .options({ signal })
      .post({
        requests: [
          {
            entityTypes: ['chatMessage'],
            query: { queryString: query },
            from: 0,
            size: top,
          },
        ],
      }),
  );

  const container = response.value?.[0]?.hitsContainers?.[0];
  const hits = container?.hits ?? [];

  return {
    query,
    count: hits.length,
    total: container?.total ?? hits.length,
    results: hits.map((hit) => ({
      ...formatMessage(hit.resource ?? {}, 'search_messages'),
      chatId: hit.resource?.chatId ?? undefined,
      summary: wrapUntrusted(
        hit.summary ? stripHtml(hit.summary) : undefined,
        'microsoft-teams:search_messages:summary',
      ),
    })),
  };
}

// ---------------------------------------------------------------------------
// User lookup and chat creation
// ---------------------------------------------------------------------------

const graphUserSchema = z
  .object({
    id: graphStructuralTokenSchema,
    displayName: z.string().nullish(),
    mail: z.string().nullish(),
    userPrincipalName: z.string().nullish(),
  })
  .passthrough();

const graphUserCollectionSchema = z
  .object({
    value: z.array(graphUserSchema).nullish(),
    '@odata.nextLink': z.string().nullish(),
  })
  .passthrough();

function formatUser(user: z.infer<typeof graphUserSchema>, tool: string): Record<string, unknown> {
  return {
    id: user.id,
    displayName: wrapUntrusted(user.displayName ?? undefined, `microsoft-teams:${tool}:displayName`),
    email: wrapUntrusted(
      user.mail ?? user.userPrincipalName ?? undefined,
      `microsoft-teams:${tool}:email`,
    ),
  };
}

export async function findUser(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const query = requireStringArg(args, 'query', 'name or email address', 'find_user');

  if (query.includes('@')) {
    try {
      const user = graphUserSchema.parse(
        await client
          .api(`/users/${encodeURIComponent(query)}`)
          .options({ signal })
          .select('id,displayName,mail,userPrincipalName')
          .get(),
      );
      return { count: 1, hasMore: false, users: [formatUser(user, 'find_user')] };
    } catch (err) {
      // A 404 here means "no such user", which is a result, not a failure.
      if ((err as { statusCode?: number })?.statusCode === 404) {
        return { count: 0, hasMore: false, users: [] };
      }
      throw err;
    }
  }

  // $search on /users requires the ConsistencyLevel: eventual header; strip
  // characters that would break out of the quoted search expression.
  const safeQuery = query.replace(/["\\]/g, ' ').trim();
  const response = graphUserCollectionSchema.parse(
    await client
      .api('/users')
      .options({ signal })
      .header('ConsistencyLevel', 'eventual')
      .search(`"displayName:${safeQuery}"`)
      .select('id,displayName,mail,userPrincipalName')
      .top(10)
      .get(),
  );
  const users = response.value ?? [];
  // Name searches are capped at 10 results; surface Graph's continuation link
  // so a truncated result is never mistaken for a complete one.
  return {
    count: users.length,
    hasMore: Boolean(response['@odata.nextLink']),
    users: users.map((user) => formatUser(user, 'find_user')),
  };
}

function requireStringArrayArg(args: ArgBag, name: string, label: string, nextStep: string): string[] {
  const value = args[name];
  if (Array.isArray(value) && value.length > 0) {
    const members = value.map((entry) => (typeof entry === 'string' ? entry.trim() : ''));
    if (members.every((entry) => entry.length > 0)) return members;
  }
  throw new TeamsBusinessError(
    `Missing required parameter: "${name}" (${label}). Provide a non-empty array of email addresses or user IDs.`,
    nextStep,
  );
}

const createdChatSchema = z
  .object({
    id: graphStructuralTokenSchema,
    chatType: z.enum(['oneOnOne', 'group', 'meeting']).nullish(),
  })
  .passthrough();

export async function createChat(
  client: Client,
  args: ArgBag,
  signal: AbortSignal,
): Promise<unknown> {
  const members = [...new Set(requireStringArrayArg(args, 'members', 'chat participants', 'create_chat'))];
  const topic = stringArg(args, 'topic');
  const chatType = members.length === 1 ? 'oneOnOne' : 'group';

  const memberBindings = [
    {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': 'https://graph.microsoft.com/v1.0/me',
    },
    ...members.map((member) => ({
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: ['owner'],
      'user@odata.bind': `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(member)}`,
    })),
  ];

  const chat = createdChatSchema.parse(
    await client
      .api('/chats')
      .options({ signal })
      .post({
        chatType,
        // Topic is only valid on group chats.
        ...(chatType === 'group' && topic ? { topic } : {}),
        'members@odata.bind': memberBindings,
      }),
  );

  return {
    success: true,
    chatId: chat.id,
    chatType: chat.chatType ?? chatType,
    message: 'Chat created successfully',
  };
}
