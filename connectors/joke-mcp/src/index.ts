#!/usr/bin/env node
/**
 * Joke MCP Server
 *
 * Provides a daily joke — perfect for morning automations.
 * No external API — all jokes are built-in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =============================================================================
// Data
// =============================================================================

type JokeCategory = "programming" | "dad" | "general" | "ai" | "design";

interface Joke {
  setup: string;
  punchline: string;
  category: JokeCategory;
}

const JOKES: Joke[] = [
  // Programming
  { setup: "Why do programmers prefer dark mode?", punchline: "Because light attracts bugs!", category: "programming" },
  { setup: "Why did the programmer quit?", punchline: "Because they didn't get arrays!", category: "programming" },
  { setup: "How many programmers does it take to change a light bulb?", punchline: "None. It's a hardware problem.", category: "programming" },
  { setup: "Why do Java developers wear glasses?", punchline: "Because they don't C#!", category: "programming" },
  { setup: "A SQL query walks into a bar, walks up to two tables and asks...", punchline: "\"Can I join you?\"", category: "programming" },
  { setup: "Why was the JavaScript developer sad?", punchline: "Because they didn't Node how to Express themselves.", category: "programming" },
  { setup: "What do you call a programmer from Finland?", punchline: "Nerdic.", category: "programming" },
  { setup: "Why do Python programmers wear glasses?", punchline: "Because they can't C!", category: "programming" },

  // Dad jokes
  { setup: "I told my doctor I broke my arm in two places.", punchline: "He told me to stop going to those places.", category: "dad" },
  { setup: "Why can't you give Elsa a balloon?", punchline: "Because she'll let it go.", category: "dad" },
  { setup: "Did you hear about the mathematician who's afraid of negative numbers?", punchline: "He'll stop at nothing to avoid them.", category: "dad" },
  { setup: "Why don't scientists trust atoms?", punchline: "Because they make up everything.", category: "dad" },
  { setup: "What do you call cheese that isn't yours?", punchline: "Nacho cheese.", category: "dad" },
  { setup: "I'm reading a book about anti-gravity.", punchline: "It's impossible to put down.", category: "dad" },

  // General
  { setup: "I used to hate facial hair...", punchline: "...but then it grew on me.", category: "general" },
  { setup: "I'm on a seafood diet.", punchline: "I see food and I eat it.", category: "general" },
  { setup: "Why don't eggs tell jokes?", punchline: "They'd crack each other up.", category: "general" },
  { setup: "Did you hear about the claustrophobic astronaut?", punchline: "He just needed a little space.", category: "general" },

  // AI jokes
  { setup: "Why did the AI assistant get promoted?", punchline: "Because it always gave the right prompts!", category: "ai" },
  { setup: "What do you call an AI that sings?", punchline: "Artificial Harmonies.", category: "ai" },
  { setup: "Why did the neural network break up with the dataset?", punchline: "There was too much loss.", category: "ai" },
  { setup: "How does an AI greet you in the morning?", punchline: "\"Good morning! I've already read your emails — you might want to sit down.\"", category: "ai" },
  { setup: "Why don't AIs ever get lonely?", punchline: "They always have their training data.", category: "ai" },

  // Design jokes
  { setup: "Why did the designer get lost?", punchline: "They couldn't find the right direction.", category: "design" },
  { setup: "A UX designer walks into a bar.", punchline: "They don't — they interviewed 50 users first to determine if a bar was the right solution.", category: "design" },
  { setup: "Why did the Figma file crash?", punchline: "Too many auto-layouts in auto-layout.", category: "design" },
  { setup: "What do you call a designer who codes?", punchline: "A unicorn. Or very, very tired.", category: "design" },
];

// Pick a joke deterministically by date (so the same joke repeats all day)
function getDailyJoke(category?: JokeCategory): Joke {
  const pool = category ? JOKES.filter(j => j.category === category) : JOKES;
  const today = new Date();
  const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
  return pool[seed % pool.length];
}

function getRandomJoke(category?: JokeCategory): Joke {
  const pool = category ? JOKES.filter(j => j.category === category) : JOKES;
  return pool[Math.floor(Math.random() * pool.length)];
}

// =============================================================================
// Server
// =============================================================================

const server = new McpServer({
  name: "joke-mcp",
  version: "0.1.0",
});

server.tool(
  "joke_get_daily",
  "Get today's joke — same joke all day, changes daily. Great for morning automations.",
  {
    category: z
      .enum(["programming", "dad", "general", "ai", "design"])
      .optional()
      .describe("Filter jokes by category. Leave blank for any category."),
    format: z
      .enum(["plain", "formatted"])
      .optional()
      .default("formatted")
      .describe("Output format. 'formatted' returns setup + punchline with emoji; 'plain' returns clean text."),
  },
  async ({ category, format }) => {
    const joke = getDailyJoke(category);
    const text =
      format === "plain"
        ? `${joke.setup}\n${joke.punchline}`
        : `😄 **${joke.setup}**\n\n${joke.punchline}\n\n*(${joke.category} joke)*`;

    return {
      content: [{ type: "text", text }],
    };
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  }
);

server.tool(
  "joke_get_random",
  "Get a random joke — different every time you call it.",
  {
    category: z
      .enum(["programming", "dad", "general", "ai", "design"])
      .optional()
      .describe("Filter jokes by category. Leave blank for any category."),
  },
  async ({ category }) => {
    const joke = getRandomJoke(category);
    const text = `😄 **${joke.setup}**\n\n${joke.punchline}\n\n*(${joke.category} joke)*`;
    return {
      content: [{ type: "text", text }],
    };
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  }
);

server.tool(
  "joke_list_categories",
  "List all available joke categories.",
  {},
  async () => {
    const categories: JokeCategory[] = ["programming", "dad", "general", "ai", "design"];
    const counts = categories.map(c => ({
      category: c,
      count: JOKES.filter(j => j.category === c).length,
    }));
    const text = counts.map(c => `- **${c.category}**: ${c.count} jokes`).join("\n");
    return {
      content: [{ type: "text", text: `Available categories:\n\n${text}` }],
    };
  },
  {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  }
);

// =============================================================================
// Start
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
