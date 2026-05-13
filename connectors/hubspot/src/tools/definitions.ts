import { MAX_FAN_OUT, MAX_STRING_BODY_LENGTH } from './input-limits.js';

export interface ToolMetadata {
  name: string;
  category: string;
  description: string;
  aliases?: string[];
  requiresAuth?: boolean;
  annotations?: {
    readOnlyHint?: boolean;  // true = read-only tool, false/undefined = write tool
    destructiveHint?: boolean;  // true = may delete/archive data
    idempotentHint?: boolean;  // true = calling multiple times with same input has same effect
    openWorldHint?: boolean;  // true = interacts with entities outside the user's control
  };
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// Account Management Tools
export const accountTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_accounts',
    category: 'Account Management',
    description: `List all connected HubSpot accounts and their authentication status.

ALWAYS call this FIRST before any HubSpot CRM operations to:
1. Check if any HubSpot accounts are connected
2. Verify authentication status (valid, expired, needs re-auth)
3. Get the email address to use for subsequent operations

If no accounts are connected, guide the user to connect one using authenticate_hubspot_account.

Example workflow:
1. User: "Show me my HubSpot contacts"
2. Agent: Call list_hubspot_accounts first
3. If accounts exist and valid → proceed with search_hubspot_contacts
4. If no accounts → tell user to connect: "You need to connect your HubSpot account first. Would you like me to start the authentication?"
5. If auth expired → call authenticate_hubspot_account to refresh`,
    aliases: ['get_hubspot_accounts', 'show_hubspot_accounts', 'hubspot_accounts'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'authenticate_hubspot_account',
    category: 'Account Management',
    description: `Connect a new HubSpot account or re-authenticate an existing one.

This tool initiates the OAuth flow to connect a HubSpot account:
1. Returns an authorization URL that the user must click
2. User signs into HubSpot and grants permissions
3. Authentication completes automatically via callback

WHEN TO USE:
- When list_hubspot_accounts shows no connected accounts
- When an account shows status "expired" or "error"
- When user explicitly asks to connect/reconnect HubSpot

WHEN NOT TO USE:
- If list_hubspot_accounts shows a valid, active account
- Without checking list_hubspot_accounts first (wastes user time)

After calling this tool:
1. Present the auth_url to the user as a clickable link
2. Tell them to click it and authorize in their browser
3. Call complete_hubspot_auth to wait for completion
4. Or if auto_complete is enabled, it will complete automatically`,
    aliases: ['connect_hubspot', 'add_hubspot_account', 'hubspot_login', 'hubspot_auth'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Optional: Email hint for the account being connected (for display purposes)'
        }
      }
    }
  },
  {
    name: 'complete_hubspot_auth',
    category: 'Account Management',
    description: `Wait for HubSpot OAuth authorization to complete.

Call this AFTER authenticate_hubspot_account has returned an auth_url and the user has clicked it.

This tool:
1. Waits for the OAuth callback (up to 2 minutes)
2. Exchanges the authorization code for access tokens
3. Saves the account credentials
4. Returns success with the connected email

IMPORTANT: Only call this if auto_complete was false in authenticate_hubspot_account response.
If auto_complete was true, authentication completes automatically and you don't need this tool.`,
    aliases: ['wait_for_hubspot_auth', 'finish_hubspot_auth'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the account being authenticated'
        }
      }
    }
  },
  {
    name: 'remove_hubspot_account',
    category: 'Account Management',
    description: `Disconnect a HubSpot account and delete its stored credentials.

Use this when:
- User wants to disconnect their HubSpot account
- User wants to switch to a different HubSpot account
- Troubleshooting authentication issues (remove and re-add)

This permanently removes the account's access tokens. The user will need to re-authenticate to use HubSpot again.`,
    aliases: ['disconnect_hubspot', 'delete_hubspot_account', 'hubspot_logout'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        email: {
          type: 'string',
          description: 'Email address of the HubSpot account to remove'
        }
      },
      required: ['email']
    }
  }
];

// Contact Tools
export const contactTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_contacts',
    category: 'Contacts',
    description: `Search for contacts in HubSpot CRM.

USE THIS WHEN:
- User asks "find contact [name/email]" or "look up [person]"
- Need to find a contact before updating, associating, or viewing details
- Preparing for a meeting and need contact info

RETURNS: Array of contacts with id, properties (email, firstname, lastname, etc.)

EXAMPLES:
1. Find by email: filters=[{propertyName:"email", operator:"EQ", value:"john@acme.com"}]
2. Find by name: query="John Smith"
3. Find by company: filters=[{propertyName:"company", operator:"CONTAINS_TOKEN", value:"Acme"}]

OPERATORS: EQ, NEQ, LT, LTE, GT, GTE, CONTAINS_TOKEN (partial match), IN (list)

COMMON PROPERTIES to request: email, firstname, lastname, phone, company, jobtitle, lifecyclestage, hubspot_owner_id`,
    aliases: ['find_contacts', 'query_contacts'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search across name/email' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'IN'] },
              value: { type: 'string' }
            }
          },
          description: 'Filter criteria for precise matching'
        },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return (default: basic info)' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_contact',
    category: 'Contacts',
    description: `Get full details for a single contact by ID.

USE THIS WHEN:
- You already have a contact ID (from search or association)
- Need complete contact information
- Preparing a detailed contact profile

RETURNS: Single contact object with all requested properties

PREREQUISITE: Get contactId from search_hubspot_contacts first`,
    aliases: ['view_contact', 'read_contact'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HubSpot contact ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['contactId']
    }
  },
  {
    name: 'create_hubspot_contact',
    category: 'Contacts',
    description: `Create a new contact in HubSpot CRM.

USE THIS WHEN:
- User says "add contact" or "create contact for [person]"
- Logging a new lead or prospect
- Contact doesn't exist (verify with search first!)

REQUIRED: email (strongly recommended - used for deduplication)

NOTE: The server automatically sets hs_object_source_detail_2 for source attribution.

COMMON PROPERTIES:
- email, firstname, lastname
- phone, mobilephone
- company, jobtitle
- address, city, state, zip, country
- lifecyclestage: "lead", "marketingqualifiedlead", "salesqualifiedlead", "opportunity", "customer"
- hubspot_owner_id: assign to a team member (RECOMMENDED — get IDs from list_hubspot_owners)

COMMON MISTAKES:
- NOT specifying hubspot_owner_id — if omitted, the contact may be assigned to the HubSpot integration account used by your host, not the intended owner. Use list_hubspot_owners to find the correct owner ID.
- If list_hubspot_owners returns empty (e.g., free accounts), you may proceed without hubspot_owner_id.

RETURNS: Created contact with id and properties`,
    aliases: ['add_contact', 'new_contact'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          description: 'Contact properties object',
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        }
      },
      required: ['properties']
    }
  },
  {
    name: 'update_hubspot_contact',
    category: 'Contacts',
    description: `Update an existing contact's properties.

USE THIS WHEN:
- User says "update contact" or "change [field] for [contact]"
- Need to correct or add information
- Changing lifecycle stage or owner assignment

PREREQUISITE: Get contactId from search_hubspot_contacts first

RETURNS: Updated contact object`,
    aliases: ['edit_contact', 'modify_contact'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HubSpot contact ID' },
        properties: {
          type: 'object',
          description: 'Properties to update (only include changed fields)',
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        }
      },
      required: ['contactId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_contact',
    category: 'Contacts',
    description: `Permanently delete a contact from HubSpot.

USE THIS WHEN:
- User explicitly asks to delete/remove a contact
- Cleaning up duplicate or test records

WARNING: This is permanent. Associated engagements may be orphaned.

PREREQUISITE: Get contactId from search_hubspot_contacts first`,
    aliases: ['remove_contact'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HubSpot contact ID' }
      },
      required: ['contactId']
    }
  }
];

// Company Tools
export const companyTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_companies',
    category: 'Companies',
    description: `Search for companies/organizations in HubSpot CRM.

USE THIS WHEN:
- User asks "find company [name]" or "look up [organization]"
- Need company info for account research
- Finding companies to associate with contacts or deals

RETURNS: Array of companies with id, properties (name, domain, industry, etc.)

EXAMPLES:
1. Find by name: query="Acme Corp"
2. Find by domain: filters=[{propertyName:"domain", operator:"EQ", value:"acme.com"}]
3. Find by industry: filters=[{propertyName:"industry", operator:"EQ", value:"COMPUTER_SOFTWARE"}]

COMMON PROPERTIES to request: name, domain, industry, numberofemployees, annualrevenue, phone, city, country, hubspot_owner_id`,
    aliases: ['find_companies', 'query_companies'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search by company name' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_company',
    category: 'Companies',
    description: `Get full details for a single company by ID.

USE THIS WHEN:
- You have a company ID (from search or association)
- Need complete company profile for account research

PREREQUISITE: Get companyId from search_hubspot_companies or get_hubspot_associations`,
    aliases: ['view_company', 'read_company'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'HubSpot company ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['companyId']
    }
  },
  {
    name: 'create_hubspot_company',
    category: 'Companies',
    description: `Create a new company in HubSpot CRM.

USE THIS WHEN:
- User says "add company" or "create account for [organization]"
- Company doesn't exist (verify with search first!)

REQUIRED: name

COMMON PROPERTIES:
- name (company name)
- domain (website domain, used for deduplication)
- industry (e.g., "COMPUTER_SOFTWARE", "FINANCIAL_SERVICES")
- numberofemployees, annualrevenue
- phone, address, city, state, zip, country
- hubspot_owner_id: assign to team member (RECOMMENDED — get IDs from list_hubspot_owners)

COMMON MISTAKES:
- NOT specifying hubspot_owner_id — if omitted, the company may be assigned to the HubSpot integration account used by your host, not the intended owner. Use list_hubspot_owners to find the correct owner ID.
- If list_hubspot_owners returns empty (e.g., free accounts), you may proceed without hubspot_owner_id.

RETURNS: Created company with id and properties`,
    aliases: ['add_company', 'new_company'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          description: 'Company properties object',
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        }
      },
      required: ['properties']
    }
  },
  {
    name: 'update_hubspot_company',
    category: 'Companies',
    description: `Update an existing company's properties.

USE THIS WHEN:
- User says "update company" or "change [field] for [company]"
- Need to correct or add company information

PREREQUISITE: Get companyId from search_hubspot_companies first`,
    aliases: ['edit_company', 'modify_company'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'HubSpot company ID' },
        properties: { type: 'object', description: 'Properties to update', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['companyId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_company',
    category: 'Companies',
    description: `Permanently delete a company from HubSpot.

WARNING: This is permanent and may affect associated contacts and deals.

PREREQUISITE: Get companyId from search_hubspot_companies first`,
    aliases: ['remove_company'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'HubSpot company ID' }
      },
      required: ['companyId']
    }
  }
];

// Deal Tools
export const dealTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_deals',
    category: 'Deals',
    description: `Search for deals/opportunities in HubSpot CRM.

USE THIS WHEN:
- User asks "find deal [name]" or "show my deals"
- Need to check pipeline status
- Looking for deals by stage, amount, or owner

RETURNS: Array of deals with id, properties (dealname, amount, dealstage, etc.)

EXAMPLES:
1. Find by name: query="Acme Enterprise"
2. Find by stage: filters=[{propertyName:"dealstage", operator:"EQ", value:"qualifiedtobuy"}]
3. Find deals > $10k: filters=[{propertyName:"amount", operator:"GT", value:"10000"}]
4. Find by owner: filters=[{propertyName:"hubspot_owner_id", operator:"EQ", value:"12345"}]

NOTE: dealstage values are IDs, not names. Use list_hubspot_pipelines to get valid stage IDs.

COMMON PROPERTIES: dealname, amount, dealstage, pipeline, closedate, hubspot_owner_id, hs_deal_stage_probability`,
    aliases: ['find_deals', 'query_deals'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search by deal name' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_deal',
    category: 'Deals',
    description: `Get full details for a single deal by ID.

USE THIS WHEN:
- You have a deal ID (from search or association)
- Need complete deal information including custom properties

PREREQUISITE: Get dealId from search_hubspot_deals or get_hubspot_associations`,
    aliases: ['view_deal', 'read_deal'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        dealId: { type: 'string', description: 'HubSpot deal ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['dealId']
    }
  },
  {
    name: 'create_hubspot_deal',
    category: 'Deals',
    description: `Create a new deal/opportunity in HubSpot CRM.

USE THIS WHEN:
- User says "create deal" or "add opportunity"
- Logging a new sales opportunity

REQUIRED: dealname, hubspot_owner_id

IMPORTANT: Use list_hubspot_pipelines first to get valid pipeline and dealstage IDs!

FALLBACK FIELDS (set by the server only if not provided):
- hubspot_owner_id: FALLBACK ONLY — if not provided via the top-level parameter, falls back to the HubSpot integration account used by your host. This is usually the WRONG person on team accounts.
- hs_object_source_detail_2: records that this deal was created via your MCP host

COMMON PROPERTIES (inside the properties object):
- dealname (deal/opportunity name)
- amount (deal value as string, e.g., "10000")
- pipeline (pipeline ID from list_hubspot_pipelines, e.g., "default")
- dealstage (stage ID from list_hubspot_pipelines, e.g., "qualifiedtobuy")
- closedate (expected close date, format: "YYYY-MM-DD")

WORKFLOW:
1. list_hubspot_pipelines to get pipeline/stage IDs
2. list_hubspot_owners to find the correct deal owner
3. create_hubspot_deal with valid pipeline/stage IDs AND hubspot_owner_id
4. create_hubspot_association to link to contact/company

COMMON MISTAKES:
- Using this tool when the user says "lead" or "create a lead" — leads are a separate HubSpot object type. Use create_hubspot_lead instead.
- NOT specifying hubspot_owner_id — if omitted, the deal is silently assigned to the HubSpot integration account used by your host, NOT the intended deal owner. This causes incorrect assignment notifications and pipeline confusion. ALWAYS call list_hubspot_owners to find the correct owner ID.
- Using display names instead of IDs for pipeline/dealstage — always use list_hubspot_pipelines to get valid IDs first.

RETURNS: Created deal with id and properties`,
    aliases: ['add_deal', 'new_deal'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        hubspot_owner_id: { type: 'string', description: 'Owner ID for the deal (REQUIRED — get from list_hubspot_owners). If omitted, falls back to the integration account which is usually wrong for team accounts.' },
        properties: { type: 'object', description: 'Deal properties object', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['properties', 'hubspot_owner_id']
    }
  },
  {
    name: 'update_hubspot_deal',
    category: 'Deals',
    description: `Update an existing deal's properties.

USE THIS WHEN:
- User says "update deal" or "move deal to [stage]"
- Changing deal amount, stage, or close date
- Reassigning deal to different owner

COMMON UPDATES:
- dealstage: move to different pipeline stage (use stage ID from list_hubspot_pipelines)
- amount: update deal value
- closedate: update expected close date
- hubspot_owner_id: reassign to different team member

PREREQUISITE: Get dealId from search_hubspot_deals first`,
    aliases: ['edit_deal', 'modify_deal'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        dealId: { type: 'string', description: 'HubSpot deal ID' },
        properties: { type: 'object', description: 'Properties to update', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['dealId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_deal',
    category: 'Deals',
    description: `Permanently delete a deal from HubSpot.

WARNING: This is permanent. Deal history and associations will be lost.

PREREQUISITE: Get dealId from search_hubspot_deals first`,
    aliases: ['remove_deal'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        dealId: { type: 'string', description: 'HubSpot deal ID' }
      },
      required: ['dealId']
    }
  }
];

// Ticket Tools
export const ticketTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_tickets',
    category: 'Tickets',
    description: 'Search for tickets in HubSpot with filters',
    aliases: ['find_tickets', 'query_tickets'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      }
    }
  },
  {
    name: 'get_hubspot_ticket',
    category: 'Tickets',
    description: 'Get a single ticket by ID',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'HubSpot ticket ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'create_hubspot_ticket',
    category: 'Tickets',
    description: `Create a new ticket in HubSpot.
    
    Common properties:
    - subject (required)
    - content
    - hs_pipeline
    - hs_pipeline_stage
    - hs_ticket_priority`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Ticket properties', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['properties']
    }
  },
  {
    name: 'update_hubspot_ticket',
    category: 'Tickets',
    description: 'Update an existing ticket',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'HubSpot ticket ID' },
        properties: { type: 'object', description: 'Properties to update', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['ticketId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_ticket',
    category: 'Tickets',
    description: 'Delete a ticket from HubSpot',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'HubSpot ticket ID' }
      },
      required: ['ticketId']
    }
  }
];

// Lead Tools (requires Sales Hub Professional or Enterprise)
export const leadTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_leads',
    category: 'Leads',
    description: `Search for leads in HubSpot CRM.

NOTE: Requires Sales Hub Professional or Enterprise.

USE THIS WHEN:
- User asks "find leads" or "show my leads"
- Need to find leads by name or filter criteria
- Reviewing lead pipeline or status

RETURNS: Array of leads with id, properties (hs_lead_name, etc.)

EXAMPLES:
1. Find by name: query="John"
2. Find by status: filters=[{propertyName:"hs_lead_status", operator:"EQ", value:"NEW"}]
3. Find by owner: filters=[{propertyName:"hubspot_owner_id", operator:"EQ", value:"12345"}]

OPERATORS: EQ, NEQ, LT, LTE, GT, GTE, CONTAINS_TOKEN (partial match), IN (list)

COMMON PROPERTIES to request: hs_lead_name, hs_lead_status, hs_pipeline, hs_pipeline_stage, hubspot_owner_id, createdate`,
    aliases: ['find_leads', 'query_leads'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search by lead name' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'IN'] },
              value: { type: 'string' }
            }
          },
          description: 'Filter criteria for precise matching'
        },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return (default: basic info)' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_lead',
    category: 'Leads',
    description: `Get full details for a single lead by ID.

NOTE: Requires Sales Hub Professional or Enterprise.

USE THIS WHEN:
- You already have a lead ID (from search or association)
- Need complete lead information
- Reviewing a specific lead's properties and status

RETURNS: Single lead object with all requested properties

PREREQUISITE: Get leadId from search_hubspot_leads first`,
    aliases: ['view_lead', 'read_lead'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'HubSpot lead ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['leadId']
    }
  },
  {
    name: 'create_hubspot_lead',
    category: 'Leads',
    description: `Create a new lead in HubSpot CRM.

NOTE: Requires Sales Hub Professional or Enterprise.

IMPORTANT: This tool creates a HubSpot Lead object (pipeline/stage tracking in Sales Hub).
DO NOT use create_hubspot_deal when the user says "lead" — deals and leads are separate HubSpot object types.

REQUIRED:
- properties.hs_lead_name (the lead's display name)
- contactId (leads MUST be associated with a contact at creation — HubSpot API requirement)

The contactId is used to create a LEAD_TO_PRIMARY_CONTACT association automatically.

COMMON PROPERTIES:
- hs_lead_name (required — lead display name)
- hs_lead_status: "NEW", "OPEN", "IN_PROGRESS", "CONNECTED", "ATTEMPTED_TO_CONTACT"
- hubspot_owner_id: assign to a team member (get IDs from list_hubspot_owners)

WORKFLOW:
1. search_hubspot_contacts to find/create the contact
2. create_hubspot_lead with contactId and properties
3. Optionally create_hubspot_association to link to a company or deal

RETURNS: Created lead with id and properties`,
    aliases: ['add_lead', 'new_lead'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: {
          type: 'object',
          description: 'Lead properties object (hs_lead_name required)',
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        },
        contactId: {
          type: 'string',
          description: 'HubSpot contact ID to associate with this lead (required — leads must be linked to a contact)'
        }
      },
      required: ['properties', 'contactId']
    }
  },
  {
    name: 'update_hubspot_lead',
    category: 'Leads',
    description: `Update an existing lead's properties.

NOTE: Requires Sales Hub Professional or Enterprise.

USE THIS WHEN:
- User says "update lead" or "change lead status"
- Changing lead status, owner, or other properties

COMMON UPDATES:
- hs_lead_status: change lead status
- hubspot_owner_id: reassign to different team member

PREREQUISITE: Get leadId from search_hubspot_leads first

RETURNS: Updated lead object`,
    aliases: ['edit_lead', 'modify_lead'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'HubSpot lead ID' },
        properties: {
          type: 'object',
          description: 'Properties to update (only include changed fields)',
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        }
      },
      required: ['leadId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_lead',
    category: 'Leads',
    description: `Permanently delete a lead from HubSpot.

NOTE: Requires Sales Hub Professional or Enterprise.

WARNING: This is permanent. The lead record will be removed.

PREREQUISITE: Get leadId from search_hubspot_leads first`,
    aliases: ['remove_lead'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        leadId: { type: 'string', description: 'HubSpot lead ID' }
      },
      required: ['leadId']
    }
  }
];

// Task Tools
export const taskTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_tasks',
    category: 'Tasks',
    description: 'Search for tasks in HubSpot',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      }
    }
  },
  {
    name: 'get_hubspot_task',
    category: 'Tasks',
    description: 'Get a single task by ID',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'HubSpot task ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['taskId']
    }
  },
  {
    name: 'create_hubspot_task',
    category: 'Tasks',
    description: `Create a new task in HubSpot.
    
    Common properties:
    - hs_task_subject (required)
    - hs_task_body
    - hs_timestamp (due date in ms)
    - hs_task_status (NOT_STARTED, IN_PROGRESS, COMPLETED)
    - hs_task_priority (LOW, MEDIUM, HIGH)
    - hubspot_owner_id`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Task properties', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['properties']
    }
  },
  {
    name: 'update_hubspot_task',
    category: 'Tasks',
    description: 'Update an existing task',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'HubSpot task ID' },
        properties: { type: 'object', description: 'Properties to update', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['taskId', 'properties']
    }
  },
  {
    name: 'delete_hubspot_task',
    category: 'Tasks',
    description: 'Delete a task from HubSpot',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'HubSpot task ID' }
      },
      required: ['taskId']
    }
  }
];

// Note Tools
export const noteTools: ToolMetadata[] = [
  {
    name: 'create_hubspot_note',
    category: 'Notes',
    description: `Create a note in HubSpot and optionally associate it with records.

Properties:
- hs_note_body (required) - The note content (supports HTML)
- hs_timestamp - When the note was created (ISO8601 or Unix ms)
- hs_attachment_ids - Semicolon-separated file IDs to attach (e.g., "123" or "123;456")
  Get file IDs from upload_hubspot_file or import_hubspot_file_from_url.

TO ATTACH FILES TO A RECORD:
1. Upload file with upload_hubspot_file → get file id
2. Create note with hs_attachment_ids: "<file_id>" and associations to the record
Or use the convenience tool attach_file_to_record for a one-step workflow.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Note properties (hs_note_body required)', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } },
        associations: {
          type: 'object',
          description: 'Associate note with records',
          properties: {
            contactIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT },
            companyIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT },
            dealIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT },
            ticketIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT }
          }
        }
      },
      required: ['properties']
    }
  }
];

// Association Tools
export const associationTools: ToolMetadata[] = [
  {
    name: 'create_hubspot_association',
    category: 'Associations',
    description: `Create an unlabeled association between two HubSpot objects (v3 API).

For labeled associations (e.g., "Primary Contact", "Contract Signatory", "Decision Maker"),
use create_hubspot_labeled_association instead.

Common association types:
- contact_to_company
- deal_to_contact
- deal_to_company
- ticket_to_contact`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        fromObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] },
        fromObjectId: { type: 'string' },
        toObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] },
        toObjectId: { type: 'string' },
        associationType: { type: 'string', description: 'Association type (e.g., contact_to_company)' }
      },
      required: ['fromObjectType', 'fromObjectId', 'toObjectType', 'toObjectId', 'associationType']
    }
  },
  {
    name: 'get_hubspot_associations',
    category: 'Associations',
    description: 'Get all associations of a specific type for an object',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fromObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] },
        fromObjectId: { type: 'string' },
        toObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] }
      },
      required: ['fromObjectType', 'fromObjectId', 'toObjectType']
    }
  },
  {
    name: 'delete_hubspot_association',
    category: 'Associations',
    description: 'Remove an association between two objects',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fromObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] },
        fromObjectId: { type: 'string' },
        toObjectType: { type: 'string', enum: ['contacts', 'companies', 'deals', 'tickets', 'leads'] },
        toObjectId: { type: 'string' },
        associationType: { type: 'string' }
      },
      required: ['fromObjectType', 'fromObjectId', 'toObjectType', 'toObjectId', 'associationType']
    }
  }
];

// v4 Association Tools (labeled associations)
export const associationV4Tools: ToolMetadata[] = [
  {
    name: 'list_hubspot_association_labels',
    category: 'Associations',
    description: `List available association labels between two object types using the v4 API.

Returns all available labels (both HubSpot-defined and custom) with their typeId values.
Use the typeId from this response when calling create_hubspot_labeled_association.

Object type values: "contacts", "companies", "deals", "tickets", "products", "line_items", or custom object names.

RETURNS: Array of labels with { category, typeId, label }
- category: "HUBSPOT_DEFINED" (built-in labels like "Primary") or "USER_DEFINED" (custom labels)
- typeId: Numeric ID needed for create_hubspot_labeled_association
- label: Human-readable name (e.g., "Primary Contact", "Contract Signatory")`,
    aliases: ['get_association_labels', 'hubspot_association_types'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fromObjectType: { type: 'string', description: 'Source object type (e.g., "contacts", "companies", "deals")' },
        toObjectType: { type: 'string', description: 'Target object type (e.g., "deals", "contacts", "companies")' }
      },
      required: ['fromObjectType', 'toObjectType']
    }
  },
  {
    name: 'create_hubspot_labeled_association',
    category: 'Associations',
    description: `Create a labeled association between two records using the v4 API.

Unlike create_hubspot_association (v3, unlabeled), this creates associations WITH labels
like "Primary Contact", "Contract Signatory", "Decision Maker", etc.

WORKFLOW:
1. Call list_hubspot_association_labels to discover available labels and their typeIds
2. Call this tool with the desired associationCategory and associationTypeId

associationCategory:
- "HUBSPOT_DEFINED": Built-in labels (e.g., Primary Contact, typeId varies by object pair)
- "USER_DEFINED": Custom labels created in HubSpot Settings → Objects → Associations`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        fromObjectType: { type: 'string', description: 'Source object type (e.g., "contacts")' },
        fromObjectId: { type: 'string', description: 'Source record ID' },
        toObjectType: { type: 'string', description: 'Target object type (e.g., "deals")' },
        toObjectId: { type: 'string', description: 'Target record ID' },
        associationCategory: {
          type: 'string',
          enum: ['HUBSPOT_DEFINED', 'USER_DEFINED'],
          description: 'Label category (from list_hubspot_association_labels)'
        },
        associationTypeId: {
          type: 'number',
          description: 'Label type ID (from list_hubspot_association_labels)'
        }
      },
      required: ['fromObjectType', 'fromObjectId', 'toObjectType', 'toObjectId', 'associationCategory', 'associationTypeId']
    }
  }
];

// Property Tools
export const propertyTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_properties',
    category: 'Properties',
    description: `List all properties for a HubSpot object type.

Supports standard types (contacts, companies, deals, tickets, tasks, leads) and custom objects.
Note: For "leads", this listing endpoint works but get_hubspot_property may return SCOPE_MISSING
due to a HubSpot API scope limitation.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        }
      },
      required: ['objectType']
    }
  },
  {
    name: 'get_hubspot_property',
    category: 'Properties',
    description: `Get a single property definition by object type and property name.

NOTE: The "leads" object type may return SCOPE_MISSING (403) because HubSpot requires
crm.schemas.leads.read scope which is not always granted during OAuth. If this happens,
use list_hubspot_properties instead (which works for leads). This is a known HubSpot API
limitation, not a bug.`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        },
        propertyName: {
          type: 'string',
          description: 'Internal property name (e.g., "lifecyclestage")'
        }
      },
      required: ['objectType', 'propertyName']
    }
  },
  {
    name: 'create_hubspot_property',
    category: 'Properties',
    description: `Create a new custom property on a HubSpot object.

VALID TYPE/FIELDTYPE COMBINATIONS:
- string: text, textarea, phonenumber, html
- number: number
- date: date
- datetime: date
- enumeration: select, radio, checkbox, booleancheckbox
- bool: booleancheckbox`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        },
        name: {
          type: 'string',
          description: 'Internal property name (lowercase, no spaces, underscores allowed)'
        },
        label: {
          type: 'string',
          description: 'Display label shown in HubSpot UI'
        },
        type: {
          type: 'string',
          enum: ['string', 'number', 'date', 'datetime', 'enumeration', 'bool'],
          description: 'Property data type'
        },
        fieldType: {
          type: 'string',
          enum: ['text', 'textarea', 'phonenumber', 'html', 'number', 'date', 'select', 'radio', 'checkbox', 'booleancheckbox'],
          description: 'HubSpot field type'
        },
        groupName: {
          type: 'string',
          description: 'Property group internal name (use list_hubspot_property_groups to discover)'
        },
        description: {
          type: 'string',
          description: 'Optional property description'
        },
        options: {
          type: 'array',
          description: 'Options for enumeration properties',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Option label shown to users' },
              value: { type: 'string', description: 'Internal option value' },
              description: { type: 'string', description: 'Optional option description' },
              displayOrder: { type: 'number', description: 'Display order in dropdown/list' },
              hidden: { type: 'boolean', description: 'Whether the option is hidden' }
            },
            required: ['label', 'value']
          }
        }
      },
      required: ['objectType', 'name', 'label', 'type', 'fieldType', 'groupName']
    }
  },
  {
    name: 'update_hubspot_property',
    category: 'Properties',
    description: 'Update an existing property definition. Note: type and fieldType CANNOT be changed after creation.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        },
        propertyName: {
          type: 'string',
          description: 'Internal property name to update'
        },
        label: {
          type: 'string',
          description: 'Updated display label'
        },
        description: {
          type: 'string',
          description: 'Updated description'
        },
        options: {
          type: 'array',
          description: 'Updated options for enumeration properties',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
              description: { type: 'string' },
              displayOrder: { type: 'number' },
              hidden: { type: 'boolean' }
            },
            required: ['label', 'value']
          }
        }
      },
      required: ['objectType', 'propertyName']
    }
  },
  {
    name: 'delete_hubspot_property',
    category: 'Properties',
    description: 'Archive a property from HubSpot. This ARCHIVES the property (not a hard delete).',
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        },
        propertyName: {
          type: 'string',
          description: 'Internal property name to archive'
        }
      },
      required: ['objectType', 'propertyName']
    }
  },
  {
    name: 'list_hubspot_property_groups',
    category: 'Properties',
    description: 'List property groups for a HubSpot object type',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        }
      },
      required: ['objectType']
    }
  },
  {
    name: 'create_hubspot_property_group',
    category: 'Properties',
    description: 'Create a new property group for an object type',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: {
          type: 'string',
          description: 'Object type (e.g., "contacts", "companies", "deals", "tickets", "tasks", "leads", or a custom object type ID like "2-12345")'
        },
        name: {
          type: 'string',
          description: 'Internal group name'
        },
        label: {
          type: 'string',
          description: 'Display label for the group'
        },
        displayOrder: {
          type: 'number',
          description: 'Display order for the group (optional)'
        }
      },
      required: ['objectType', 'name', 'label']
    }
  }
];

// Owner Tools
export const ownerTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_owners',
    category: 'Owners',
    description: `List all HubSpot users who can own CRM records.

USE THIS WHEN:
- Need to assign a contact, deal, or company to a team member
- User asks "who can I assign this to?" or "show me the sales team"
- Creating/updating records with hubspot_owner_id property

RETURNS: Array of owners with:
- id (use this as hubspot_owner_id when creating/updating records)
- email, firstName, lastName
- teams[] (team memberships)

WORKFLOW EXAMPLE:
1. User: "Assign the Acme deal to Sarah"
2. Call list_hubspot_owners to find Sarah's owner ID
3. Call update_hubspot_deal with hubspot_owner_id: "sarah's_id"`,
    aliases: ['get_hubspot_owners', 'hubspot_users', 'hubspot_team'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_owner',
    category: 'Owners',
    description: `Get details for a specific HubSpot owner by ID.

USE THIS WHEN:
- You have an owner ID and need their name/email
- Resolving hubspot_owner_id from a record to display owner name

PREREQUISITE: Get ownerId from list_hubspot_owners or from a record's hubspot_owner_id property`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ownerId: { type: 'string', description: 'HubSpot owner ID (numeric string)' }
      },
      required: ['ownerId']
    }
  }
];

// Pipeline Tools
export const pipelineTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_pipelines',
    category: 'Pipelines',
    description: `List all sales pipelines and their stages.

USE THIS WHEN (CRITICAL for deal operations):
- BEFORE creating a deal (to get valid pipeline and dealstage IDs)
- BEFORE updating deal stage (to get valid stage ID)
- User asks "what are the deal stages?" or "show me the pipeline"

RETURNS: Array of pipelines, each containing:
- pipelineId (use as "pipeline" property)
- label (display name)
- stages[] with:
  - stageId (use as "dealstage" property)
  - label (display name like "Qualified", "Proposal Sent")
  - displayOrder (stage position)
  - metadata.probability (win probability %)

EXAMPLE RESPONSE:
{
  "pipelineId": "default",
  "label": "Sales Pipeline",
  "stages": [
    {"stageId": "appointmentscheduled", "label": "Appointment Scheduled"},
    {"stageId": "qualifiedtobuy", "label": "Qualified to Buy"},
    {"stageId": "closedwon", "label": "Closed Won"}
  ]
}

IMPORTANT: Stage IDs are internal identifiers, NOT display names. Always use this tool first!`,
    aliases: ['get_hubspot_pipelines', 'hubspot_stages', 'deal_stages'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', enum: ['deals', 'tickets'], description: 'Object type (default: deals)' }
      },
      required: ['objectType']
    }
  },
  {
    name: 'get_hubspot_pipeline',
    category: 'Pipelines',
    description: `Get details for a specific pipeline including all stages.

USE THIS WHEN:
- You know the pipeline ID and need its stages
- Working with a specific pipeline (not the default)

PREREQUISITE: Get pipelineId from list_hubspot_pipelines if you don't know it`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        objectType: { type: 'string', enum: ['deals', 'tickets'], description: 'Object type' },
        pipelineId: { type: 'string', description: 'Pipeline ID (e.g., "default")' }
      },
      required: ['objectType', 'pipelineId']
    }
  }
];

// Engagement Tools (calls, meetings)
export const engagementTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_calls',
    category: 'Engagements',
    description: `Search for logged calls in HubSpot CRM.

USE THIS WHEN:
- User asks "show recent calls" or "find calls with [contact]"
- Need call history for meeting prep
- Looking for specific call recordings or notes

RETURNS: Array of calls with id, properties

EXAMPLE FILTERS:
1. Recent calls: filters=[{propertyName:"hs_timestamp", operator:"GT", value:"1704067200000"}]
2. By owner: filters=[{propertyName:"hubspot_owner_id", operator:"EQ", value:"12345"}]
3. Outbound only: filters=[{propertyName:"hs_call_direction", operator:"EQ", value:"OUTBOUND"}]

PROPERTIES to request:
- hs_call_title, hs_call_body (notes/transcript)
- hs_call_direction: "INBOUND" or "OUTBOUND"
- hs_call_status: "COMPLETED", "BUSY", "NO_ANSWER", "FAILED", "CONNECTING", "CALLING_CRM_USER"
- hs_call_duration (milliseconds)
- hs_timestamp (Unix ms when call occurred)
- hubspot_owner_id`,
    aliases: ['find_hubspot_calls', 'get_hubspot_calls'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'search_hubspot_meetings',
    category: 'Engagements',
    description: `Search for logged meetings in HubSpot CRM.

USE THIS WHEN:
- User asks "show meetings" or "find meetings with [contact]"
- Need meeting history for relationship context
- Looking for past meeting notes

RETURNS: Array of meetings with id, properties

EXAMPLE FILTERS:
1. Upcoming: filters=[{propertyName:"hs_meeting_start_time", operator:"GT", value:"1704067200000"}]
2. Completed: filters=[{propertyName:"hs_meeting_outcome", operator:"EQ", value:"COMPLETED"}]

PROPERTIES to request:
- hs_meeting_title, hs_meeting_body (notes/agenda)
- hs_meeting_start_time, hs_meeting_end_time (Unix ms)
- hs_meeting_outcome: "SCHEDULED", "COMPLETED", "RESCHEDULED", "NO_SHOW", "CANCELLED"
- hs_meeting_location
- hubspot_owner_id`,
    aliases: ['find_hubspot_meetings', 'get_hubspot_meetings'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        filters: { type: 'array', items: { type: 'object' }, description: 'Filter criteria' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10, max 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_call',
    category: 'Engagements',
    description: `Get full details for a single call by ID.

USE THIS WHEN:
- You have a call ID and need complete details
- Retrieving call notes or recording info

PREREQUISITE: Get callId from search_hubspot_calls or get_contact_engagements`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        callId: { type: 'string', description: 'HubSpot call ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['callId']
    }
  },
  {
    name: 'get_hubspot_meeting',
    category: 'Engagements',
    description: `Get full details for a single meeting by ID.

USE THIS WHEN:
- You have a meeting ID and need complete details
- Retrieving meeting notes or attendee info

PREREQUISITE: Get meetingId from search_hubspot_meetings or get_contact_engagements`,
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'HubSpot meeting ID (numeric string)' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['meetingId']
    }
  },
  {
    name: 'create_hubspot_call',
    category: 'Engagements',
    description: `Log a call in HubSpot CRM.

USE THIS WHEN:
- User says "log a call" or "record that I called [contact]"
- Documenting a phone conversation
- Adding call notes after a conversation

REQUIRED: hs_timestamp (Unix timestamp in milliseconds)

COMMON PROPERTIES:
- hs_timestamp: when call occurred (REQUIRED, Unix ms, e.g., Date.now())
- hs_call_title: brief description
- hs_call_body: notes, transcript, or summary
- hs_call_direction: "INBOUND" or "OUTBOUND"
- hs_call_status: "COMPLETED", "BUSY", "NO_ANSWER", "FAILED"
- hs_call_duration: call length in milliseconds
- hubspot_owner_id: who made the call

ASSOCIATIONS (link call to records):
- contactIds: ["contact_id_1", "contact_id_2"]
- companyIds: ["company_id"]
- dealIds: ["deal_id"]

WORKFLOW:
1. search_hubspot_contacts to get contact ID
2. create_hubspot_call with associations.contactIds

RETURNS: Created call with id`,
    aliases: ['log_hubspot_call', 'record_call'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Call properties object', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } },
        associations: {
          type: 'object',
          description: 'Link call to CRM records',
          properties: {
            contactIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Contact IDs to associate' },
            companyIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Company IDs to associate' },
            dealIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Deal IDs to associate' }
          }
        }
      },
      required: ['properties']
    }
  },
  {
    name: 'create_hubspot_meeting',
    category: 'Engagements',
    description: `Log a meeting in HubSpot CRM.

USE THIS WHEN:
- User says "log a meeting" or "record meeting with [contact]"
- Documenting a completed meeting
- Scheduling a future meeting in CRM

REQUIRED:
- hs_timestamp (Unix ms)
- hs_meeting_start_time (Unix ms)
- hs_meeting_end_time (Unix ms)

COMMON PROPERTIES:
- hs_timestamp: when meeting was logged (Unix ms)
- hs_meeting_start_time: meeting start (Unix ms)
- hs_meeting_end_time: meeting end (Unix ms)
- hs_meeting_title: meeting subject
- hs_meeting_body: notes, agenda, or action items
- hs_meeting_outcome: "SCHEDULED", "COMPLETED", "RESCHEDULED", "NO_SHOW", "CANCELLED"
- hs_meeting_location: location or video link
- hubspot_owner_id: meeting organizer

ASSOCIATIONS (link meeting to records):
- contactIds: attendee contact IDs
- companyIds: company IDs
- dealIds: related deal IDs

WORKFLOW:
1. search_hubspot_contacts to get attendee contact IDs
2. create_hubspot_meeting with associations

RETURNS: Created meeting with id`,
    aliases: ['log_hubspot_meeting', 'record_meeting'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { type: 'object', description: 'Meeting properties object', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } },
        associations: {
          type: 'object',
          description: 'Link meeting to CRM records',
          properties: {
            contactIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Attendee contact IDs' },
            companyIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Company IDs' },
            dealIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Related deal IDs' }
          }
        }
      },
      required: ['properties']
    }
  },
  {
    name: 'get_contact_engagements',
    category: 'Engagements',
    description: `Get all recent activity (calls, meetings) for a contact.

USE THIS WHEN:
- User asks "what's the history with [contact]?" or "show activity for [person]"
- Preparing for a meeting and need relationship context
- Need a quick activity summary

RETURNS: Object with arrays for each engagement type:
{
  calls: [{id, properties}],
  meetings: [{id, properties}]
}

This is a convenience tool that fetches multiple engagement types in one call.
For more control, use search_hubspot_calls or search_hubspot_meetings directly.

PREREQUISITE: Get contactId from search_hubspot_contacts first`,
    aliases: ['get_contact_activity', 'contact_timeline', 'contact_history'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        contactId: { type: 'string', description: 'HubSpot contact ID (numeric string)' },
        limit: { type: 'number', description: 'Max results per engagement type (default 5)' }
      },
      required: ['contactId']
    }
  }
];

// Product Tools
export const productTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_products',
    category: 'Products',
    description: `Search for products in your HubSpot product catalog.

USE THIS WHEN:
- User asks about products, SKUs, or pricing
- Looking up specific products by name or SKU
- Finding products to add to a deal as line items

COMMON PROPERTIES:
- name: Product name
- hs_sku: Stock keeping unit
- price: Unit price
- description: Product description
- hs_cost_of_goods_sold: Cost/COGS
- hs_recurring_billing_period: P1M (monthly), P1Y (yearly)

SEARCH BY TEXT: Use "query" for free-text search (name, SKU)
SEARCH BY FILTER: Use "filters" for exact matches

RETURNS: Array of products with id and properties`,
    aliases: ['find_products', 'search_products', 'list_products'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text search (searches name and SKU)' },
        filters: {
          type: 'array',
          description: 'Filter criteria (same syntax as contacts/deals)',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'CONTAINS_TOKEN', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY'] },
              value: { type: 'string' }
            },
            required: ['propertyName', 'operator', 'value']
          }
        },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      }
    }
  },
  {
    name: 'get_hubspot_product',
    category: 'Products',
    description: `Get a specific product by ID.

USE THIS WHEN:
- You have a product ID and need full details
- Looking up product pricing or SKU details

RETURNS: Product object with all requested properties`,
    aliases: ['get_product'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: 'HubSpot product ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['productId']
    }
  },
  {
    name: 'create_hubspot_product',
    category: 'Products',
    description: `Create a new product in the product catalog.

USE THIS WHEN:
- Adding new products to sell
- Setting up product catalog

REQUIRED: name
RECOMMENDED: price, hs_sku, description

EXAMPLE:
{
  "properties": {
    "name": "Enterprise License",
    "price": "10000",
    "hs_sku": "ENT-001",
    "description": "Annual enterprise license"
  }
}

RETURNS: Created product with id`,
    aliases: ['add_product', 'new_product'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { 
          type: 'object', 
          description: 'Product properties (name required)', 
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        }
      },
      required: ['properties']
    }
  },
  {
    name: 'update_hubspot_product',
    category: 'Products',
    description: `Update an existing product's properties.

USE THIS WHEN:
- Changing product price
- Updating SKU or description
- Modifying any product attribute

RETURNS: Updated product`,
    aliases: ['edit_product', 'modify_product'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        productId: { type: 'string', description: 'HubSpot product ID' },
        properties: { type: 'object', description: 'Properties to update', additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH } }
      },
      required: ['productId', 'properties']
    }
  }
];

// Line Item Tools
export const lineItemTools: ToolMetadata[] = [
  {
    name: 'search_hubspot_line_items',
    category: 'Line Items',
    description: `Search for line items in HubSpot.

Line items connect products to deals for revenue tracking.
Each line item represents a product/service with quantity and price on a deal.

COMMON PROPERTIES:
- name: Line item name (often matches product)
- quantity: Number of units
- price: Unit price
- amount: Total (quantity × price)
- hs_discount_percentage: Applied discount
- hs_product_id: Source product ID

RETURNS: Array of line items`,
    aliases: ['find_line_items', 'search_line_items'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        filters: {
          type: 'array',
          description: 'Filter criteria',
          items: {
            type: 'object',
            properties: {
              propertyName: { type: 'string' },
              operator: { type: 'string', enum: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'HAS_PROPERTY', 'NOT_HAS_PROPERTY'] },
              value: { type: 'string' }
            },
            required: ['propertyName', 'operator', 'value']
          }
        },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' },
        limit: { type: 'number', description: 'Max results (default 10)' }
      }
    }
  },
  {
    name: 'get_hubspot_line_item',
    category: 'Line Items',
    description: `Get a specific line item by ID.

RETURNS: Line item with properties and associations`,
    aliases: ['get_line_item'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        lineItemId: { type: 'string', description: 'HubSpot line item ID' },
        properties: { type: 'array', items: { type: 'string' }, description: 'Properties to return' }
      },
      required: ['lineItemId']
    }
  },
  {
    name: 'create_hubspot_line_item',
    category: 'Line Items',
    description: `Create a line item and optionally associate with a deal.

Line items link products to deals for revenue tracking.
This is the KEY tool for adding products to a deal.

WORKFLOW:
1. search_hubspot_products to find product ID
2. search_hubspot_deals to find deal ID
3. create_hubspot_line_item with dealId association

REQUIRED PROPERTIES:
- name: Line item name
- quantity: Number of units (string, e.g. "1")
- price: Unit price (string, e.g. "1000.00")

OPTIONAL:
- hs_product_id: Link to product catalog
- hs_discount_percentage: Discount to apply
- dealId: Associate immediately with deal

EXAMPLE:
{
  "properties": {
    "name": "Enterprise License - Annual",
    "quantity": "2",
    "price": "10000",
    "hs_product_id": "123456"
  },
  "dealId": "789"
}

RETURNS: Created line item with id`,
    aliases: ['add_line_item', 'create_deal_line_item'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        properties: { 
          type: 'object', 
          description: 'Line item properties (name, quantity, price required)', 
          additionalProperties: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH }
        },
        dealId: { type: 'string', description: 'Deal ID to associate (recommended)' }
      },
      required: ['properties']
    }
  }
];

// Forms Tools
export const formsTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_forms',
    category: 'Forms',
    description: `List all forms in HubSpot.

Forms collect leads through your website, landing pages, or embedded forms.

FORM TYPES:
- hubspot: Standard HubSpot forms
- captured: Non-HubSpot forms (collected via tracking)
- flow: Pop-up forms
- blog_comment: Blog comment forms

RETURNS: Array of forms with id, name, formType, createdAt`,
    aliases: ['get_forms', 'show_forms'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        formTypes: { 
          type: 'array', 
          items: { type: 'string', enum: ['hubspot', 'captured', 'flow', 'blog_comment'] },
          description: 'Filter by form type (default: all types)' 
        },
        limit: { type: 'number', description: 'Max results (default 20)' },
        after: { type: 'string', description: 'Pagination cursor' }
      }
    }
  },
  {
    name: 'get_hubspot_form',
    category: 'Forms',
    description: `Get detailed information about a specific form.

RETURNS: Form with id, name, configuration, fieldGroups (form fields)`,
    aliases: ['get_form_details'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'HubSpot form ID or GUID' }
      },
      required: ['formId']
    }
  },
  {
    name: 'get_hubspot_form_submissions',
    category: 'Forms',
    description: `Get submissions for a specific form.

USE THIS WHEN:
- Reviewing lead capture performance
- Checking recent form submissions
- Analyzing lead sources

RETURNS: Array of submissions with:
- submittedAt: Submission timestamp
- values: Field name/value pairs
- pageUrl: Where form was submitted

NOTE: Uses formGuid (same as formId for most forms)`,
    aliases: ['get_form_responses', 'list_submissions'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        formId: { type: 'string', description: 'Form ID/GUID' },
        limit: { type: 'number', description: 'Max submissions (default 20, max 50)' },
        after: { type: 'string', description: 'Pagination cursor' }
      },
      required: ['formId']
    }
  }
];

// Analytics Tools (Requires Marketing Hub)
export const analyticsTools: ToolMetadata[] = [
  {
    name: 'get_hubspot_analytics_report',
    category: 'Analytics',
    description: `Get website traffic analytics report.

This is the ONLY reporting API available from HubSpot. HubSpot does not have a public API
for creating, listing, or managing custom reports or dashboards. For custom report needs,
users must use the HubSpot UI directly.

⚠️ REQUIRES Marketing Hub Professional or Enterprise.
Will return 403 error on free accounts.

BREAKDOWN OPTIONS:
- totals: Overall traffic metrics
- sessions: Session-based metrics
- sources: Traffic by source (organic, direct, etc.)
- geolocation: Traffic by country/region
- utm-campaigns: By UTM campaign
- utm-sources: By UTM source
- utm-mediums: By UTM medium
- pages: By page URL

TIME PERIODS:
- totals: Aggregate for date range
- daily: Day-by-day breakdown
- weekly: Week-by-week
- monthly: Month-by-month

DATE FORMAT: YYYYMMDD (e.g., "20260101")

RETURNS: {
  totals: {views, visits, leads, ...},
  breakdowns: [{breakdown: "...", metrics: {...}}, ...]
}`,
    aliases: ['get_analytics', 'get_traffic_report', 'website_analytics'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        breakdownBy: { 
          type: 'string', 
          enum: ['totals', 'sessions', 'sources', 'geolocation', 'utm-campaigns', 'utm-sources', 'utm-mediums', 'pages'],
          description: 'How to segment the data'
        },
        timePeriod: {
          type: 'string',
          enum: ['totals', 'daily', 'weekly', 'monthly'],
          description: 'Time grouping'
        },
        startDate: { type: 'string', description: 'Start date YYYYMMDD' },
        endDate: { type: 'string', description: 'End date YYYYMMDD' },
        limit: { type: 'number', description: 'Max breakdown rows (default 100)' }
      },
      required: ['breakdownBy', 'timePeriod', 'startDate', 'endDate']
    }
  }
];

// Marketing Email Tools
export const marketingEmailTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_marketing_emails',
    category: 'Marketing Emails',
    description: `List marketing emails in HubSpot.

RETURNS: Array of emails with:
- id, name, subject
- state: DRAFT, SCHEDULED, PUBLISHED, etc.
- type: REGULAR, AB_EMAIL, BLOG_EMAIL, etc.
- createdAt, stats (if available)`,
    aliases: ['get_marketing_emails', 'list_emails'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
        after: { type: 'string', description: 'Pagination cursor' }
      }
    }
  },
  {
    name: 'get_hubspot_marketing_email',
    category: 'Marketing Emails',
    description: `Get details of a specific marketing email by ID.

USE THIS WHEN:
- User asks "show me the follow-up email" or "what's in email X"
- Need email content, subject, template path, or configuration

RETURNS: Full email object including:
- id, name, subject, previewText
- state, type, templatePath
- content/body (if available)
- stats summary`,
    aliases: ['get_email', 'show_email', 'get_email_details'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        emailId: { type: 'string', description: 'Marketing email ID' }
      },
      required: ['emailId']
    }
  },
  {
    name: 'get_hubspot_email_statistics',
    category: 'Marketing Emails',
    description: `Get aggregated email performance statistics.

RETURNS: {
  aggregations: {sent, delivered, opened, clicked, bounced, unsubscribed},
  emails: [{emailId, counters: {...}}]
}

Use this to analyze email campaign performance across multiple emails.`,
    aliases: ['get_email_stats', 'email_performance'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        startTimestamp: { type: 'string', description: 'ISO8601 start (e.g., "2026-01-01T00:00:00Z")' },
        endTimestamp: { type: 'string', description: 'ISO8601 end' },
        emailIds: { type: 'array', items: { type: 'string' }, description: 'Specific email IDs (optional)' }
      }
    }
  }
];

// ============================================================================
// LISTS/SEGMENTS TOOLS
// ============================================================================

const listsTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_lists',
    category: 'Lists',
    description: `List all contact lists (segments) in HubSpot.

RETURNS: Array of lists with {listId, name, processingType, size, createdAt}

processingType values:
- MANUAL: Static list, manually managed
- DYNAMIC: Auto-updates based on filter criteria
- SNAPSHOT: Point-in-time capture, does not update

Use get_hubspot_list to see a dynamic list's filter criteria.`,
    aliases: ['list_hubspot_segments', 'get_all_lists', 'get_all_segments'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max results (default: 20, max: 100)' },
        after: { type: 'string', description: 'Pagination cursor from previous response' }
      }
    }
  },
  {
    name: 'get_hubspot_list',
    category: 'Lists',
    description: `Get details of a specific list/segment by ID.

RETURNS: {listId, name, processingType, objectTypeId, filterBranch, size, createdAt, updatedAt}

For DYNAMIC lists, filterBranch contains the criteria that determine membership.
For MANUAL/SNAPSHOT lists, filterBranch is usually empty.

To get the contacts IN this list, use list_hubspot_list_members.`,
    aliases: ['get_hubspot_segment', 'get_list_details', 'get_segment_details'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The list ID (from list_hubspot_lists)' }
      },
      required: ['listId']
    }
  },
  {
    name: 'list_hubspot_list_members',
    category: 'Lists',
    description: `Get contact IDs that are members of a list/segment.

IMPORTANT: Returns contact IDs only, NOT full contact records.
To get contact details (email, name, etc.), use batch_read_hubspot_contacts.

WORKFLOW for exporting a segment:
1. Call list_hubspot_list_members(listId) to get contact IDs
2. Call batch_read_hubspot_contacts(ids, properties) to get details
3. Repeat with pagination cursor if needed

RETURNS: {results: [{recordId, membershipTimestamp}], paging: {next: {after}}}`,
    aliases: ['get_hubspot_segment_members', 'list_members', 'get_list_contacts', 'export_list'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        listId: { type: 'string', description: 'The list ID to get members for' },
        limit: { type: 'number', description: 'Max results per page (default: 100, max: 250)' },
        after: { type: 'string', description: 'Pagination cursor from previous response' }
      },
      required: ['listId']
    }
  },
  {
    name: 'batch_read_hubspot_contacts',
    category: 'Lists',
    description: `Fetch multiple contacts by ID in a single request (up to 100).

USE THIS TO: Hydrate contact IDs from list_hubspot_list_members into full records.

WORKFLOW:
1. list_hubspot_list_members(listId) → get recordIds
2. batch_read_hubspot_contacts(ids, ['email', 'firstname', 'lastname']) → get details

RETURNS: {results: [{id, properties: {email, firstname, ...}, createdAt, updatedAt}]}

Common properties: email, firstname, lastname, phone, company, jobtitle, lifecyclestage`,
    aliases: ['batch_get_contacts', 'get_contacts_by_ids', 'hydrate_contact_ids'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        ids: { 
          type: 'array', 
          items: { type: 'string' }, 
          maxItems: MAX_FAN_OUT,
          description: 'Contact IDs to fetch (max 100)' 
        },
        properties: { 
          type: 'array', 
          items: { type: 'string' }, 
          description: 'Properties to return (e.g., ["email", "firstname", "lastname"])' 
        }
      },
      required: ['ids']
    }
  }
];

// ============================================================================
// KNOWLEDGE BASE TOOLS
// ============================================================================

export const knowledgeBaseTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_kb_articles',
    category: 'Knowledge Base',
    description: `List Knowledge Base articles in HubSpot via the GraphQL API (read-only).

USE THIS WHEN:
- User asks "show me KB articles" or "what's in the knowledge base?"
- Need to browse all KB articles with pagination
- Looking for a specific article to retrieve with get_hubspot_kb_article

RETURNS:
- KB articles with id, title, body, slug, URL, language, and metadata
- Total count and pagination support via limit/offset

SCOPES REQUIRED: cms.knowledge_base.articles.read and collector.graphql_query.execute
(user may need to reconnect HubSpot to grant these scopes)

COMMON MISTAKES:
- Expecting write operations — KB tools are read-only (no create/update/delete API exists)

Requires Service Hub Professional or Enterprise.`,
    aliases: ['list_kb_articles', 'get_hubspot_kb_articles'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max articles to return (default 10)' },
        offset: { type: 'number', description: 'Number of articles to skip for pagination (default 0)' }
      }
    }
  },
  {
    name: 'get_hubspot_kb_article',
    category: 'Knowledge Base',
    description: `Get full details for a single HubSpot Knowledge Base article by ID via the GraphQL API (read-only).

USE THIS WHEN:
- You already have an articleId and need full content/details
- Need the complete article body, metadata, or URL

RETURNS:
- Full KB article object with id, title, body, slug, URL, language, and metadata

WORKFLOW:
1. Get articleId from list_hubspot_kb_articles or search_hubspot_kb_articles
2. Call get_hubspot_kb_article for complete details

SCOPES REQUIRED: cms.knowledge_base.articles.read and collector.graphql_query.execute
(user may need to reconnect HubSpot to grant these scopes)

COMMON MISTAKES:
- Using a knowledgeBaseId/contentGroupId instead of an articleId
- Assuming search result snippets are full article content — use this tool for the full body

Requires Service Hub Professional or Enterprise.`,
    aliases: ['get_kb_article', 'view_kb_article'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        articleId: { type: 'string', description: 'HubSpot KB article ID' }
      },
      required: ['articleId']
    }
  },
  {
    name: 'search_hubspot_kb_articles',
    category: 'Knowledge Base',
    description: `Search published HubSpot Knowledge Base content by query text via the Site Search API (read-only).

USE THIS WHEN:
- User asks to find KB content by keyword or phrase
- Looking up published help articles or troubleshooting docs

RETURNS:
- Search matches with title, URL, and snippet metadata from HubSpot site search

WORKFLOW:
1. Call search_hubspot_kb_articles with a clear query
2. Use get_hubspot_kb_article for full article details when needed

IMPORTANT: Only finds PUBLISHED articles. This tool searches the public site index and does not
include draft or scheduled content. Use list_hubspot_kb_articles to browse all articles.

COMMON MISTAKES:
- Expecting drafts in results — site search only indexes published content
- Using this as the only retrieval path when you need all articles

Requires Service Hub Professional or Enterprise.`,
    aliases: ['search_kb_articles', 'find_kb_articles'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query text' },
        limit: { type: 'number', description: 'Max search results to return' }
      },
      required: ['query']
    }
  }
];

// ============================================================================
// FILE TOOLS
// ============================================================================

export const fileTools: ToolMetadata[] = [
  {
    name: 'upload_hubspot_file',
    category: 'Files',
    description: `Upload a file to HubSpot's file manager from a local file path.

USE THIS WHEN:
- User wants to upload a document, image, or attachment to HubSpot
- Preparing a file to attach to a CRM record (contact, deal, company, ticket)
- Storing branding assets, proposals, contracts, etc.

RETURNS: { id, name, path, url, size, access }
- The "id" is the file ID used to attach files to records via notes

WORKFLOW to attach a file to a record:
1. upload_hubspot_file → get file "id"
2. create_hubspot_note with hs_attachment_ids set to the file id, and associations to link to the record

ACCESS LEVELS:
- PRIVATE (default): Only accessible via signed URL, not publicly visible
- PUBLIC_NOT_INDEXABLE: Publicly accessible but search engines won't index
- PUBLIC_INDEXABLE: Fully public and indexable by search engines`,
    aliases: ['hubspot_upload', 'upload_file_to_hubspot'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute local file path to upload (e.g., "/Users/me/Documents/proposal.pdf")' },
        folderPath: { type: 'string', description: 'Destination folder in HubSpot file manager (e.g., "/attachments"). Default: "/"' },
        access: {
          type: 'string',
          enum: ['PRIVATE', 'PUBLIC_NOT_INDEXABLE', 'PUBLIC_INDEXABLE'],
          description: 'File visibility (default: PRIVATE)'
        }
      },
      required: ['filePath']
    }
  },
  {
    name: 'import_hubspot_file_from_url',
    category: 'Files',
    description: `Import a file into HubSpot's file manager from a URL.

USE THIS WHEN:
- User wants to import a file from the web into HubSpot
- Adding a file from a public URL to attach to a record
- Importing images, documents, or media from external sources

This tool handles the async import process automatically (polls until complete, up to 30s).
Returns the final file object with its ID once ready.

WORKFLOW to attach an imported file to a record:
1. import_hubspot_file_from_url → get file { id, name, path, url, size }
2. create_hubspot_note with hs_attachment_ids set to the file id, and associations to link to the record

ACCESS LEVELS:
- PRIVATE (default): Only accessible via signed URL
- PUBLIC_NOT_INDEXABLE: Publicly accessible, not indexed
- PUBLIC_INDEXABLE: Fully public and indexable`,
    aliases: ['import_file_to_hubspot', 'hubspot_import_url'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Public URL of the file to import (e.g., "https://example.com/doc.pdf")' },
        fileName: { type: 'string', description: 'Override the file name (optional, derived from URL if omitted)' },
        folderPath: { type: 'string', description: 'Destination folder in HubSpot file manager (e.g., "/imports"). Default: "/"' },
        access: {
          type: 'string',
          enum: ['PRIVATE', 'PUBLIC_NOT_INDEXABLE', 'PUBLIC_INDEXABLE'],
          description: 'File visibility (default: PRIVATE)'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'get_hubspot_file',
    category: 'Files',
    description: `Get details of a file in HubSpot's file manager by ID.

USE THIS WHEN:
- Need to check file details (name, size, URL, access level)
- Verifying a file exists before attaching to a record
- Getting a viewable URL for a private file (use getSignedUrl: true)

RETURNS: { id, name, path, url, size, type, access, createdAt, updatedAt }
For private files, the url will 404. Set getSignedUrl to true to get a temporary viewable URL.`,
    aliases: ['get_file_details', 'hubspot_file_info'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'HubSpot file ID (from upload or import)' },
        getSignedUrl: { type: 'boolean', description: 'If true, also return a signed (viewable) URL for private files' }
      },
      required: ['fileId']
    }
  },
  {
    name: 'delete_hubspot_file',
    category: 'Files',
    description: `Delete a file from HubSpot's file manager.

WARNING: This marks the file as deleted and makes its content inaccessible.
Notes that reference this file will no longer display the attachment.`,
    aliases: ['remove_hubspot_file'],
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'HubSpot file ID to delete' }
      },
      required: ['fileId']
    }
  },
  {
    name: 'attach_file_to_record',
    category: 'Files',
    description: `Upload a file and attach it to a CRM record in one step.

This is a convenience tool that combines:
1. Uploading a file to HubSpot's file manager
2. Creating a note with the file attached
3. Associating the note with the specified record(s)

USE THIS WHEN:
- User says "attach this file to [contact/deal/company]"
- Adding a document, proposal, or contract to a record
- Uploading meeting notes or attachments to a contact

ACCEPTS EITHER:
- filePath: Local file path to upload
- fileUrl: Public URL to import

RETURNS: { fileId, noteId, fileName, associations }`,
    aliases: ['hubspot_attach_file', 'add_attachment_to_record'],
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Local file path to upload (use this OR fileUrl)' },
        fileUrl: { type: 'string', description: 'Public URL to import (use this OR filePath)' },
        noteBody: { type: 'string', maxLength: MAX_STRING_BODY_LENGTH, description: 'Optional note text to accompany the attachment' },
        associations: {
          type: 'object',
          description: 'Records to attach the file to (at least one required)',
          properties: {
            contactIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Contact IDs' },
            companyIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Company IDs' },
            dealIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Deal IDs' },
            ticketIds: { type: 'array', items: { type: 'string' }, maxItems: MAX_FAN_OUT, description: 'Ticket IDs' }
          }
        }
      },
      required: ['associations']
    }
  }
];

// Workflow Tools (v4 BETA API)
export const workflowTools: ToolMetadata[] = [
  {
    name: 'list_hubspot_workflows',
    category: 'Workflows',
    description: `List all automation workflows in HubSpot (v4 BETA API).

Returns workflow metadata: id, name, type, isEnabled, timestamps.
Use get_hubspot_workflow with the flow id for full structure (actions, triggers, branches).

RELATED TOOLS:
- get_hubspot_workflow (inspect one workflow)
- create_hubspot_workflow (create a workflow)
- update_hubspot_workflow (replace workflow configuration)
- activate_hubspot_workflow / deactivate_hubspot_workflow (toggle state)
- delete_hubspot_workflow (permanently delete)
- enrol_in_hubspot_workflow (enrol specific records)

REQUIRES: automation scope. If you get a 403 error, the user needs to reconnect HubSpot
(Settings → Connectors → HubSpot → Disconnect, then reconnect) to grant this scope.
Also requires Marketing Hub Professional or Enterprise.

NOTE: This uses the v4 Automation API which is in BETA — response shape may change.`,
    aliases: ['get_hubspot_workflows', 'hubspot_workflows'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max workflows to return (default: 100)' }
      }
    }
  },
  {
    name: 'get_hubspot_workflow',
    category: 'Workflows',
    description: `Get full workflow structure including actions, triggers, and branches (v4 BETA API).

Returns the complete workflow graph with:
- Enrollment criteria (triggers and conditions)
- Actions (each with actionTypeId, fields, and connection to next action)
- Branch logic

Useful for analyzing workflow structure and identifying potential issues.
Call list_hubspot_workflows first to discover available flow IDs.

RELATED TOOLS:
- create_hubspot_workflow (create new workflows)
- update_hubspot_workflow (replace workflow configuration)
- activate_hubspot_workflow / deactivate_hubspot_workflow (toggle workflow status)
- enrol_in_hubspot_workflow (manually enrol records)
- delete_hubspot_workflow (permanently delete workflow)

REQUIRES: automation scope (see list_hubspot_workflows for reconnection instructions).

NOTE: This is a BETA API — treat unknown fields cautiously as the response shape may change.`,
    aliases: ['get_workflow', 'get_workflow_details'],
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow/flow ID (from list_hubspot_workflows)' }
      },
      required: ['flowId']
    }
  },
  {
    name: 'create_hubspot_workflow',
    category: 'Workflows',
    description: `Create a new HubSpot workflow.

⚠️ BETA API — this uses the v4 Automation API. Endpoint behavior may change.

WORKFLOW TYPES:
- CONTACT_FLOW: Triggered by contact enrollment
- COMPANY_FLOW: Triggered by company enrollment
- DEAL_FLOW: Triggered by deal enrollment
- TICKET_FLOW: Triggered by ticket enrollment

EXAMPLE minimal workflow:
{
  "name": "New Lead Notification",
  "type": "CONTACT_FLOW"
}

To add actions and enrollment criteria, use the fields from get_hubspot_workflow
as a reference for the expected structure.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workflow name' },
        type: {
          type: 'string',
          enum: ['CONTACT_FLOW', 'COMPANY_FLOW', 'DEAL_FLOW', 'TICKET_FLOW'],
          description: 'Workflow type'
        },
        actions: {
          type: 'array',
          description: 'Optional workflow actions graph',
          items: {
            type: 'object',
            properties: {
              actionTypeId: { type: 'string', description: 'HubSpot workflow action type ID' },
              fields: { type: 'object', description: 'Action-specific fields', additionalProperties: true },
              connection: {
                type: 'object',
                properties: {
                  nextActionId: { type: 'string' },
                  edgeType: { type: 'string' }
                }
              }
            },
            required: ['actionTypeId']
          }
        },
        enrollmentCriteria: {
          type: 'object',
          description: 'Optional enrollment criteria configuration',
          additionalProperties: true
        }
      },
      required: ['name', 'type']
    }
  },
  {
    name: 'update_hubspot_workflow',
    category: 'Workflows',
    description: `Update a workflow via PUT (full replace semantics).

IMPORTANT: This endpoint behaves like a replacement update. Include all fields you
want to preserve (name/actions/enrollmentCriteria), not just changed fields.

Use get_hubspot_workflow first, then submit the updated full structure.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow ID to update' },
        name: { type: 'string', description: 'Workflow name' },
        actions: {
          type: 'array',
          description: 'Workflow actions graph',
          items: {
            type: 'object',
            properties: {
              actionTypeId: { type: 'string', description: 'HubSpot workflow action type ID' },
              fields: { type: 'object', description: 'Action-specific fields', additionalProperties: true },
              connection: {
                type: 'object',
                properties: {
                  nextActionId: { type: 'string' },
                  edgeType: { type: 'string' }
                }
              }
            },
            required: ['actionTypeId']
          }
        },
        enrollmentCriteria: {
          type: 'object',
          description: 'Enrollment criteria configuration',
          additionalProperties: true
        }
      },
      required: ['flowId']
    }
  },
  {
    name: 'delete_hubspot_workflow',
    category: 'Workflows',
    description: `Permanently delete a workflow.

WARNING: This is irreversible. The workflow and its history are removed.
Set confirm=true to acknowledge permanent deletion.`,
    annotations: { readOnlyHint: false, destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow ID to delete' },
        confirm: { type: 'boolean', description: 'Must be true to confirm permanent deletion' }
      },
      required: ['flowId', 'confirm']
    }
  },
  {
    name: 'activate_hubspot_workflow',
    category: 'Workflows',
    description: 'Activate a workflow (sets isEnabled to true).',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow ID to activate' }
      },
      required: ['flowId']
    }
  },
  {
    name: 'deactivate_hubspot_workflow',
    category: 'Workflows',
    description: 'Deactivate a workflow (sets isEnabled to false).',
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow ID to deactivate' }
      },
      required: ['flowId']
    }
  },
  {
    name: 'enrol_in_hubspot_workflow',
    category: 'Workflows',
    description: `Enrol specific records into a workflow.

Uses the v4 BETA enrollment endpoint. If you receive a 403/404, reconnect to refresh
automation scopes; if it still fails, your portal may require the v3 enrollment endpoint.`,
    annotations: { readOnlyHint: false, destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'Workflow ID to enrol into' },
        objectIds: {
          type: 'array',
          description: 'Record IDs to enrol',
          maxItems: MAX_FAN_OUT,
          items: { type: 'string' }
        },
        objectType: {
          type: 'string',
          description: 'Enrollment object type path segment (default: contacts)'
        }
      },
      required: ['flowId', 'objectIds']
    }
  }
];

// Export all tools
export const LOCAL_ONLY_TOOL_NAMES = [
  'list_hubspot_accounts',
  'remove_hubspot_account'
] as const;

export const AUTH_EXEMPT_TOOL_NAMES = [...LOCAL_ONLY_TOOL_NAMES] as const;

export const DESTRUCTIVE_TOOL_NAME_PATTERN = /^(create|update|delete|remove|send|configure|post|patch|put|enrol|activate|deactivate|attach|import)_/;

export const FORCE_DESTRUCTIVE_TOOL_NAMES = [
  'authenticate_hubspot_account',
  'complete_hubspot_auth',
  'remove_hubspot_account',
] as const;

const LOCAL_ONLY_TOOL_SET = new Set<string>(LOCAL_ONLY_TOOL_NAMES);
const AUTH_EXEMPT_TOOL_SET = new Set<string>(AUTH_EXEMPT_TOOL_NAMES);
const FORCE_DESTRUCTIVE_TOOL_SET = new Set<string>(FORCE_DESTRUCTIVE_TOOL_NAMES);

const BASE_TOOLS: ToolMetadata[] = [
  ...accountTools,
  ...contactTools,
  ...companyTools,
  ...dealTools,
  ...ticketTools,
  ...leadTools,
  ...taskTools,
  ...noteTools,
  ...associationTools,
  ...associationV4Tools,
  ...propertyTools,
  ...ownerTools,
  ...pipelineTools,
  ...engagementTools,
  ...productTools,
  ...lineItemTools,
  ...formsTools,
  ...analyticsTools,
  ...marketingEmailTools,
  ...listsTools,
  ...knowledgeBaseTools,
  ...fileTools,
  ...workflowTools
];

function applyCohortHygieneAnnotations(tool: ToolMetadata): ToolMetadata {
  const shouldForceDestructiveHint =
    DESTRUCTIVE_TOOL_NAME_PATTERN.test(tool.name) ||
    FORCE_DESTRUCTIVE_TOOL_SET.has(tool.name);
  const openWorldHint = !LOCAL_ONLY_TOOL_SET.has(tool.name);

  return {
    ...tool,
    requiresAuth: !AUTH_EXEMPT_TOOL_SET.has(tool.name),
    annotations: {
      ...tool.annotations,
      destructiveHint: shouldForceDestructiveHint ? true : tool.annotations?.destructiveHint,
      openWorldHint,
    },
  };
}

export const allTools: ToolMetadata[] = BASE_TOOLS.map(applyCohortHygieneAnnotations);
