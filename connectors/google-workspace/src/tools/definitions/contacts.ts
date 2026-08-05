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
  },
  {
    name: "create_workspace_contact",
    category: "Contacts",
    description: `Create a new Google Contact.

    Requires the full Contacts permission (read + write). If the connected account
    only granted read access, the tool explains how to reconnect with the write
    permission.

    Parameters:
    - email: The Google account email to create the contact in
    - given_name / family_name: Contact name (at least a name or email_address is required)
    - email_address (+ optional email_type, e.g. "work")
    - phone_number (+ optional phone_type, e.g. "mobile")
    - organization / job_title
    - notes: Free-text note stored on the contact

    Example: { "given_name": "Jane", "family_name": "Doe", "email_address": "jane@example.com", "organization": "Acme Corp" }`,
    aliases: ["create_contact", "add_contact", "new_contact"],
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        given_name: { type: "string", description: "First name" },
        family_name: { type: "string", description: "Last name" },
        email_address: { type: "string", description: "Contact email address" },
        email_type: { type: "string", description: 'Email type label (e.g. "home", "work")' },
        phone_number: { type: "string", description: "Contact phone number" },
        phone_type: { type: "string", description: 'Phone type label (e.g. "mobile", "work")' },
        organization: { type: "string", description: "Company or organization name" },
        job_title: { type: "string", description: "Job title at the organization" },
        notes: { type: "string", description: "Free-text note stored on the contact" }
      },
      required: []
    }
  },
  {
    name: "update_workspace_contact",
    category: "Contacts",
    description: `Update fields on an existing Google Contact. Only the fields you
    provide are replaced; everything else on the contact is left untouched.

    Get the resource_name from search_workspace_contacts or get_workspace_contacts
    (it looks like "people/c1234567890").

    Parameters:
    - email: The Google account email that owns the contact
    - resource_name: Required. The contact's resource name (e.g. "people/c1234567890")
    - Any of the create_workspace_contact fields to replace: given_name, family_name,
      email_address, email_type, phone_number, phone_type, organization, job_title, notes

    Example: { "resource_name": "people/c1234567890", "phone_number": "+1 555 0100", "organization": "Acme Corp" }`,
    aliases: ["update_contact", "edit_contact", "modify_contact"],
    annotations: { readOnlyHint: false },
    inputSchema: {
      type: "object",
      properties: {
        email: {
          type: "string",
          description: "Email address of the Google account"
        },
        resource_name: {
          type: "string",
          description: 'The contact resource name (e.g. "people/c1234567890")'
        },
        given_name: { type: "string", description: "First name" },
        family_name: { type: "string", description: "Last name" },
        email_address: { type: "string", description: "Contact email address" },
        email_type: { type: "string", description: 'Email type label (e.g. "home", "work")' },
        phone_number: { type: "string", description: "Contact phone number" },
        phone_type: { type: "string", description: 'Phone type label (e.g. "mobile", "work")' },
        organization: { type: "string", description: "Company or organization name" },
        job_title: { type: "string", description: "Job title at the organization" },
        notes: { type: "string", description: "Free-text note stored on the contact" }
      },
      required: ["resource_name"]
    }
  }
];
