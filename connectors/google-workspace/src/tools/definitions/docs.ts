import { ToolMetadata } from "../../modules/tools/registry.js";

const TAB_LINK_NOTE = 'A Docs link containing ?tab=t.xxxx points at one tab; "t.xxxx" is its tab_id.';

// Google Docs Tools
export const docsTools: ToolMetadata[] = [
  {
    name: 'read_workspace_document',
    category: 'Docs/Documents',
    description: `Read content from a Google Docs document.

    Returns human-readable text by default. Use return_json: true for the raw Google Docs API response.

    Tabs: without tab_id or all_tabs this reads the first tab only. On a document with several
    tabs the result says how many there are and which one is shown. Pass tab_id to read one tab
    (sub-tabs are separate tabs), or all_tabs: true to read every tab in order under
    "## Tab: <path> [tabId: …]" headings; all tabs share one max_chars budget, and tabs past the
    budget are listed by id so you can read them with tab_id. On tab_id / all_tabs reads, smart
    chips, people and dates appear as their text, each list item (bulleted or numbered) starts
    with "• " (indented two spaces per nesting level, so an empty list item shows as a bare "•"),
    and headings start with [H1]…[H6], [Title] or [Subtitle]. These markers are not document
    text: leave them out of anchor_text and find_text. ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple read:
       { "email": "user@example.com", "document_id": "1ABC123xyz" }
    
    2. With character limit:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "max_chars": 10000 }
    
    3. Get raw JSON structure:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "return_json": true }

    4. Read one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123" }

    5. Read every tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "all_tabs": true }
    
    Response includes:
    - Document title and URL
    - Text content (default: up to 50,000 characters)
    - Truncation indicator if content exceeds limit
    
    Note: For very large documents, consider using max_chars to limit response size.
    all_tabs cannot be combined with return_json; tab_id with return_json returns that one tab
    (up to 100,000 characters of JSON; sub-tabs listed by id).`,
    aliases: ['read_doc', 'get_document', 'view_document'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID (from URL or extract_workspace_document_id)'
        },
        max_chars: {
          type: 'number',
          description: 'Maximum characters to return (default: 50000). With all_tabs, one budget shared by all tabs.'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw Google Docs API JSON instead of formatted text (default: false)'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        },
        all_tabs: {
          type: 'boolean',
          description: 'Read every tab, in tree order (default: false). Not with tab_id or return_json.'
        }
      },
      required: ['document_id']
    }
  },
  {
    name: 'create_workspace_document',
    category: 'Docs/Documents',
    description: `Create a new Google Docs document.

    Usage examples:
    
    1. Create empty document:
       { "email": "user@example.com", "title": "Meeting Notes" }
    
    2. Create with initial content:
       { "email": "user@example.com", "title": "Project Plan", "content": "# Overview\\n\\nThis document outlines..." }
    
    Returns the new document's ID and URL.`,
    aliases: ['create_doc', 'new_document', 'make_document'],
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
          description: 'Title for the new document'
        },
        content: {
          type: 'string',
          description: 'Optional initial content for the document'
        }
      },
      required: ['title']
    }
  },
  {
    name: 'append_to_workspace_document',
    category: 'Docs/Documents',
    description: `Append text to the end of a Google Docs document.

    Without tab_id this acts on the first tab. Pass tab_id to append to the end of one tab.
    ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple append:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "text": "\\n\\n## New Section\\n\\nAdditional content here." }

    2. Append to one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "text": "\\nAction items reviewed." }
    
    The text is inserted at the end of the document body (or of the tab).
    Use \\n for line breaks in the appended text.`,
    aliases: ['append_doc', 'add_to_document', 'document_append'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        text: {
          type: 'string',
          description: 'Text to append to the document'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'text']
    }
  },
  {
    name: 'replace_workspace_document',
    category: 'Docs/Documents',
    description: `Replace the entire content of a Google Docs document.

    WARNING: This completely replaces all existing content. Use with caution.

    Without tab_id this acts on the first tab. Pass tab_id to replace the content of one tab only
    (its sub-tabs are separate tabs and are not touched). ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Complete rewrite:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "content": "# New Document Content\\n\\nThis replaces everything." }

    2. Rewrite one tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "content": "Agenda\\n\\n- Updates" }
    
    For partial edits, consider using find_and_replace_workspace_document instead. To reset a tab
    from a template tab while keeping formatting, use copy_workspace_document_tab instead.`,
    aliases: ['replace_doc', 'overwrite_document', 'rewrite_document'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        content: {
          type: 'string',
          description: 'New content to replace entire document'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'content']
    }
  },
  {
    name: 'find_and_replace_workspace_document',
    category: 'Docs/Documents',
    description: `Find and replace text throughout a Google Docs document.

    Without tab_id this replaces in every tab; pass tab_id to limit it to one tab (sub-tabs are
    separate tabs and are not included). ${TAB_LINK_NOTE}

    Usage examples:
    
    1. Simple replacement:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "find_text": "old text", "replace_text": "new text" }
    
    2. Case-sensitive replacement:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "find_text": "TODO", "replace_text": "DONE", "match_case": true }

    3. Replace a date placeholder in one tab only:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "find_text": "{{date}}", "replace_text": "2031-10-13" }
       Without tab_id a placeholder that also sits in a Template tab is replaced there too.
    
    Returns the number of occurrences replaced.
    Note: This replaces ALL occurrences of the text in every tab it covers.`,
    aliases: ['find_replace_doc', 'search_replace_document', 'document_find_replace'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        find_text: {
          type: 'string',
          description: 'Text to find'
        },
        replace_text: {
          type: 'string',
          description: 'Text to replace with'
        },
        match_case: {
          type: 'boolean',
          description: 'Case-sensitive matching (default: false)'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        }
      },
      required: ['document_id', 'find_text', 'replace_text']
    }
  },
  {
    name: 'extract_workspace_document_id',
    category: 'Docs/Documents',
    description: `Extract a Google Docs document ID from a URL or validate an existing ID.

    This is a utility tool that helps parse various Google Docs URL formats.

    Supported formats:
    - https://docs.google.com/document/d/{id}/edit
    - https://docs.google.com/document/d/{id}/edit?...
    - https://docs.google.com/document/d/{id}
    - Just the document ID itself

    Usage examples:
    
    1. Extract from URL:
       { "input": "https://docs.google.com/document/d/1ABC123xyz/edit" }
    
    2. Validate existing ID:
       { "input": "1ABC123xyz" }
    
    Returns the extracted/validated document ID.`,
    aliases: ['parse_doc_url', 'get_doc_id', 'document_id_from_url'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        input: {
          type: 'string',
          description: 'Google Docs URL or document ID to parse'
        }
      },
      required: ['input']
    }
  },
  {
    name: 'list_workspace_document_tabs',
    category: 'Docs/Documents',
    description: `List every tab in a Google Docs document, including nested sub-tabs.

    Returns the tab tree: one line per tab, indented by nesting level and numbered by position
    (1., 1.1., 1.1.1.), with its tab id and number of sub-tabs. Use a tab id as tab_id in
    read_workspace_document, append_to_workspace_document, replace_workspace_document,
    find_and_replace_workspace_document and insert_workspace_document_text, and to rename, move
    or delete a tab (update_workspace_document_tab, delete_workspace_document_tab). The list
    numbers start at 1; the position arguments of the tab tools start at 0. ${TAB_LINK_NOTE}

    Usage examples:
    
    1. List tabs:
       { "email": "user@example.com", "document_id": "1ABC123xyz" }
    
    2. Include word count:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "include_word_count": true }

    3. As JSON (flat list in tree order with tabId, title, parentTabId, index, nestingLevel, path, childCount):
       { "email": "user@example.com", "document_id": "1ABC123xyz", "return_json": true }
    
    Returns tab information including title and optional word count. include_word_count reads
    every tab's content, so it is slower on large documents.`,
    aliases: ['list_doc_tabs', 'get_document_tabs', 'document_tabs'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        include_word_count: {
          type: 'boolean',
          description: 'Include word count for each tab (default: false)'
        },
        return_json: {
          type: 'boolean',
          description: 'Return the tab list as JSON instead of formatted text (default: false)'
        }
      },
      required: ['document_id']
    }
  },
  {
    name: 'batch_update_workspace_document',
    category: 'Docs/Documents',
    description: `Execute multiple updates to a Google Docs document in a single request.

    This is the low-level API for modifying documents. It accepts an array of request objects
    that are passed directly to the Google Docs API batchUpdate endpoint.

    Common request types include:
    - insertText: Insert text at a specific location (index-based)
    - deleteContentRange: Delete a range of content by start/end index
    - replaceAllText: Find and replace text throughout the document
    - updateTextStyle: Format text (bold, italic, underline, font, color, link, etc.)
    - updateParagraphStyle: Change paragraph alignment, spacing, indentation, heading level
    - createParagraphBullets: Add bullet or numbered list formatting to paragraphs
    - insertInlineImage: Insert an image from a URL at a specific location
    - insertTable: Insert a table with specified rows and columns
    - insertTableRow/insertTableColumn: Add rows or columns to existing tables
    - deleteTableRow/deleteTableColumn: Remove rows or columns from tables
    - mergeTableCells/unmergeTableCells: Merge or unmerge table cells
    - createNamedRange: Create a named range for bookmarking content
    - insertPageBreak: Insert a page break
    - createHeader/createFooter: Add headers or footers

    Usage examples:

    1. Insert text at the beginning of the document:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertText": { "location": { "index": 1 }, "text": "Hello World\\n" } }
         ]
       }

    2. Delete a range of content:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "deleteContentRange": { "range": { "startIndex": 5, "endIndex": 20 } } }
         ]
       }

    3. Replace all occurrences of text:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{placeholder}}", "match_case": true }, "replace_text": "Actual Value" } }
         ]
       }

    4. Bold a range of text:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "updateTextStyle": { "range": { "startIndex": 1, "endIndex": 12 }, "textStyle": { "bold": true }, "fields": "bold" } }
         ]
       }

    5. Add bullet points to paragraphs:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "createParagraphBullets": { "range": { "startIndex": 1, "endIndex": 50 }, "bulletPreset": "BULLET_DISC_CIRCLE_SQUARE" } }
         ]
       }

    6. Insert a table:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertTable": { "location": { "index": 1 }, "rows": 3, "columns": 4 } }
         ]
       }

    7. Insert an inline image:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "insertInlineImage": { "location": { "index": 1 }, "uri": "https://example.com/image.png", "objectSize": { "width": { "magnitude": 300, "unit": "PT" }, "height": { "magnitude": 200, "unit": "PT" } } } }
         ]
       }

    8. Multiple operations with revision control:
       {
         "email": "user@example.com",
         "document_id": "1ABC123xyz",
         "requests": [
           { "replaceAllText": { "containsText": { "text": "{{date}}" }, "replace_text": "2025-01-15" } },
           { "replaceAllText": { "containsText": { "text": "{{author}}" }, "replace_text": "John Doe" } }
         ],
         "write_control": { "requiredRevisionId": "abc123" }
       }

    Note: Changes are atomic - if any request fails, none are applied. Use return_json: true
    to see the full API response including detailed replies per request.

    Returns: Success message with update count, or raw API response with return_json: true.

    Reference: https://developers.google.com/docs/api/reference/rest/v1/documents/batchUpdate`,
    aliases: ['batch_update_doc', 'update_document', 'modify_document'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID or URL'
        },
        requests: {
          type: 'array',
          items: {
            type: 'object'
          },
          description: 'Array of update request objects (see Google Docs API reference for schema)'
        },
        write_control: {
          type: 'object',
          properties: {
            requiredRevisionId: {
              type: 'string',
              description: 'Revision ID for optimistic concurrency control (optional)'
            }
          },
          description: 'Optional write control settings'
        },
        return_json: {
          type: 'boolean',
          description: 'Return raw API response instead of formatted text (default: false)'
        }
      },
      required: ['document_id', 'requests']
    }
  },
  {
    name: 'add_workspace_document_tab',
    category: 'Docs/Documents',
    description: `Add a new, empty tab to a Google Docs document, at the top level or as a sub-tab.

    Tab titles must be unique across the whole document, including sub-tabs; a title that is
    already used is refused before anything changes. Without position the tab goes last among
    its siblings. Returns the new tab's id and where it ended up. ${TAB_LINK_NOTE}

    position is 0-based among the new tab's siblings: 0 = first; the numbers in list outputs
    start at 1.

    Usage examples:

    1. Add a top-level tab at the end:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "title": "Q4 planning" }

    2. Add a sub-tab as the first child of another tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "title": "Archive 2031-10-06", "parent_tab_id": "t.abc123", "position": 0 }`,
    aliases: ['add_doc_tab', 'create_document_tab', 'new_document_tab'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        title: {
          type: 'string',
          description: 'Title of the new tab (unique in the document, sub-tabs included)'
        },
        parent_tab_id: {
          type: 'string',
          description: 'Tab id to nest the new tab under (from list_workspace_document_tabs; "default" means the first tab). Omit for a top-level tab.'
        },
        position: {
          type: 'number',
          description: 'Where the tab goes among its siblings: 0 = first; the numbers in list outputs start at 1. Default: last.'
        }
      },
      required: ['document_id', 'title']
    }
  },
  {
    name: 'update_workspace_document_tab',
    category: 'Docs/Documents',
    description: `Rename a tab and/or move it in a Google Docs document: reorder it among its siblings,
    nest it under another tab, or move it to the top level. A moved tab takes its sub-tabs with it.

    position is where the tab should end up (0 = first) among its siblings after the move; the
    numbers in list outputs start at 1. When nesting under another tab without position, the tab
    goes last. Titles must stay unique across the document. Needs a real tab id: "default" is
    refused. The result reports the tab's actual parent and position after the change.
    ${TAB_LINK_NOTE}

    Usage examples:

    1. Rename:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "title": "Archive 2031-10-06" }

    2. Reorder (make it the first of its siblings):
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "position": 0 }

    3. Nest under another tab, as its first sub-tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "parent_tab_id": "t.def456", "position": 0 }

    4. Move a sub-tab to the top level, as the second tab:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "move_to_top_level": true, "position": 1 }`,
    aliases: ['rename_doc_tab', 'move_doc_tab', 'reorder_document_tab'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs ("default" is not accepted)'
        },
        title: {
          type: 'string',
          description: 'New title (unique in the document, sub-tabs included)'
        },
        parent_tab_id: {
          type: 'string',
          description: 'Tab id to nest this tab under ("default" is not accepted). Not with move_to_top_level.'
        },
        move_to_top_level: {
          type: 'boolean',
          description: 'Move the tab out of its parent to the top level (default: false). Not with parent_tab_id.'
        },
        position: {
          type: 'number',
          description: 'Final position among the siblings after the move: 0 = first; the numbers in list outputs start at 1.'
        }
      },
      required: ['document_id', 'tab_id']
    }
  },
  {
    name: 'delete_workspace_document_tab',
    category: 'Docs/Documents',
    description: `WARNING: Deletes the tab AND ALL ITS SUB-TABS, with their content.

    This cannot be undone through the API (the document's version history in Google Docs can
    restore it). Read the tab, or copy what you need, first. Needs a real tab id: "default" is
    refused. A tab that has sub-tabs is refused, before anything is deleted, unless you pass
    delete_sub_tabs: true; the refusal says how many sub-tabs it has. Check the id against
    list_workspace_document_tabs first: deleting a parent tab by mistake deletes everything
    under it. The result lists every sub-tab that was deleted with it. ${TAB_LINK_NOTE}

    Usage examples:

    1. Delete a tab with no sub-tabs:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.old789" }

    2. Delete a tab together with its sub-tabs:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.drafts42", "delete_sub_tabs": true }`,
    aliases: ['delete_doc_tab', 'remove_document_tab'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs ("default" is not accepted)'
        },
        delete_sub_tabs: {
          type: 'boolean',
          description: 'Also delete every sub-tab below this tab (default: false). Required when the tab has sub-tabs.'
        }
      },
      required: ['document_id', 'tab_id']
    }
  },
  {
    name: 'insert_workspace_document_text',
    category: 'Docs/Documents',
    description: `Insert plain text next to a unique piece of text in one tab, without rewriting the tab.

    anchor_text must appear exactly once in the tab and sit inside one paragraph (smart chips,
    people and dates can't be part of it); copy it exactly from a tab_id read, without the "• "
    and [H1]-style markers. position:
    - "after" (default): right after the anchor text.
    - "before": right before the anchor text.
    - "next_paragraph_start": at the start of the paragraph that follows the anchor's paragraph.
      Use this to fill the (often empty) list item under a heading. Anchor on the line directly
      above the slot you want to fill: if an instruction line sits between the heading and the
      empty bullet, anchor on the instruction line, not on the heading. Here the paragraph must
      be empty or the call is refused (expect_empty_paragraph defaults to true); pass
      expect_empty_paragraph: false to insert at the start of a non-empty paragraph.

    Newlines in text start new paragraphs that take the formatting (heading, bullet, numbering)
    of the paragraph the text lands in. The inserted text is plain: it does not pick up bold,
    links or other character styles from its neighbours, and people or date chips you include
    arrive as plain text. Line endings become \\n; control and private-use characters, which
    Google Docs can't store, are left out (the result says how many). End text with a newline
    when inserting whole lines ahead of a non-empty paragraph. expect_empty_paragraph: true
    also works with "after" and "before". Without tab_id this acts on the first tab. To change
    existing text use find_and_replace_workspace_document. ${TAB_LINK_NOTE}

    Usage examples:

    1. Fill the empty bullet under an "Out of office" heading with two lines (two bullets). The
       tab reads "[H2] Out of office", then "List anyone away next week:", then an empty "•",
       so the anchor is the instruction line directly above the bullet:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "anchor_text": "List anyone away next week:", "position": "next_paragraph_start", "text": "Jane: Oct 20-24\\nSam: Oct 27" }

    2. Insert a sentence after a phrase:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "tab_id": "t.abc123", "anchor_text": "Budget approved.", "text": " Next review in November." }`,
    aliases: ['insert_doc_text', 'insert_text_at_anchor'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        tab_id: {
          type: 'string',
          description: 'Tab id from list_workspace_document_tabs. "default" means the first tab.'
        },
        anchor_text: {
          type: 'string',
          description: 'Text that appears exactly once in the tab, inside one paragraph (one line)'
        },
        position: {
          type: 'string',
          enum: ['after', 'before', 'next_paragraph_start'],
          description: 'Where to insert relative to the anchor (default: "after")'
        },
        text: {
          type: 'string',
          description: 'Plain text to insert; \\n starts a new paragraph'
        },
        match_case: {
          type: 'boolean',
          description: 'Case-sensitive anchor matching (default: true)'
        },
        expect_empty_paragraph: {
          type: 'boolean',
          description: 'Refuse unless the paragraph the text lands in is empty (default: true for "next_paragraph_start", false otherwise)'
        }
      },
      required: ['document_id', 'anchor_text', 'text']
    }
  },
  {
    name: 'copy_workspace_document_tab',
    category: 'Docs/Documents',
    description: `Copy one tab's content, with its formatting, into another tab of the same Google Docs document.

    Copies text, heading and paragraph styles, character styles including links, bullets and
    numbering (mapped to Google Docs' preset list styles), tables (cell text, column widths, cell
    styles), page breaks and smart chips. A smart chip linking to a file you can't open becomes a
    titled link, and people and date chips become their text; the result lists both. Does NOT copy
    headers and footers, sub-tabs, images (inline or floating) or other special elements: those
    become a visible "[placeholder]" and are listed under "Not copied".

    Pass exactly one of target_tab_id or new_tab_title. new_tab_parent_id and new_tab_position only
    apply with new_tab_title.

    Which target: to archive or duplicate a tab, use new_tab_title. To reset a tab in place from a
    template (keeping its id, position and sub-tabs), use target_tab_id with overwrite_existing:
    true, which clears the tab first. Never delete a tab in order to replace it: deleting also
    deletes its sub-tabs. target_tab_id needs a real tab id ("default" is refused);
    source_tab_id and new_tab_parent_id accept "default" for the first tab.

    The copy is not atomic. The result starts with a "Verification:" line that compares text,
    heading types, paragraph formatting, bullets, list grouping and table shapes with the source;
    check that it says "passed" before deleting or resetting the source (a failed verification
    comes back as an error, with the full report). If the copy stops part-way, a new tab is
    deleted again, and an existing tab may be left cleared or partly written (the document's
    version history can restore it). If the copy completes but verification finds differences,
    the tab is kept so it can be checked, and the result is an error listing where it differs.
    Long tabs can take 10-60 seconds.
    ${TAB_LINK_NOTE}

    new_tab_position is 0-based among the new tab's siblings: 0 = first; the numbers in list
    outputs start at 1.

    Usage examples:

    1. Archive the live tab into a new first sub-tab titled with this week's date:
       { "email": "user@example.com", "document_id": "1ABC123xyz", "source_tab_id": "t.live01", "new_tab_title": "2031-10-13", "new_tab_parent_id": "t.live01", "new_tab_position": 0 }

    2. Reset the live tab from the Template tab (clears it first):
       { "email": "user@example.com", "document_id": "1ABC123xyz", "source_tab_id": "t.tmpl02", "target_tab_id": "t.live01", "overwrite_existing": true }`,
    aliases: ['copy_doc_tab', 'duplicate_document_tab', 'clone_document_tab'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the Google account'
        },
        document_id: {
          type: 'string',
          description: 'Google Docs document ID'
        },
        source_tab_id: {
          type: 'string',
          description: 'Tab to copy from (list_workspace_document_tabs). "default" means the first tab. Its sub-tabs are not copied.'
        },
        target_tab_id: {
          type: 'string',
          description: 'Existing tab to copy into; it is cleared first and needs overwrite_existing: true ("default" is not accepted). Not with new_tab_title.'
        },
        overwrite_existing: {
          type: 'boolean',
          description: 'Confirms that target_tab_id will be cleared and overwritten (required with target_tab_id).'
        },
        new_tab_title: {
          type: 'string',
          description: 'Title for a new tab to copy into (unique in the document, sub-tabs included). Not with target_tab_id.'
        },
        new_tab_parent_id: {
          type: 'string',
          description: 'With new_tab_title: tab to nest the new tab under ("default" means the first tab). Omit for a top-level tab.'
        },
        new_tab_position: {
          type: 'number',
          description: 'With new_tab_title: where the new tab goes among its siblings: 0 = first; the numbers in list outputs start at 1. Default: last.'
        }
      },
      required: ['document_id', 'source_tab_id']
    }
  }
];
