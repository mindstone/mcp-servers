import {
  GetContactsParams,
  GetContactsResponse
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
