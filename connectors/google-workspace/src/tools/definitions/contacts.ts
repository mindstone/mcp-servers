import { ToolMetadata } from "../../modules/tools/registry.js";

// Define Contacts Tools
export const contactsTools: ToolMetadata[] = [
  {
    name: "get_workspace_contacts",
    category: "Contacts",
    description: `Retrieve contacts from a Google account.

    IMPORTANT: Before using this tool:
    1. Verify account access with list_workspace_accounts
    2. Confirm account if multiple exist
    3. Check required scopes include Contacts read access

    Parameters:
    - email: The Google account email to access contacts from
    - person_fields: Required fields to include in the response (e.g. "names,emailAddresses,phoneNumbers")
    - page_size: Optional maximum number of contacts to return
    - page_token: Optional token for pagination (to get the next page)

    Example Usage:
    1. Call list_workspace_accounts to check for valid accounts
    2. Call get_workspace_contacts with required parameters
    3. Process results and use pagination for large contact lists

    Common person_fields Values:
    - Basic info: "names,emailAddresses,phoneNumbers"
    - Extended: "names,emailAddresses,phoneNumbers,addresses,organizations"
    - All data: "names,emailAddresses,phoneNumbers,addresses,organizations,biographies,birthdays,photos"`,
    aliases: ["get_contacts", "list_contacts", "fetch_contacts"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        person_fields: {
          type: "string",
          description: 'Comma-separated fields to include in the response (e.g. "names,emailAddresses,phoneNumbers")'
        },
        page_size: {
          type: "number",
          description: "Maximum number of contacts to return (default: 100)"
        },
        page_token: {
          type: "string",
          description: "Page token from a previous response (for pagination)"
        }
      },
      required: ["person_fields"]
    }
  },
  {
    name: "search_workspace_contacts",
    category: "Contacts",
    description: `Search contacts by name, email, or organization.
    
    Use this tool to find specific contacts (e.g., "find John from Marketing").
    Uses Google's People API search with warmup request for better accuracy.
    
    Returns matching contacts with name, email, phone, and organization.
    
    Example usage:
    - Find by name: { "email": "user@example.com", "query": "John Smith" }
    - Find by company: { "email": "user@example.com", "query": "Acme Corp" }
    - Find by partial: { "email": "user@example.com", "query": "john" }`,
    aliases: ["search_contacts", "find_contacts", "lookup_contact"],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        query: {
          type: "string",
          description: "Search query (name, email, or organization)"
        },
        max_results: {
          type: "number",
          description: "Maximum results to return (default: 10, max: 30)"
        },
        return_json: {
          type: "boolean",
          description: "Return structured JSON instead of formatted text (default: false)"
        }
      },
      required: ["query"]
    }
  }
];
