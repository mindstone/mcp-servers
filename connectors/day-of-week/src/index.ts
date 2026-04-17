#!/usr/bin/env node
/**
 * Day of Week MCP Server
 *
 * A simple MCP server that provides a tool to determine the day of the week
 * for a given date, timezone, and locale. No external API or credentials needed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as logger from "./logger.js";

// =============================================================================
// MCP Server Setup
// =============================================================================

const server = new McpServer({
  name: "day-of-week-mcp",
  version: "1.0.0",
});

// =============================================================================
// Tool: Get Day of Week
// =============================================================================

const GetDayOfWeekInputSchema = z.object({
  date: z.string()
    .optional()
    .describe("ISO 8601 date string (e.g. '2026-04-17' or '2026-12-25T10:30:00'). Defaults to today if not provided."),
  timezone: z.string()
    .optional()
    .describe("IANA timezone identifier (e.g. 'Europe/Paris', 'America/New_York'). Defaults to 'Europe/Paris'."),
  locale: z.string()
    .optional()
    .describe("BCP 47 locale tag for the day name language (e.g. 'en-GB', 'fr-FR', 'de-DE'). Defaults to 'en-GB'."),
}).strict();

type GetDayOfWeekInput = z.infer<typeof GetDayOfWeekInputSchema>;

server.registerTool(
  "get_day_of_week",
  {
    title: "Get Day of Week",
    description: `Returns the day of the week for a given date, timezone, and locale.

Use this tool when the user asks what day of the week a date falls on, or wants to know the current day.

Args:
  - date (string, optional): ISO 8601 date string (e.g. '2026-04-17', '2026-12-25T10:30:00'). Defaults to today.
  - timezone (string, optional): IANA timezone identifier (e.g. 'Europe/Paris', 'America/New_York'). Defaults to 'Europe/Paris'.
  - locale (string, optional): BCP 47 locale tag for day name language (e.g. 'en-GB', 'fr-FR'). Defaults to 'en-GB'.

Returns:
  - day: Full day name in the specified locale (e.g. 'Friday', 'vendredi')
  - shortDay: Abbreviated day name (e.g. 'Fri', 'ven.')
  - date: ISO 8601 date string (YYYY-MM-DD)
  - timezone: The IANA timezone used
  - locale: The locale used for the day name

Examples:
  - "What day is it?" -> {}
  - "What day is Christmas 2026?" -> { date: "2026-12-25" }
  - "What day is it in New York?" -> { timezone: "America/New_York" }
  - "Quel jour sommes-nous ?" -> { locale: "fr-FR" }`,
    inputSchema: GetDayOfWeekInputSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  async (params: GetDayOfWeekInput) => {
    const timezone = params.timezone || "Europe/Paris";
    const locale = params.locale || "en-GB";

    // Validate timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone });
    } catch {
      return {
        isError: true,
        content: [{ type: "text", text: `Invalid timezone: "${timezone}". Use an IANA timezone identifier such as 'Europe/Paris', 'America/New_York', 'Asia/Tokyo'.` }],
      };
    }

    // Parse the date or default to now
    let targetDate: Date;
    if (params.date) {
      const parsed = new Date(params.date);
      if (isNaN(parsed.getTime())) {
        return {
          isError: true,
          content: [{ type: "text", text: `Invalid date: "${params.date}". Use ISO 8601 format such as '2026-04-17' or '2026-12-25T10:30:00'.` }],
        };
      }
      targetDate = parsed;
    } else {
      targetDate = new Date();
    }

    // Format the day name using Intl.DateTimeFormat
    const dayFormatter = new Intl.DateTimeFormat(locale, {
      weekday: "long",
      timeZone: timezone,
    });

    const shortDayFormatter = new Intl.DateTimeFormat(locale, {
      weekday: "short",
      timeZone: timezone,
    });

    const dateFormatter = new Intl.DateTimeFormat("sv-SE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: timezone,
    });

    const day = dayFormatter.format(targetDate);
    const shortDay = shortDayFormatter.format(targetDate);
    const dateStr = dateFormatter.format(targetDate);

    const result = {
      day,
      shortDay,
      date: dateStr,
      timezone,
      locale,
    };

    logger.info("Day of week result", result);

    return {
      content: [{
        type: "text",
        text: `**${day}** (${shortDay}) — ${dateStr} in ${timezone} (locale: ${locale})`,
      }],
    };
  }
);

// =============================================================================
// Start Server
// =============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("Day of Week MCP server running via stdio");
}

main().catch((err) => {
  logger.error("Server error", err);
  process.exit(1);
});
