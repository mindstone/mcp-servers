#!/usr/bin/env node
/**
 * MCP Server — British Royal Family
 *
 * Provides tools to get random members of the British Royal Family
 * and look up individual members. No external API — uses a static dataset.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";
const ROYAL_FAMILY = [
    { name: "King Charles III", title: "King", born: "14 Nov 1948", role: "Monarch", house: "Windsor" },
    { name: "Queen Camilla", title: "Queen", born: "17 Jul 1947", role: "Consort", house: "Windsor" },
    { name: "Prince William", title: "Prince of Wales", born: "21 Jun 1982", role: "Heir Apparent", house: "Windsor" },
    { name: "Princess Catherine", title: "Princess of Wales", born: "9 Jan 1982", role: "Princess of Wales", house: "Windsor" },
    { name: "Prince George", title: "Prince of Wales (heir)", born: "22 Jul 2013", role: "Second in line", house: "Windsor" },
    { name: "Princess Charlotte", title: "Princess of Wales", born: "2 May 2015", role: "Third in line", house: "Windsor" },
    { name: "Prince Louis", title: "Prince", born: "23 Apr 2018", role: "Fourth in line", house: "Windsor" },
    { name: "Prince Harry", title: "Duke of Sussex", born: "15 Sep 1984", role: "Son of the King", house: "Windsor" },
    { name: "Meghan", title: "Duchess of Sussex", born: "4 Aug 1981", role: "Duchess of Sussex", house: "Windsor" },
    { name: "Prince Archie", title: "Prince", born: "6 May 2019", role: "Son of the Duke of Sussex", house: "Windsor" },
    { name: "Princess Lilibet", title: "Princess", born: "4 Jun 2021", role: "Daughter of the Duke of Sussex", house: "Windsor" },
    { name: "Princess Anne", title: "Princess Royal", born: "15 Aug 1950", role: "King's sister", house: "Windsor" },
    { name: "Sir Timothy Laurence", title: "Vice Admiral (Ret.)", born: "1 Mar 1955", role: "Husband of Princess Anne", house: "Windsor" },
    { name: "Zara Tindall", title: "Mrs", born: "15 May 1981", role: "Granddaughter of Elizabeth II", house: "Windsor" },
    { name: "Mike Tindall", title: "Mr", born: "18 Oct 1978", role: "Husband of Zara Tindall", house: "Windsor" },
    { name: "Mia Tindall", title: "Miss", born: "17 Jan 2014", role: "Great-granddaughter of Elizabeth II", house: "Windsor" },
    { name: "Lena Tindall", title: "Miss", born: "18 Jun 2018", role: "Great-granddaughter of Elizabeth II", house: "Windsor" },
    { name: "Lucas Tindall", title: "Mr", born: "21 Mar 2021", role: "Great-grandson of Elizabeth II", house: "Windsor" },
    { name: "Peter Phillips", title: "Mr", born: "15 Nov 1977", role: "Grandson of Elizabeth II", house: "Windsor" },
    { name: "Prince Andrew", title: "Duke of York", born: "19 Feb 1960", role: "King's brother", house: "Windsor" },
    { name: "Princess Beatrice", title: "Princess", born: "8 Aug 1988", role: "Niece of the King", house: "Windsor" },
    { name: "Edoardo Mapelli Mozzi", title: "Mr", born: "18 Nov 1983", role: "Husband of Princess Beatrice", house: "Windsor" },
    { name: "Princess Eugenie", title: "Princess", born: "23 Mar 1990", role: "Niece of the King", house: "Windsor" },
    { name: "Jack Brooksbank", title: "Mr", born: "3 May 1986", role: "Husband of Princess Eugenie", house: "Windsor" },
    { name: "Prince Edward", title: "Duke of Edinburgh", born: "10 Mar 1964", role: "King's brother", house: "Windsor" },
    { name: "Duchess Sophie", title: "Duchess of Edinburgh", born: "20 Jan 1965", role: "King's sister-in-law", house: "Windsor" },
    { name: "Lady Louise Windsor", title: "Lady", born: "8 Nov 2003", role: "Niece of the King", house: "Windsor" },
    { name: "James, Duke of Edinburgh", title: "Duke of Edinburgh", born: "17 Dec 2007", role: "Nephew of the King", house: "Windsor" },
    { name: "Queen Elizabeth II", title: "Queen (deceased)", born: "21 Apr 1926", role: "Former Monarch (d. 2022)", house: "Windsor" },
    { name: "Prince Philip", title: "Duke of Edinburgh (deceased)", born: "10 Jun 1921", role: "Former Consort (d. 2021)", house: "Windsor" },
];
// =============================================================================
// MCP Server Setup
// =============================================================================
const server = new McpServer({
    name: "royal-family-mcp",
    version: "1.0.0",
});
// =============================================================================
// Tool: random_royal_name
// =============================================================================
server.registerTool("royal_family_random_name", {
    title: "Get a Random Royal Name",
    description: `Return a random member of the British Royal Family.

Use this when asked for a random royal name, a surprise royal, or just "who's a royal?".

Returns:
  Name, title, birth date, role, and royal house.

Example:
  - "Give me a random royal name" -> picks one at random`,
    inputSchema: z.object({}).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
    },
}, async () => {
    const member = ROYAL_FAMILY[Math.floor(Math.random() * ROYAL_FAMILY.length)];
    return {
        content: [{
                type: "text",
                text: formatMember(member),
            }],
    };
});
// =============================================================================
// Tool: royal_family_list
// =============================================================================
server.registerTool("royal_family_list", {
    title: "List British Royal Family Members",
    description: `Return the full list of British Royal Family members in the dataset.

Use this when asked who is in the royal family, or to see all available names.

Returns:
  All members with name, title, role, and birth date.`,
    inputSchema: z.object({}).strict(),
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async () => {
    const lines = ROYAL_FAMILY.map((m, i) => `${i + 1}. **${m.name}** — ${m.title} (born ${m.born})`).join("\n");
    return {
        content: [{
                type: "text",
                text: `## British Royal Family (${ROYAL_FAMILY.length} members)\n\n${lines}`,
            }],
    };
});
// =============================================================================
// Tool: royal_family_lookup
// =============================================================================
const LookupInputSchema = z.object({
    name: z.string()
        .min(1, "Name is required")
        .describe("Name or partial name to search for (case-insensitive)"),
}).strict();
server.registerTool("royal_family_lookup", {
    title: "Look Up a Royal Family Member",
    description: `Search for a British Royal Family member by name (partial match, case-insensitive).

Use this when the user wants details about a specific royal.

Args:
  - name (string): Full or partial name to search for

Returns:
  Matching members with full details.

Example:
  - "Tell me about William" -> { name: "William" }
  - "Look up Princess Anne" -> { name: "Anne" }`,
    inputSchema: LookupInputSchema,
    annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
    },
}, async (params) => {
    const query = params.name.toLowerCase();
    const matches = ROYAL_FAMILY.filter(m => m.name.toLowerCase().includes(query) ||
        m.title.toLowerCase().includes(query) ||
        m.role.toLowerCase().includes(query));
    if (matches.length === 0) {
        return {
            content: [{
                    type: "text",
                    text: `No royal family member found matching "${params.name}". Try a partial name like "William", "Anne", or "Charles".`,
                }],
        };
    }
    const formatted = matches.map(formatMember).join("\n\n---\n\n");
    return {
        content: [{
                type: "text",
                text: `Found ${matches.length} match${matches.length > 1 ? "es" : ""} for "${params.name}":\n\n${formatted}`,
            }],
    };
});
// =============================================================================
// Helper
// =============================================================================
function formatMember(m) {
    return [
        `**${m.name}**`,
        `Title: ${m.title}`,
        `Born: ${m.born}`,
        `Role: ${m.role}`,
        `House: ${m.house}`,
    ].join("\n");
}
// =============================================================================
// Start Server
// =============================================================================
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("royal-family-mcp running via stdio");
}
main().catch((err) => {
    logger.error("Server error", err);
    process.exit(1);
});
//# sourceMappingURL=index.js.map