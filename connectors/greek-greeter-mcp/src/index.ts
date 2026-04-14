#!/usr/bin/env node
/**
 * Greek Greeter MCP Server
 *
 * Provides Greek greetings and common Greek phrases.
 * No external API — all data is built-in.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =============================================================================
// Data
// =============================================================================

type TimeOfDay = "morning" | "afternoon" | "evening" | "night";
type Formality = "formal" | "informal";

interface Greeting {
  greek: string;
  transliteration: string;
  english: string;
}

const GREETINGS: Record<TimeOfDay, Record<Formality, Greeting>> = {
  morning: {
    formal: {
      greek: "Καλημέρα σας",
      transliteration: "Kaliméra sas",
      english: "Good morning (formal)",
    },
    informal: {
      greek: "Καλημέρα",
      transliteration: "Kaliméra",
      english: "Good morning",
    },
  },
  afternoon: {
    formal: {
      greek: "Καλησπέρα σας",
      transliteration: "Kalispéra sas",
      english: "Good afternoon/evening (formal)",
    },
    informal: {
      greek: "Γεια σου",
      transliteration: "Yia sou",
      english: "Hi / Hello",
    },
  },
  evening: {
    formal: {
      greek: "Καλησπέρα σας",
      transliteration: "Kalispéra sas",
      english: "Good evening (formal)",
    },
    informal: {
      greek: "Καλησπέρα",
      transliteration: "Kalispéra",
      english: "Good evening",
    },
  },
  night: {
    formal: {
      greek: "Καληνύχτα σας",
      transliteration: "Kaliníchta sas",
      english: "Good night (formal)",
    },
    informal: {
      greek: "Καληνύχτα",
      transliteration: "Kaliníchta",
      english: "Good night",
    },
  },
};

interface Phrase {
  greek: string;
  transliteration: string;
  english: string;
  category: string;
}

const PHRASES: Phrase[] = [
  // Greetings & farewells
  { greek: "Γεια σας", transliteration: "Yia sas", english: "Hello / Goodbye (formal, plural)", category: "greetings" },
  { greek: "Αντίο", transliteration: "Andío", english: "Goodbye", category: "greetings" },
  { greek: "Τα λέμε", transliteration: "Ta léme", english: "See you later (lit. 'we'll talk')", category: "greetings" },
  { greek: "Χαίρετε", transliteration: "Hérete", english: "Hello (formal)", category: "greetings" },

  // Politeness
  { greek: "Παρακαλώ", transliteration: "Parakaló", english: "Please / You're welcome", category: "politeness" },
  { greek: "Ευχαριστώ", transliteration: "Efcharistó", english: "Thank you", category: "politeness" },
  { greek: "Συγγνώμη", transliteration: "Signómi", english: "Sorry / Excuse me", category: "politeness" },
  { greek: "Με συγχωρείτε", transliteration: "Me sinchoríte", english: "Excuse me (formal)", category: "politeness" },

  // Common expressions
  { greek: "Ναι", transliteration: "Ne", english: "Yes", category: "basics" },
  { greek: "Όχι", transliteration: "Óchi", english: "No", category: "basics" },
  { greek: "Δεν ξέρω", transliteration: "Den xéro", english: "I don't know", category: "basics" },
  { greek: "Δεν καταλαβαίνω", transliteration: "Den katalavaíno", english: "I don't understand", category: "basics" },
  { greek: "Μιλάτε αγγλικά;", transliteration: "Miláte angliká?", english: "Do you speak English?", category: "basics" },

  // Toasts & celebrations
  { greek: "Στην υγειά μας!", transliteration: "Stin iyiá mas!", english: "To our health! (toast)", category: "celebrations" },
  { greek: "Χρόνια πολλά!", transliteration: "Chrónia pollá!", english: "Many years! (birthday/holiday wish)", category: "celebrations" },
  { greek: "Καλή τύχη!", transliteration: "Kalí týchi!", english: "Good luck!", category: "celebrations" },
  { greek: "Μπράβο!", transliteration: "Brávo!", english: "Bravo! / Well done!", category: "celebrations" },

  // Food & hospitality
  { greek: "Καλή όρεξη!", transliteration: "Kalí órexi!", english: "Bon appétit!", category: "food" },
  { greek: "Ένα καφέ παρακαλώ", transliteration: "Éna kafé parakaló", english: "A coffee please", category: "food" },
  { greek: "Πόσο κάνει;", transliteration: "Póso káni?", english: "How much does it cost?", category: "food" },
];

const CATEGORIES = [...new Set(PHRASES.map((p) => p.category))];

// =============================================================================
// MCP Server
// =============================================================================

const server = new McpServer({
  name: "greek-greeter-mcp",
  version: "0.1.0",
});

// =============================================================================
// Tool: greek_greet
// =============================================================================

const GreetInputSchema = z.object({
  name: z
    .string()
    .min(1, "Name must not be empty")
    .max(100, "Name must not exceed 100 characters")
    .optional()
    .describe("Name of the person to greet (optional)"),
  time_of_day: z
    .enum(["morning", "afternoon", "evening", "night"])
    .default("morning")
    .describe("Time of day for the greeting (morning, afternoon, evening, night)"),
  formality: z
    .enum(["formal", "informal"])
    .default("informal")
    .describe("Formality level of the greeting (formal or informal)"),
});

type GreetInput = z.infer<typeof GreetInputSchema>;

server.registerTool(
  "greek_greet",
  {
    title: "Greek Greet",
    description: `Generate a Greek greeting appropriate for the time of day and formality level.

Use this when the user wants to greet someone in Greek, or wants to know how to say hello/good morning/good evening in Greek.

Args:
  - name (string, optional): The name of the person to greet
  - time_of_day (string): morning | afternoon | evening | night (default: morning)
  - formality (string): formal | informal (default: informal)

Returns:
  A Greek greeting with transliteration and English translation.

Examples:
  - "Greet Maria in the morning" → { name: "Maria", time_of_day: "morning", formality: "informal" }
  - "Formal good evening in Greek" → { time_of_day: "evening", formality: "formal" }`,
    inputSchema: GreetInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GreetInput) => {
    const greeting = GREETINGS[params.time_of_day][params.formality];

    const namePart = params.name ? `, ${params.name}` : "";
    // Build personalised Greek greeting
    const greekText = params.name
      ? `${greeting.greek}${namePart}!`
      : `${greeting.greek}!`;

    const lines = [
      `## Greek Greeting`,
      ``,
      `**Greek:** ${greekText}`,
      `**Transliteration:** ${greeting.transliteration}${params.name ? `, ${params.name}` : ""}`,
      `**English:** ${greeting.english}${params.name ? ` (to ${params.name})` : ""}`,
      ``,
      `*Time of day:* ${params.time_of_day} · *Formality:* ${params.formality}`,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// =============================================================================
// Tool: greek_get_phrases
// =============================================================================

const GetPhrasesInputSchema = z.object({
  category: z
    .enum(["greetings", "politeness", "basics", "celebrations", "food", "all"])
    .default("all")
    .describe(
      `Category of phrases to retrieve: greetings, politeness, basics, celebrations, food, or all`
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Maximum number of phrases to return (default: 10, max: 50)"),
});

type GetPhrasesInput = z.infer<typeof GetPhrasesInputSchema>;

server.registerTool(
  "greek_get_phrases",
  {
    title: "Get Greek Phrases",
    description: `Retrieve a list of useful Greek phrases, optionally filtered by category.

Use this when the user wants to learn Greek phrases, get a phrasebook, or find specific types of Greek expressions.

Available categories: ${CATEGORIES.join(", ")}, all

Args:
  - category (string): Filter by category — greetings, politeness, basics, celebrations, food, or all (default: all)
  - limit (number): Max phrases to return (default: 10, max: 50)

Returns:
  A formatted list of Greek phrases with transliterations and English translations.

Examples:
  - "Give me Greek toasts" → { category: "celebrations" }
  - "Top 5 Greek politeness phrases" → { category: "politeness", limit: 5 }`,
    inputSchema: GetPhrasesInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GetPhrasesInput) => {
    const filtered =
      params.category === "all"
        ? PHRASES
        : PHRASES.filter((p) => p.category === params.category);

    const results = filtered.slice(0, params.limit);

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No phrases found for category "${params.category}".`,
          },
        ],
      };
    }

    const categoryLabel =
      params.category === "all" ? "All Categories" : params.category;
    const header = `## Greek Phrases — ${categoryLabel} (${results.length} of ${filtered.length})`;

    const rows = results
      .map(
        (p, i) =>
          `${i + 1}. **${p.greek}**\n   *${p.transliteration}* — ${p.english}`
      )
      .join("\n\n");

    return {
      content: [{ type: "text", text: `${header}\n\n${rows}` }],
    };
  }
);

// =============================================================================
// Start
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[INFO] Greek Greeter MCP server running via stdio");
}

main().catch((err) => {
  console.error("[ERROR] Server error:", err);
  process.exit(1);
});
