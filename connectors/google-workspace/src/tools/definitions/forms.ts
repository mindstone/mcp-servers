import { ToolMetadata } from "../../modules/tools/registry.js";

/**
 * Google Forms API tool definitions.
 * Following MCP_IMPROVEMENT_WORKFLOW.md design guidelines:
 * - Flat parameters (not nested)
 * - Examples in descriptions
 * - WORKFLOW sections for multi-tool flows
 * - Human-readable output by default
 * 
 * Note: These are read-only tools. Write operations (create/update forms)
 * are deferred to a future phase.
 */
export const formsTools: ToolMetadata[] = [
  {
    name: 'list_forms',
    category: 'Forms',
    description: `List Google Forms accessible to the account.

Example: { "email": "user@example.com", "max_results": 10 }
Example with search: { "email": "user@example.com", "query": "Customer Survey" }

Uses Drive API to find forms by mimeType. Returns form IDs and titles.

WORKFLOW:
1. Call list_forms to find available forms
2. Use get_form with the form_id to see structure and questions
3. Use list_form_responses to view submissions

Returns basic info for each form (ID, name, modification time).
Use get_form to retrieve full structure and questions.`,
    aliases: ['search_forms', 'find_forms'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of forms to return (default: 20, max: 100)'
        },
        query: {
          type: 'string',
          description: 'Search query to filter forms by name'
        }
      },
      required: []
    }
  },
  {
    name: 'get_form',
    category: 'Forms',
    description: `Get the structure of a Google Form including all questions.

Example: { "email": "user@example.com", "form_id": "1FAIpQLSe..." }

Returns the form structure including:
- Form title and description
- All questions with their types, options, and settings
- Page breaks and sections
- Whether it's a quiz

WORKFLOW:
1. Use list_forms to find the form_id
2. Call this tool to see the form structure
3. Use list_form_responses to get submissions

COMMON MISTAKES:
- Don't pass the form URL - use the form ID from list_forms
- Form IDs typically start with "1FAIpQL..." but always get them from list_forms

Question types returned: multiple choice, checkbox, dropdown, short answer,
paragraph, scale, date, time, file upload, and question grids.`,
    aliases: ['get_form_structure', 'get_form_questions', 'read_form'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        form_id: {
          type: 'string',
          description: 'The Google Form ID (required)'
        }
      },
      required: ['form_id']
    }
  },
  {
    name: 'list_form_responses',
    category: 'Forms',
    description: `Get all responses submitted to a Google Form.

Examples:
1. Get responses: { "email": "user@example.com", "form_id": "1FAIpQLSe..." }
2. With limit: { "form_id": "1FAIpQLSe...", "max_results": 50 }
3. Paginate: { "form_id": "1FAIpQLSe...", "page_token": "token_from_previous" }

WORKFLOW:
1. Use list_forms to find the form_id
2. Optionally use get_form to understand the question structure
3. Call this tool to get all responses

COMMON MISTAKES:
- Don't confuse form_id with response_id - use list_forms for the form_id
- Don't pass the spreadsheet ID if responses are linked to Sheets - use the form ID

Returns each response with:
- Response ID and submission timestamp
- Respondent email (if form collects emails)
- Answers keyed by question ID
- Quiz scores (if applicable)

Note: For forms with many responses, use page_token for pagination.
Maximum 20 responses per request by default (configurable up to 5000).`,
    aliases: ['get_form_responses', 'get_form_submissions', 'list_form_submissions'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        form_id: {
          type: 'string',
          description: 'The Google Form ID (required)'
        },
        max_results: {
          type: 'number',
          description: 'Maximum responses to return (default: 20, max: 5000)'
        },
        page_token: {
          type: 'string',
          description: 'Pagination token from previous response'
        }
      },
      required: ['form_id']
    }
  },
  {
    name: 'get_form_response',
    category: 'Forms',
    description: `Get a specific response by ID from a Google Form.

Example: { "form_id": "1FAIpQLSe...", "response_id": "ACYDBNj..." }

WORKFLOW:
1. Use list_form_responses to find the response_id
2. Call this tool to get full details for one response

COMMON MISTAKES:
- Don't confuse response_id with form_id - response_ids come from list_form_responses
- Both form_id AND response_id are required

Returns the complete response including:
- Submission timestamp
- Respondent email (if collected)
- All answers with their values
- Quiz grades and feedback (if applicable)

Useful for getting details of a specific submission after finding it
in the list of responses.`,
    aliases: ['get_response', 'get_form_submission', 'get_submission'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Google account email (optional if only one account connected)'
        },
        form_id: {
          type: 'string',
          description: 'The Google Form ID (required)'
        },
        response_id: {
          type: 'string',
          description: 'The specific response ID to retrieve (required)'
        }
      },
      required: ['form_id', 'response_id']
    }
  }
];
