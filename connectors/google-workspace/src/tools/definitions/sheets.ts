import { ToolMetadata } from "../../modules/tools/registry.js";

// Google Sheets Tools
export const sheetsTools: ToolMetadata[] = [
  {
    name: 'read_workspace_spreadsheet',
    category: 'Sheets/Spreadsheets',
    description: `Read metadata and optionally values from a Google Sheets spreadsheet.

    Returns human-readable text by default. Use return_json: true for the raw Google Sheets API response.
    If you intend to write back to this range, call with value_view: 'shaped' first to see formulas — overwriting formulas with computed values is silently destructive.
    For large or unbounded reads, returns an anchor envelope (first 50 + last 10 rows + summary). Pass anchor_mode: 'never' for legacy first-N truncation. Use continuation_token to page through the middle.

    Usage examples:
    
    1. Get spreadsheet info (sheets list):
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz" }
    
    2. Read specific range:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1:D10" }
    
    3. With row/column limits:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1", "max_rows": 100, "max_cols": 10 }
    
    4. Get raw JSON:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "return_json": true }
    
    Response includes:
    - Spreadsheet title and URL
    - List of sheets with dimensions
    - Data values (if range specified)
    - Truncation indicator if data exceeds limits`,
    aliases: ['read_spreadsheet', 'get_spreadsheet', 'view_spreadsheet'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID (from URL or extract_workspace_spreadsheet_id)'
        },
        range: {
          type: 'string',
          description: 'Optional A1 notation range to read (e.g., "Sheet1!A1:D10"). If omitted, returns metadata only.'
        },
        max_rows: {
          type: 'number',
          description: 'Maximum rows to return (default: 1000)'
        },
        max_cols: {
          type: 'number',
          description: 'Maximum columns to return (default: 26)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw Google Sheets API JSON instead of formatted text (default: false)'
        },
        value_view: {
          type: 'string',
          enum: ['formatted', 'shaped', 'formula', 'unformatted'],
          description: `How to render cells. 'shaped' (recommended for write-back planning) surfaces formulas alongside computed values, infers headers/column types, and flags structural anomalies. 'formatted' returns display values only (legacy default). 'formula' returns formula strings. 'unformatted' returns raw values.`
        },
        anchor_mode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: `How to handle large or unbounded reads. 'auto' (default) returns an anchor envelope (first 50 + last 10 rows + summary + continuation token) when the range is unbounded or >= 1000 rows. 'always' forces the envelope regardless of size. 'never' returns the legacy first-N truncation. Note: JSON callers default to legacy shape; use 'always' to receive the envelope in JSON mode.`
        },
        continuation_token: {
          type: 'string',
          description: `Opaque token from a previous anchor envelope's continuationToken field. Returns the rows between the first and last windows of the original read. Tokens are spreadsheet-scoped and time-bounded; stale tokens (sheet changed materially) are refused.`
        }
      },
      required: ['spreadsheet_id']
    }
  },
  {
    name: 'read_workspace_spreadsheet_values',
    category: 'Sheets/Data',
    description: `Read values from a specific range in a Google Sheets spreadsheet.

    Use this for focused data extraction. For spreadsheet metadata, use read_workspace_spreadsheet.
    If you intend to write back to this range, call with value_view: 'shaped' first to see formulas — overwriting formulas with computed values is silently destructive.
    For large or unbounded reads, returns an anchor envelope (first 50 + last 10 rows + summary). Pass anchor_mode: 'never' for legacy first-N truncation. Use continuation_token to page through the middle.

    Usage examples:
    
    1. Read a range:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1:D10" }
    
    2. Read entire sheet:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1" }
    
    3. Read by columns:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A:D", "major_dimension": "COLUMNS" }
    
    A1 notation examples:
    - "Sheet1!A1:D10" - specific range
    - "Sheet1" - entire sheet
    - "A1:D10" - range in first sheet
    - "Sheet1!A:D" - columns A through D`,
    aliases: ['read_sheet_values', 'get_sheet_data', 'get_spreadsheet_values'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        range: {
          type: 'string',
          description: 'A1 notation range to read (e.g., "Sheet1!A1:D10")'
        },
        major_dimension: {
          type: 'string',
          enum: ['ROWS', 'COLUMNS'],
          description: 'How to group values - by ROWS (default) or COLUMNS'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw ValueRange JSON instead of formatted text (default: false)'
        },
        value_view: {
          type: 'string',
          enum: ['formatted', 'shaped', 'formula', 'unformatted'],
          description: `How to render cells. 'shaped' (recommended for write-back planning) surfaces formulas alongside computed values, infers headers/column types, and flags structural anomalies. 'formatted' returns display values only (legacy default). 'formula' returns formula strings. 'unformatted' returns raw values.`
        },
        anchor_mode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: `How to handle large or unbounded reads. 'auto' (default) returns an anchor envelope (first 50 + last 10 rows + summary + continuation token) when the range is unbounded or >= 1000 rows. 'always' forces the envelope regardless of size. 'never' returns the legacy first-N truncation. Note: JSON callers default to legacy shape; use 'always' to receive the envelope in JSON mode.`
        },
        continuation_token: {
          type: 'string',
          description: `Opaque token from a previous anchor envelope's continuationToken field. Returns the rows between the first and last windows of the original read. Tokens are spreadsheet-scoped and time-bounded; stale tokens (sheet changed materially) are refused.`
        }
      },
      required: ['spreadsheet_id', 'range']
    }
  },
  {
    name: 'create_workspace_spreadsheet',
    category: 'Sheets/Spreadsheets',
    description: `Create a new Google Sheets spreadsheet.

    Usage examples:
    
    1. Create empty spreadsheet:
       { "email": "user@example.com", "title": "Q1 Budget" }
    
    2. Create with named sheets:
       { "email": "user@example.com", "title": "Project Tracker", "sheetTitles": ["Tasks", "Timeline", "Resources"] }
    
    Returns the new spreadsheet's ID and URL.`,
    aliases: ['create_spreadsheet', 'new_spreadsheet', 'make_spreadsheet'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        title: {
          type: 'string',
          description: 'Title for the new spreadsheet'
        },
        sheetTitles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional names for initial sheets (otherwise creates one "Sheet1")'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'append_to_workspace_spreadsheet',
    category: 'Sheets/Data',
    description: `Append rows of data to a Google Sheets spreadsheet.

    Data is added after the last row containing data in the specified range.
    Values are interpreted by Google Sheets (formulas, dates, etc.) by default.
    If the target column ends with a fill-down formula, this tool warns that the append breaks the pattern. Use overwrite_formulas: true to acknowledge and suppress the warning.

    Usage examples:
    
    1. Append single row:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A:D", "values": [["John", "Doe", "john@example.com", "2024-01-15"]] }
    
    2. Append multiple rows:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1", "values": [["Name", "Score"], ["Alice", 95], ["Bob", 87]] }
    
    3. Append raw values (no formula interpretation):
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A:B", "values": [["=SUM(A1:A10)"]], "value_input_option": "RAW" }
    
    value_input_option:
    - USER_ENTERED (default): Values parsed as if typed by user (formulas work)
    - RAW: Values stored exactly as provided (formulas stored as text)`,
    aliases: ['append_spreadsheet', 'add_rows', 'append_sheet_data'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        range: {
          type: 'string',
          description: 'A1 notation range for where to append (e.g., "Sheet1!A:D" or "Sheet1")'
        },
        values: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' }
              ]
            }
          },
          description: '2D array of values to append (rows of cells)'
        },
        value_input_option: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How to interpret values: RAW (literal) or USER_ENTERED (parse formulas/dates, default)'
        },
        overwrite_formulas: {
          type: 'boolean',
          description: "If false (default), this tool performs a best-effort formula-safety pre-read and warns when append data appears to break fill-down formula patterns. Set to true to skip the formula-safety pre-read and authorize appending without that warning pre-check."
        }
      },
      required: ['spreadsheet_id', 'range', 'values']
    }
  },
  {
    name: 'update_workspace_spreadsheet_values',
    category: 'Sheets/Data',
    description: `Update values in a specific range of a Google Sheets spreadsheet.

    Overwrites existing data in the specified range. Use append_to_workspace_spreadsheet to add data without overwriting.
    Prefer formulas over computed values. By default this tool refuses to overwrite cells that currently contain formulas; pass overwrite_formulas: true to force, or write to non-formula cells. Best-effort: protects against formula overwrite absent concurrent edits to the same range during the call. Sheets has no transactional write API; under concurrent edits the guard cannot guarantee zero overwrites. value_input_option defaults to USER_ENTERED so '=SUM(...)' is parsed as a formula; use RAW only when literally storing '=' as text.

    Usage examples:
    
    1. Update specific cells:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1:B2", "values": [["Name", "Score"], ["Alice", 100]] }
    
    2. Update single cell:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1", "values": [["Updated Value"]] }
    
    3. Update with raw values:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1", "values": [["=SUM(B1:B10)"]], "value_input_option": "RAW" }`,
    aliases: ['update_spreadsheet', 'update_sheet_values', 'write_spreadsheet'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        range: {
          type: 'string',
          description: 'A1 notation range to update (e.g., "Sheet1!A1:D10")'
        },
        values: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' }
              ]
            }
          },
          description: '2D array of values to write (rows of cells)'
        },
        value_input_option: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How to interpret values: RAW (literal) or USER_ENTERED (parse formulas/dates, default)'
        },
        overwrite_formulas: {
          type: 'boolean',
          description: "If false (default), this tool refuses to overwrite cells that currently contain formulas. Best-effort: protects against formula overwrite absent concurrent edits during the call. Set to true to skip the formula-safety pre-read and authorize overwriting unconditionally."
        }
      },
      required: ['spreadsheet_id', 'range', 'values']
    }
  },
  {
    name: 'clear_workspace_spreadsheet_values',
    category: 'Sheets/Data',
    description: `Clear values from a range in a Google Sheets spreadsheet.

    Removes cell contents (formulas and values); preserves formatting. Destructive — consider creating a backup via Drive copy_file before clearing important data. Does NOT refuse to clear formulas.
    For complete cell removal, use the Sheets UI.

    Usage examples:
    
    1. Clear a range:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1!A1:D10" }
    
    2. Clear entire sheet:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "range": "Sheet1" }`,
    aliases: ['clear_spreadsheet', 'clear_sheet_values', 'erase_spreadsheet'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        range: {
          type: 'string',
          description: 'A1 notation range to clear (e.g., "Sheet1!A1:D10")'
        }
      },
      required: ['spreadsheet_id', 'range']
    }
  },
  {
    name: 'list_workspace_spreadsheet_sheets',
    category: 'Sheets/Spreadsheets',
    description: `List all sheets (tabs) in a Google Sheets spreadsheet.

    Returns sheet names, IDs, and dimensions.

    Usage example:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz" }
    
    Use the returned sheetId (numeric) when calling delete_workspace_spreadsheet_sheet with the snake_case parameter sheet_id.`,
    aliases: ['list_sheets', 'get_sheets', 'show_sheets'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        }
      },
      required: ['spreadsheet_id']
    }
  },
  {
    name: 'add_workspace_spreadsheet_sheet',
    category: 'Sheets/Spreadsheets',
    description: `Add a new sheet (tab) to an existing Google Sheets spreadsheet.

    Usage examples:
    
    1. Add sheet with default size:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "title": "Q2 Data" }
    
    2. Add sheet with custom dimensions:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "title": "Large Dataset", "row_count": 5000, "column_count": 52 }`,
    aliases: ['add_sheet', 'create_sheet', 'new_sheet'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        title: {
          type: 'string',
          description: 'Name for the new sheet'
        },
        row_count: {
          type: 'number',
          description: 'Initial row count (default: 1000)'
        },
        column_count: {
          type: 'number',
          description: 'Initial column count (default: 26)'
        }
      },
      required: ['spreadsheet_id', 'title']
    }
  },
  {
    name: 'delete_workspace_spreadsheet_sheet',
    category: 'Sheets/Spreadsheets',
    description: `Delete a sheet (tab) from a Google Sheets spreadsheet.

    WARNING: This permanently deletes the sheet and all its data. Destructive — cannot be undone via API. Read the sheet's contents (read_workspace_spreadsheet_values) before deletion if uncertain.

    Usage example:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "sheet_id": 123456789 }
    
    Get the numeric sheetId from list_workspace_spreadsheet_sheets and pass it as sheet_id.
    Note: Cannot delete the last remaining sheet in a spreadsheet.`,
    aliases: ['delete_sheet', 'remove_sheet'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        sheet_id: {
          type: 'number',
          description: 'Numeric sheet ID (from list_workspace_spreadsheet_sheets, NOT the sheet name)'
        }
      },
      required: ['spreadsheet_id', 'sheet_id']
    }
  },
  {
    name: 'extract_workspace_spreadsheet_id',
    category: 'Sheets/Utility',
    description: `Extract a Google Sheets spreadsheet ID from a URL or validate an existing ID.

    This is a utility tool that helps parse various Google Sheets URL formats.

    Supported formats:
    - https://docs.google.com/spreadsheets/d/{id}/edit
    - https://docs.google.com/spreadsheets/d/{id}/edit#gid=0
    - https://docs.google.com/spreadsheets/d/{id}
    - Just the spreadsheet ID itself

    Usage examples:
    
    1. Extract from URL:
       { "input": "https://docs.google.com/spreadsheets/d/1ABC123xyz/edit#gid=0" }
    
    2. Validate existing ID:
       { "input": "1ABC123xyz" }
    
    Returns the extracted/validated spreadsheet ID.`,
    aliases: ['parse_spreadsheet_url', 'get_spreadsheet_id', 'spreadsheet_id_from_url'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Google Sheets URL or spreadsheet ID to parse'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'batch_read_workspace_spreadsheet_values',
    category: 'Sheets/Data',
    description: `Read values from multiple ranges in a single API call.

    More efficient than multiple read_workspace_spreadsheet_values calls - uses 1 API request instead of N.
    Ideal for reading from multiple sheets or non-contiguous ranges.
    If you intend to write back to these ranges, call with value_view: 'shaped' first to see formulas — overwriting formulas with computed values is silently destructive.
    For large or unbounded reads, returns an anchor envelope (first 50 + last 10 rows + summary). Pass anchor_mode: 'never' for legacy first-N truncation. Use continuation_token to page through the middle.

    Usage examples:
    
    1. Read from multiple sheets:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "ranges": ["Sheet1!A1:D10", "Sheet2!A1:B5"] }
    
    2. Read multiple ranges from same sheet:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "ranges": ["Sheet1!A1:C10", "Sheet1!E1:E10", "Sheet1!G1:H10"] }
    
    3. Read by columns:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "ranges": ["Sheet1!A:A", "Sheet1!D:D"], "major_dimension": "COLUMNS" }
    
    Returns data for each range in the same order as requested.
    
    Performance: Reduces API quota usage significantly for multi-range operations.`,
    aliases: ['batch_read_spreadsheet', 'multi_range_read', 'batch_get_values'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        ranges: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of A1 notation ranges to read (e.g., ["Sheet1!A1:D10", "Sheet2!A1:B5"])'
        },
        major_dimension: {
          type: 'string',
          enum: ['ROWS', 'COLUMNS'],
          description: 'How to group values - by ROWS (default) or COLUMNS'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw JSON instead of formatted text (default: false)'
        },
        value_view: {
          type: 'string',
          enum: ['formatted', 'shaped', 'formula', 'unformatted'],
          description: `How to render cells. 'shaped' (recommended for write-back planning) surfaces formulas alongside computed values, infers headers/column types, and flags structural anomalies. 'formatted' returns display values only (legacy default). 'formula' returns formula strings. 'unformatted' returns raw values.`
        },
        anchor_mode: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          description: `How to handle large or unbounded reads. 'auto' (default) returns an anchor envelope (first 50 + last 10 rows + summary + continuation token) when the range is unbounded or >= 1000 rows. 'always' forces the envelope regardless of size. 'never' returns the legacy first-N truncation. Note: JSON callers default to legacy shape; use 'always' to receive the envelope in JSON mode.`
        },
        continuation_token: {
          type: 'string',
          description: `Opaque token from a previous anchor envelope's continuationToken field. Returns the rows between the first and last windows of the original read. Tokens are spreadsheet-scoped and time-bounded; stale tokens (sheet changed materially) are refused. Batch continuation is not supported in Phase 1.`
        }
      },
      required: ['spreadsheet_id', 'ranges']
    }
  },
  {
    name: 'batch_update_workspace_spreadsheet_values',
    category: 'Sheets/Data',
    description: `Update values in multiple ranges in a single API call.

    More efficient than multiple update_workspace_spreadsheet_values calls - uses 1 API request instead of N.
    Ideal for writing to multiple sheets or non-contiguous ranges atomically.
    Prefer formulas over computed values. By default this tool refuses to overwrite cells that currently contain formulas; pass overwrite_formulas: true to force, or write to non-formula cells. Best-effort: protects against formula overwrite absent concurrent edits to the same range during the call. Sheets has no transactional write API; under concurrent edits the guard cannot guarantee zero overwrites. value_input_option defaults to USER_ENTERED so '=SUM(...)' is parsed as a formula; use RAW only when literally storing '=' as text.

    Usage examples:
    
    1. Update multiple sheets:
       { 
         "email": "user@example.com", 
         "spreadsheet_id": "1ABC123xyz", 
         "data": [
           { "range": "Sheet1!A1:B2", "values": [["Name", "Score"], ["Alice", 95]] },
           { "range": "Sheet2!A1:B1", "values": [["Summary", "Total"]] }
         ]
       }
    
    2. Update scattered ranges:
       { 
         "email": "user@example.com", 
         "spreadsheet_id": "1ABC123xyz", 
         "data": [
           { "range": "Sheet1!A1", "values": [["Updated Header"]] },
           { "range": "Sheet1!D5", "values": [[100]] },
           { "range": "Sheet1!F10:G11", "values": [["X", "Y"], [1, 2]] }
         ]
       }
    
    Performance: Reduces API quota usage significantly. All updates are applied atomically.`,
    aliases: ['batch_update_spreadsheet', 'multi_range_update', 'batch_write_values'],
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        data: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              range: {
                type: 'string',
                description: 'A1 notation range (e.g., "Sheet1!A1:B2")'
              },
              values: {
                type: 'array',
                items: {
                  type: 'array',
                  items: {
                    oneOf: [
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' }
                    ]
                  }
                },
                description: '2D array of values for this range'
              }
            },
            required: ['range', 'values']
          },
          description: 'Array of {range, values} objects to update'
        },
        value_input_option: {
          type: 'string',
          enum: ['RAW', 'USER_ENTERED'],
          description: 'How to interpret values: RAW (literal) or USER_ENTERED (parse formulas/dates, default)'
        },
        overwrite_formulas: {
          type: 'boolean',
          description: "If false (default), this tool refuses to overwrite cells that currently contain formulas. Best-effort: protects against formula overwrite absent concurrent edits during the call. Set to true to skip the formula-safety pre-read and authorize overwriting unconditionally."
        }
      },
      required: ['spreadsheet_id', 'data']
    }
  },
  {
    name: 'find_and_replace_workspace_spreadsheet',
    category: 'Sheets/Data',
    description: `Find and replace text throughout a Google Sheets spreadsheet.

    Can search entire spreadsheet or limit to a specific sheet.
    Supports regex, case-sensitive matching, and formula search.
    WARNING: include_formulas: true will rewrite formula text, not just values. Use sparingly and never with regex unless you've verified the pattern won't match formula syntax (=, ., etc.).

    Usage examples:
    
    1. Simple find/replace in all sheets:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "find": "old text", "replacement": "new text" }
    
    2. Replace in specific sheet only:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "find": "TODO", "replacement": "DONE", "sheet_id": 0 }
    
    3. Case-sensitive with regex:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "find": "^[A-Z]+$", "replacement": "UPPERCASE", "match_case": true, "search_by_regex": true }
    
    4. Match entire cell only:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "find": "Yes", "replacement": "No", "match_entire_cell": true }
    
    Returns count of occurrences changed.
    Note: Get the numeric sheetId from list_workspace_spreadsheet_sheets and pass it as sheet_id (numeric ID, not name).`,
    aliases: ['find_replace_spreadsheet', 'search_replace_sheet', 'spreadsheet_find_replace'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        find: {
          type: 'string',
          description: 'Text to find (or regex pattern if search_by_regex is true)'
        },
        replacement: {
          type: 'string',
          description: 'Text to replace with'
        },
        sheet_id: {
          type: 'number',
          description: 'Numeric sheet ID to limit search (omit for all sheets)'
        },
        match_case: {
          type: 'boolean',
          description: 'Case-sensitive matching (default: false)'
        },
        match_entire_cell: {
          type: 'boolean',
          description: 'Only match if entire cell equals find text (default: false)'
        },
        search_by_regex: {
          type: 'boolean',
          description: 'Treat find as regex pattern (default: false)'
        },
        include_formulas: {
          type: 'boolean',
          description: 'Search within formula text, not just values (default: false)'
        }
      },
      required: ['spreadsheet_id', 'find', 'replacement']
    }
  },
  {
    name: 'format_workspace_spreadsheet_cells',
    category: 'Sheets/Formatting',
    description: `Apply formatting to a range of cells in a Google Sheets spreadsheet.

    Supports text formatting (bold, italic, etc.), colors, and borders.
    Uses 0-based row/column indices with exclusive end indices.

    Usage examples:
    
    1. Make header row bold:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "sheet_id": 0, "start_row_index": 0, "end_row_index": 1, "start_column_index": 0, "end_column_index": 5, "bold": true }
    
    2. Highlight cells with background color:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "sheet_id": 0, "start_row_index": 0, "end_row_index": 10, "start_column_index": 0, "end_column_index": 3, "background_color": { "red": 1, "green": 0.95, "blue": 0.8 } }
    
    3. Add borders and text color:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "sheet_id": 0, "start_row_index": 0, "end_row_index": 5, "start_column_index": 0, "end_column_index": 4, "border_style": "SOLID", "text_color": { "red": 0, "green": 0, "blue": 0.5 } }
    
    4. Multiple formatting options:
       { "email": "user@example.com", "spreadsheet_id": "1ABC123xyz", "sheet_id": 0, "start_row_index": 0, "end_row_index": 1, "start_column_index": 0, "end_column_index": 10, "bold": true, "font_size": 14, "background_color": { "red": 0.2, "green": 0.2, "blue": 0.4 }, "text_color": { "red": 1, "green": 1, "blue": 1 } }
    
    Index conversion from A1 notation:
    - Row 1 = start_row_index: 0, end_row_index: 1
    - Column A = start_column_index: 0, end_column_index: 1
    - Range A1:D10 = start_row_index: 0, end_row_index: 10, start_column_index: 0, end_column_index: 4
    
    Color values are floats 0.0 to 1.0 (e.g., { "red": 1, "green": 0, "blue": 0 } = pure red).
    Border styles: NONE, DOTTED, DASHED, SOLID, SOLID_MEDIUM, SOLID_THICK, DOUBLE`,
    aliases: ['format_cells', 'style_spreadsheet', 'format_sheet_range'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        spreadsheet_id: {
          type: 'string',
          description: 'Google Sheets spreadsheet ID'
        },
        sheet_id: {
          type: 'number',
          description: 'Numeric sheet ID (from list_workspace_spreadsheet_sheets)'
        },
        start_row_index: {
          type: 'number',
          description: 'Starting row index (0-based, inclusive)'
        },
        end_row_index: {
          type: 'number',
          description: 'Ending row index (0-based, exclusive)'
        },
        start_column_index: {
          type: 'number',
          description: 'Starting column index (0-based, inclusive)'
        },
        end_column_index: {
          type: 'number',
          description: 'Ending column index (0-based, exclusive)'
        },
        bold: {
          type: 'boolean',
          description: 'Apply bold formatting'
        },
        italic: {
          type: 'boolean',
          description: 'Apply italic formatting'
        },
        underline: {
          type: 'boolean',
          description: 'Apply underline formatting'
        },
        strikethrough: {
          type: 'boolean',
          description: 'Apply strikethrough formatting'
        },
        font_size: {
          type: 'number',
          description: 'Font size in points'
        },
        text_color: {
          type: 'object',
          properties: {
            red: { type: 'number', description: '0.0 to 1.0' },
            green: { type: 'number', description: '0.0 to 1.0' },
            blue: { type: 'number', description: '0.0 to 1.0' }
          },
          description: 'Text color (RGB values 0.0-1.0)'
        },
        background_color: {
          type: 'object',
          properties: {
            red: { type: 'number', description: '0.0 to 1.0' },
            green: { type: 'number', description: '0.0 to 1.0' },
            blue: { type: 'number', description: '0.0 to 1.0' }
          },
          description: 'Background color (RGB values 0.0-1.0)'
        },
        border_style: {
          type: 'string',
          enum: ['NONE', 'DOTTED', 'DASHED', 'SOLID', 'SOLID_MEDIUM', 'SOLID_THICK', 'DOUBLE'],
          description: 'Border style to apply to all edges and inner lines'
        },
        border_color: {
          type: 'object',
          properties: {
            red: { type: 'number', description: '0.0 to 1.0' },
            green: { type: 'number', description: '0.0 to 1.0' },
            blue: { type: 'number', description: '0.0 to 1.0' }
          },
          description: 'Border color (RGB values 0.0-1.0, default: black)'
        }
      },
      required: ['spreadsheet_id', 'sheet_id', 'start_row_index', 'end_row_index', 'start_column_index', 'end_column_index']
    }
  }
];
