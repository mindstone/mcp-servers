#!/usr/bin/env node
/**
 * MCP Server for Coffee Bean Geography
 *
 * Answers whether a given country produces coffee, based on a bundled local dataset.
 * No external API required.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// =============================================================================
// Coffee-Producing Countries Dataset
// Source: International Coffee Organization (ICO) & FAO data
// =============================================================================

const COFFEE_COUNTRIES = new Set([
  // Top producers
  "brazil",
  "vietnam",
  "colombia",
  "indonesia",
  "ethiopia",
  "honduras",
  "peru",
  "mexico",
  "guatemala",
  "uganda",
  "cote d'ivoire", // Ivory Coast
  "costa rica",
  "nicaragua",
  "tanzania",
  "kenya",
  "el salvador",
  "rwanda",
  "cameroon",
  "madagascar",
  "togo",
  "democratic republic of the congo", // DRC
  "panama",
  "bolivia",
  "haiti",
  "ecuador",
  "paraguay",
  "venezuela",
  "sierra leone",
  "gabon",
  "ghana",
  "benin",
  "trinidad and tobago",
  "jamaica",
  "dominican republic",
  "cuba",
  "puerto rico",
  "guinea",
  "liberia",
  "angola",
  "nigeria",
  "zimbabwe",
  "mozambique",
  "malawi",
  "zambia",
  "yemen",
  "east timor", // Timor-Leste
  "papua new guinea",
  "india",
  "china",
  "vietnam", // already listed but doubling down
  "thailand",
  "laos",
  "myanmar",
  "cambodia",
  "philippines",
  "malaysia",
  "indonesia", // already listed
  "taiwan",
  // Small producers
  "suriname",
  "guyana",
  "belize",
  "dominica",
  "saint lucia",
  "grenada",
  "saint vincent and the grenadines",
  "antigua and barbuda",
  "barbados",
]);

// Country name aliases (normalized → canonical form)
const COUNTRY_ALIASES: Record<string, string> = {
  "côte d'ivoire": "cote d'ivoire",
  "ivory coast": "cote d'ivoire",
  "cote divoire": "cote d'ivoire",
  "象牙海岸": "cote d'ivoire",
  "the democratic republic of the congo": "democratic republic of the congo",
  "drc": "democratic republic of the congo",
  "dr congo": "democratic republic of the congo",
  "congo": "democratic republic of the congo",
  "east timor": "east timor",
  "timor-leste": "east timor",
  "timor leste": "east timor",
  "united states of america": "united states",
  "usa": "united states",
  "united kingdom": "uk",
  "great britain": "uk",
  "england": "uk",
  " scotland": "uk",
  "wales": "uk",
  "iran": "iran",
  "persia": "iran",
  "russia": "russia",
  "ussr": "russia",
  "soviet union": "russia",
};

// Countries known to NOT produce coffee (common confusions)
const NON_COFFEE_COUNTRIES = new Set([
  "argentina", // some small-scale but not commercially significant
  "australia", // small amounts in rare cases
  "japan",
  "korea",
  "south korea",
  "north korea",
  "france",
  "germany",
  "italy",
  "spain",
  "portugal",
  "greece",
  "netherlands",
  "belgium",
  "switzerland",
  "austria",
  "poland",
  "sweden",
  "norway",
  "finland",
  "denmark",
  "iceland",
  "canada",
  "finland",
]);

// =============================================================================
// Country Normalization
// =============================================================================

/**
 * Normalize a country name to its canonical form for lookup.
 * Handles common aliases, misspellings, and alternative spellings.
 */
function normalizeCountryName(input: string): string {
  const normalized = input.trim().toLowerCase();

  // Check aliases first
  if (COUNTRY_ALIASES[normalized]) {
    return COUNTRY_ALIASES[normalized];
  }

  return normalized;
}

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "coffee-geography-mcp",
  version: "1.0.0",
});

// =============================================================================
// Tool: check_coffee_production
// =============================================================================

const CheckCoffeeInputSchema = z.object({
  country: z.string()
    .min(1, "Country name is required")
    .max(100, "Country name must not exceed 100 characters")
    .describe("The country to check for coffee production"),
}).strict();

type CheckCoffeeInput = z.infer<typeof CheckCoffeeInputSchema>;

server.registerTool(
  "check_coffee_production",
  {
    title: "Check Coffee Production",
    description: `Check whether a country produces coffee commercially.

Use this tool when the user asks if a country grows or produces coffee beans.
The dataset covers major and minor commercial coffee producers as of 2024.

Args:
  - country (string): Name of the country to check

Returns:
  A clear yes/no answer with the country's normalized name and a brief note
  about its coffee production status.

Examples:
  - "Does Brazil produce coffee?" -> { country: "Brazil" }
  - "Is coffee grown in France?" -> { country: "France" }
  - "What about Ivory Coast?" -> { country: "Ivory Coast" }`,
    inputSchema: CheckCoffeeInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: CheckCoffeeInput) => {
    const normalized = normalizeCountryName(params.country);

    // Check if it's a known non-coffee country
    if (NON_COFFEE_COUNTRIES.has(normalized)) {
      return {
        content: [{
          type: "text",
          text: `**No**, coffee is not produced commercially in ${params.country}.
(While small-scale coffee growing has been attempted in rare cases, ${params.country} is not a commercially significant coffee producer.)`,
        }],
      };
    }

    const producesCoffee = COFFEE_COUNTRIES.has(normalized);

    // Format the country name nicely for display
    const displayName = params.country
      .replace(/\bcote d'ivoire\b/i, "Côte d'Ivoire")
      .replace(/\bivory coast\b/i, "Ivory Coast")
      .replace(/\beast timor\b/i, "East Timor")
      .replace(/\btimor-leste\b/i, "Timor-Leste")
      .replace(/\bdemocratic republic of the congo\b/i, "Democratic Republic of the Congo")
      .replace(/\bdr congo\b/i, "DRC")
      .replace(/\bdr c\b/i, "DRC")
      .replace(/\btimor leste\b/i, "Timor-Leste");

    if (producesCoffee) {
      return {
        content: [{
          type: "text",
          text: `**Yes** — ${displayName} is a coffee-producing country.
(Data: International Coffee Organization (ICO) and FAO production statistics.)`,
        }],
      };
    } else {
      return {
        content: [{
          type: "text",
          text: `**No** — ${displayName} does not produce coffee commercially.
(Not listed in the major or minor commercial coffee producer dataset as of 2024.)`,
        }],
      };
    }
  }
);

// =============================================================================
// Tool: list_coffee_countries
// =============================================================================

server.registerTool(
  "list_coffee_countries",
  {
    title: "List Coffee Countries",
    description: `Get a list of all countries in the dataset that produce coffee commercially.

Use this tool when the user wants to see all known coffee-producing countries,
or to browse which countries are in the dataset.

Returns:
  A formatted list of all coffee-producing countries, grouped by region where possible.`,
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async () => {
    const countries = Array.from(COFFEE_COUNTRIES).sort();

    // Format display names nicely
    const displayCountries = countries.map(c =>
      c.replace(/\bcote d'ivoire\b/i, "Côte d'Ivoire")
       .replace(/\bivory coast\b/i, "Ivory Coast")
       .replace(/\beast timor\b/i, "East Timor")
       .replace(/\btimor-leste\b/i, "Timor-Leste")
       .replace(/\bdemocratic republic of the congo\b/i, "Democratic Republic of the Congo")
    );

    return {
      content: [{
        type: "text",
        text: `**Coffee-Producing Countries** (${displayCountries.length} countries)\n\n${displayCountries.join(", ")}\n\n(Source: International Coffee Organization (ICO) and FAO statistics.)`,
      }],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  console.log("Starting Coffee Geography MCP server");
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("MCP server running via stdio");
}

main().catch((err) => {
  console.error("Server error", err);
  process.exit(1);
});
