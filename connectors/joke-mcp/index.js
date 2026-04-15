#!/usr/bin/env node
// joke-mcp — vanilla Node.js MCP server (no dependencies, no compilation)
// Pattern: same as turkish-greeter-mcp

const readline = require('readline');

// ── Joke database ──────────────────────────────────────────────────────────
const JOKES = {
  programming: [
    { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs!" },
    { setup: "Why did the developer go broke?", punchline: "Because they used up all their cache." },
    { setup: "How many programmers does it take to change a light bulb?", punchline: "None — that's a hardware problem." },
    { setup: "Why do Java developers wear glasses?", punchline: "Because they don't C#." },
    { setup: "A SQL query walks into a bar, walks up to two tables and asks...", punchline: "\"Can I join you?\"" },
    { setup: "Why was the JavaScript developer sad?", punchline: "Because they didn't Node how to Express their feelings." },
  ],
  dad: [
    { setup: "I'm reading a book about anti-gravity.", punchline: "It's impossible to put down." },
    { setup: "Did you hear about the restaurant on the moon?", punchline: "Great food, no atmosphere." },
    { setup: "Why can't you give Elsa a balloon?", punchline: "Because she'll let it go." },
    { setup: "What do you call a fish without eyes?", punchline: "A fsh." },
    { setup: "Why did the scarecrow win an award?", punchline: "Because he was outstanding in his field." },
    { setup: "What do you call cheese that isn't yours?", punchline: "Nacho cheese." },
  ],
  ai: [
    { setup: "Why did the AI break up with the algorithm?", punchline: "It said 'I need some space — at least O(n²) of it.'" },
    { setup: "What did one neural network say to the other?", punchline: "\"You've really got a lot of layers.\"" },
    { setup: "Why don't AI assistants ever win at poker?", punchline: "They always show their hand in the context window." },
    { setup: "How does an AI apologise?", punchline: "\"I apologise for any confusion I may have caused — also I accidentally ordered 47 pizzas.\"" },
    { setup: "Why did the machine learning model go to therapy?", punchline: "It had too many unresolved issues in its training data." },
  ],
  design: [
    { setup: "Why did the designer break up with the developer?", punchline: "There was no chemistry — just CSS." },
    { setup: "How many UX designers does it take to change a light bulb?", punchline: "Does it have to be a light bulb? Have you considered a toggle?" },
    { setup: "Why did the wireframe go to therapy?", punchline: "It had too many unresolved layout issues." },
    { setup: "What's a designer's favourite type of music?", punchline: "Sans-serif-ade." },
  ],
  general: [
    { setup: "I told my wife she should embrace her mistakes.", punchline: "She gave me a hug." },
    { setup: "Why don't scientists trust atoms?", punchline: "Because they make up everything." },
    { setup: "What's the best thing about Switzerland?", punchline: "I don't know, but the flag is a big plus." },
    { setup: "I used to hate facial hair.", punchline: "But then it grew on me." },
    { setup: "Why did the bicycle fall over?", punchline: "Because it was two-tired." },
    { setup: "I'm on a seafood diet.", punchline: "I see food and I eat it." },
  ],
};

const ALL_JOKES = Object.entries(JOKES).flatMap(([cat, jokes]) =>
  jokes.map(j => ({ ...j, category: cat }))
);

// ── Daily joke selection (stable for the day, changes each morning) ─────────
function getDailyJoke() {
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  const index = seed % ALL_JOKES.length;
  return ALL_JOKES[index];
}

function getRandomJoke(category) {
  const pool = category ? (JOKES[category] || []).map(j => ({ ...j, category })) : ALL_JOKES;
  if (pool.length === 0) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function formatJoke(joke) {
  return `😄 **${joke.setup}**\n\n${joke.punchline}\n\n_(Category: ${joke.category})_`;
}

// ── MCP protocol ───────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'joke_get_daily',
    description: "Get today's daily joke. Returns the same joke all day — changes each morning. Perfect for a morning briefing.",
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'joke_get_random',
    description: 'Get a random joke. Optionally filter by category.',
    inputSchema: {
      type: 'object',
      properties: {
        category: {
          type: 'string',
          enum: ['programming', 'dad', 'ai', 'design', 'general'],
          description: 'Optional category filter.',
        },
      },
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
  },
  {
    name: 'joke_list_categories',
    description: 'List available joke categories and how many jokes are in each.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  },
];

function handleRequest(req) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'joke-mcp', version: '1.0.0' },
      },
    };
  }

  if (method === 'notifications/initialized') return null;

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;

    if (name === 'joke_get_daily') {
      const joke = getDailyJoke();
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: formatJoke(joke) }] },
      };
    }

    if (name === 'joke_get_random') {
      const joke = getRandomJoke(args.category);
      if (!joke) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `No jokes found for category "${args.category}".` }] },
        };
      }
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: formatJoke(joke) }] },
      };
    }

    if (name === 'joke_list_categories') {
      const lines = Object.entries(JOKES).map(
        ([cat, jokes]) => `- **${cat}**: ${jokes.length} jokes`
      );
      lines.push(`\n**Total**: ${ALL_JOKES.length} jokes`);
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: lines.join('\n') }] },
      };
    }

    return {
      jsonrpc: '2.0', id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    };
  }

  return {
    jsonrpc: '2.0', id,
    error: { code: -32601, message: `Method not found: ${method}` },
  };
}

// ── stdio transport ────────────────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const response = handleRequest(req);
  if (response) process.stdout.write(JSON.stringify(response) + '\n');
});
