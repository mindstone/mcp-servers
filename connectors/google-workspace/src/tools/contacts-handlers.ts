import {
  GetContactsParams,
  GetContactsResponse,
  CreateContactParams,
  ContactWriteResult
} from "../modules/contacts/types.js";
import { ContactsService } from "../services/contacts/index.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { toMcpError } from "../utils/apiError.js";
import { getAccountManager, resolveEmail } from "../modules/accounts/index.js";
import {
  readAliasedBoolean,
  readAliasedNumber,
  readAliasedString
} from './arg-aliases.js';
import { wrapUntrustedContent, wrapUntrustedJsonStrings } from "../utils/untrusted-content.js";

// Singleton instances - Initialize or inject as per project pattern
let contactsService: ContactsService;
let accountManager: ReturnType<typeof getAccountManager>;

/**
 * Initialize required services.
 * This should likely be integrated into a central initialization process.
 */
async function initializeServices() {
  if (!contactsService) {
    // Assuming ContactsService has a static getInstance or similar
    // or needs to be instantiated here. Using direct instantiation for now.
    contactsService = new ContactsService();
    // If ContactsService requires async initialization await it here.
    // await contactsService.initialize();
  }

  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

/**
 * Handler function for retrieving Google Contacts.
 */
export async function handleGetContacts(
  params: GetContactsParams & Record<string, unknown>
): Promise<GetContactsResponse> {
  await initializeServices(); // Ensure services are ready
  const personFields = readAliasedString(params, 'person_fields', 'personFields');
  const pageSize = readAliasedNumber(params, 'page_size', 'pageSize');
  const pageToken = readAliasedString(params, 'page_token', 'pageToken');
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!personFields) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'person_fields parameter is required (e.g. "names,emailAddresses")'
    );
  }

  // Use accountManager for token renewal like in Gmail handlers
  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await contactsService.getContacts({
        email,
        personFields,
        pageSize,
        pageToken
      });
      return wrapUntrustedJsonStrings(result, 'google-workspace:contacts:list');
    } catch (error) {
      // toMcpError passes an McpError through, and folds a ContactsError's details into
      // the message (InternalError) so the real cause reaches the user — the host drops
      // an McpError's `data` arg, so details-as-data (the old shape) were invisible.
      throw toMcpError(error, 'Failed to get contacts');
    }
  });
}

interface SearchContactsParams {
  email?: string;
  query: string;
  max_results?: number;  // snake_case (canonical per MCP convention)
  maxResults?: number;   // camelCase (backwards compatible)
  return_json?: boolean;
  returnJson?: boolean;
}

// Format contacts as human-readable text
export function formatContactsAsText(results: Array<{ resourceName: string; name?: string; email?: string; phone?: string; organization?: string }>, totalResults: number): string {
  if (results.length === 0) {
    return 'No contacts found matching your search.';
  }

  const lines: string[] = [];
  lines.push(`Found ${totalResults} contact${totalResults !== 1 ? 's' : ''}:\n`);

  results.forEach((contact, i) => {
    const name = contact.name || '(no name)';
    const contactEmail = contact.email || '(no email)';
    const phone = contact.phone ? ` | Phone: ${contact.phone}` : '';
    const org = contact.organization ? ` | ${contact.organization}` : '';
    
    lines.push(`${i + 1}. **${name}**`);
    lines.push(`   Email: ${contactEmail}${phone}${org}`);
    lines.push(`   [resourceName: ${contact.resourceName}]`);
    lines.push('');
  });

  return wrapUntrustedContent(lines.join('\n'), 'google-workspace:contacts:search');
}

/**
 * Handler function for searching Google Contacts.
 * Uses People API search with warmup request per Google's best practices.
 */
export async function handleSearchContacts(
  params: SearchContactsParams
): Promise<string | { results: Array<{ resourceName: string; name?: string; email?: string; phone?: string; organization?: string }>; totalResults: number }> {
  await initializeServices();
  const rawParams = params as unknown as Record<string, unknown>;
  const maxResults = readAliasedNumber(rawParams, 'max_results', 'maxResults') ?? 10;
  const returnJson = readAliasedBoolean(rawParams, 'return_json', 'returnJson') ?? false;
  const { query } = params;
  
  // Resolve email - uses instance account if not provided, validates if provided
  const email = await resolveEmail(params);

  if (!query) {
    throw new McpError(ErrorCode.InvalidParams, "Search query is required");
  }

  // Cap results at 30 (People API limit for searchContacts)
  const pageSize = Math.min(maxResults, 30);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await contactsService.searchContacts({
        email,
        query,
        pageSize,
      });
      
      if (returnJson) {
        return wrapUntrustedJsonStrings(result, 'google-workspace:contacts:search');
      }
      return formatContactsAsText(result.results, result.totalResults);
    } catch (error) {
      // See handleGetContacts: toMcpError surfaces the real cause (details folded into
      // the message) and passes an McpError through unchanged.
      throw toMcpError(error, 'Failed to search contacts');
    }
  });
}

// Snake_case param names (canonical) with camelCase aliases for compatibility.
export interface ContactWriteToolParams {
  email?: string;
  given_name?: string;
  givenName?: string;
  family_name?: string;
  familyName?: string;
  email_address?: string;
  emailAddress?: string;
  email_type?: string;
  emailType?: string;
  phone_number?: string;
  phoneNumber?: string;
  phone_type?: string;
  phoneType?: string;
  organization?: string;
  job_title?: string;
  jobTitle?: string;
  notes?: string;
}

// Contact resource names follow the documented "people/<id>" form.
const CONTACT_RESOURCE_NAME_PATTERN = /^people\/[^/\s]+$/;
// Deliberately permissive email shape check — the People API is the authority;
// this only catches clearly-malformed values before a network round-trip.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Phone values are free-form upstream, but must contain at least one digit.
const MAX_PHONE_LENGTH = 64;

function readContactWriteFields(params: ContactWriteToolParams): Omit<CreateContactParams, 'email'> {
  const raw = params as unknown as Record<string, unknown>;
  return {
    givenName: readAliasedString(raw, 'given_name', 'givenName'),
    familyName: readAliasedString(raw, 'family_name', 'familyName'),
    emailAddress: readAliasedString(raw, 'email_address', 'emailAddress'),
    emailType: readAliasedString(raw, 'email_type', 'emailType'),
    phoneNumber: readAliasedString(raw, 'phone_number', 'phoneNumber'),
    phoneType: readAliasedString(raw, 'phone_type', 'phoneType'),
    organization: readAliasedString(raw, 'organization', 'organization'),
    jobTitle: readAliasedString(raw, 'job_title', 'jobTitle'),
    notes: readAliasedString(raw, 'notes', 'notes')
  };
}

function validateContactWriteFields(fields: Omit<CreateContactParams, 'email'>): void {
  if (fields.emailAddress !== undefined && !EMAIL_PATTERN.test(fields.emailAddress)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'email_address must be a valid email address (e.g. "jane@example.com")'
    );
  }
  if (fields.phoneNumber !== undefined
    && (fields.phoneNumber.length > MAX_PHONE_LENGTH || !/\d/.test(fields.phoneNumber))) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'phone_number must contain at least one digit and be at most 64 characters'
    );
  }
}

function hasAnyWriteField(fields: Omit<CreateContactParams, 'email'>): boolean {
  return Object.values(fields).some(value => value !== undefined);
}

function formatWriteResult(action: string, result: ContactWriteResult): unknown {
  // Every string field is enveloped, matching the read handlers' whole-result wrapping.
  return wrapUntrustedJsonStrings(
    { status: 'success', action, contact: result },
    'google-workspace:contacts:write'
  );
}

/**
 * Handler for creating a new Google Contact.
 */
export async function handleCreateContact(
  params: ContactWriteToolParams
): Promise<unknown> {
  await initializeServices();
  const email = await resolveEmail(params);
  const fields = readContactWriteFields(params);
  validateContactWriteFields(fields);

  if (!hasAnyWriteField(fields)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Provide at least one contact field (e.g. given_name, email_address, phone_number)'
    );
  }
  if (!fields.givenName && !fields.familyName && !fields.emailAddress) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'A new contact needs at least a name (given_name / family_name) or an email_address'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await contactsService.createContact({ email, ...fields });
      return formatWriteResult('created', result);
    } catch (error) {
      throw toMcpError(error, 'Failed to create contact');
    }
  });
}

/**
 * Handler for updating an existing Google Contact. Only the provided fields
 * are replaced; everything else on the contact is left untouched.
 */
export async function handleUpdateContact(
  params: ContactWriteToolParams & { resource_name?: string; resourceName?: string }
): Promise<unknown> {
  await initializeServices();
  const email = await resolveEmail(params);
  const raw = params as unknown as Record<string, unknown>;
  const resourceName = readAliasedString(raw, 'resource_name', 'resourceName');
  const fields = readContactWriteFields(params);
  validateContactWriteFields(fields);

  if (!resourceName || !CONTACT_RESOURCE_NAME_PATTERN.test(resourceName)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'resource_name is required in the form "people/c1234567890" — get it from search_workspace_contacts'
    );
  }
  if (!hasAnyWriteField(fields)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Provide at least one field to update (e.g. phone_number, organization, notes)'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await contactsService.updateContact({ email, resourceName, ...fields });
      return formatWriteResult('updated', result);
    } catch (error) {
      throw toMcpError(error, 'Failed to update contact');
    }
  });
}
