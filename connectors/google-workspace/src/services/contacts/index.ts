import { google, people_v1 } from "googleapis";
import {
  BaseGoogleService,
  GoogleServiceError
} from "../base/BaseGoogleService.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describeApiError, isAuthHandoffError } from "../../utils/apiError.js";
import {
  GetContactsParams,
  GetContactsResponse,
  CreateContactParams,
  UpdateContactParams,
  ContactWriteFields,
  ContactWriteResult,
  ContactsError
} from "../../modules/contacts/types.js";
import { CONTACTS_SCOPES } from "../../modules/contacts/scopes.js";

// Type alias for the Google People API client
type PeopleApiClient = ReturnType<typeof google.people>;

/**
 * Contacts service implementation extending BaseGoogleService.
 * Handles Google Contacts (People API) specific operations.
 */
export class ContactsService extends BaseGoogleService<PeopleApiClient> {
  constructor() {
    super({
      serviceName: "people", // Use 'people' for the People API
      version: "v1"
    });
    // Initialize immediately or ensure initialized before first use
    this.initialize();
  }

  /**
   * Gets an authenticated People API client for the specified account.
   */
  private async getPeopleClient(email: string): Promise<PeopleApiClient> {
    // The clientFactory function tells BaseGoogleService how to create the specific client
    return this.getAuthenticatedClient(email, (auth) =>
      google.people({ version: "v1", auth })
    );
  }

  /**
   * Retrieves contacts for the specified user account.
   */
  async getContacts(params: GetContactsParams): Promise<GetContactsResponse> {
    const { email, pageSize, pageToken, personFields } = params;

    if (!personFields) {
      throw new ContactsError(
        "Missing required parameter: personFields",
        "INVALID_PARAMS",
        'Specify the fields to retrieve (e.g. "names,emailAddresses")'
      );
    }

    try {
      // Ensure necessary scopes are granted
      await this.validateScopes(email, [CONTACTS_SCOPES.READONLY]);

      const peopleApi = await this.getPeopleClient(email);

      const response = await peopleApi.people.connections.list({
        resourceName: "people/me", // 'people/me' refers to the authenticated user
        pageSize: pageSize,
        pageToken: pageToken,
        personFields: personFields,
        // requestSyncToken: true // Consider adding for sync capabilities later
      });

      // We might want to add more robust mapping/validation here
      // For now we assume the response structure matches GetContactsResponse
      // Note: googleapis types might use 'null' where we defined optional fields ('undefined')
      // Need to handle potential nulls if strict null checks are enabled
      return response.data as GetContactsResponse;
    } catch (error) {
      if (isAuthHandoffError(error)) throw error;
      // Handle known GoogleServiceError specifically
      if (error instanceof GoogleServiceError) {
        // Assuming GoogleServiceError inherits message and data from McpError
        // Use type assertion as the linter seems unsure
        const gError = error as McpError & {
          data?: { code?: string; details?: string };
        };
        throw new ContactsError(
          gError.message || "Error retrieving contacts", // Fallback message
          gError.data?.code || "GOOGLE_SERVICE_ERROR", // Code from data
          gError.data?.details // Details from data
        );
      }
      // Handle other potential errors (e.g. network errors)
      else if (error instanceof Error) {
        throw new ContactsError(
          `Failed to retrieve contacts: ${error.message}`,
          "UNKNOWN_API_ERROR" // More specific code
        );
      }
      // Handle non-Error throws
      else {
        throw new ContactsError(
          "Failed to retrieve contacts due to an unknown issue",
          "UNKNOWN_INTERNAL_ERROR" // More specific code
        );
      }
    }
  }

  /**
   * Search contacts using People API with warmup request per Google's best practices.
   * Warmup improves search accuracy by refreshing the server-side cache.
   */
  async searchContacts(params: {
    email: string;
    query: string;
    pageSize?: number;
    readMask?: string;
  }): Promise<{
    results: Array<{
      resourceName: string;
      name?: string;
      email?: string;
      phone?: string;
      organization?: string;
    }>;
    totalResults: number;
  }> {
    const { email, query, pageSize = 10, readMask = 'names,emailAddresses,phoneNumbers,organizations' } = params;

    try {
      await this.validateScopes(email, [CONTACTS_SCOPES.READONLY]);
      const peopleApi = await this.getPeopleClient(email);

      // Warmup request: Google recommends an empty query first to refresh cache
      // This improves search accuracy, especially for recently added contacts
      try {
        await peopleApi.people.searchContacts({
          query: '',
          readMask,
          pageSize: 1,
        });
      } catch {
        // Warmup failures are non-fatal - continue with actual search
      }

      // Actual search
      const response = await peopleApi.people.searchContacts({
        query,
        readMask,
        pageSize,
      });

      const results = (response.data.results || []).map(result => {
        const person = result.person;
        return {
          resourceName: person?.resourceName || '',
          name: person?.names?.[0]?.displayName || undefined,
          email: person?.emailAddresses?.[0]?.value || undefined,
          phone: person?.phoneNumbers?.[0]?.value || undefined,
          organization: person?.organizations?.[0]?.name || undefined,
        };
      });

      return {
        results,
        totalResults: results.length,
      };
    } catch (error) {
      if (isAuthHandoffError(error)) throw error;
      if (error instanceof GoogleServiceError) {
        const gError = error as McpError & { data?: { code?: string; details?: string } };
        throw new ContactsError(
          gError.message || 'Error searching contacts',
          gError.data?.code || 'GOOGLE_SERVICE_ERROR',
          gError.data?.details
        );
      } else if (error instanceof Error) {
        throw new ContactsError(
          `Failed to search contacts: ${error.message}`,
          'SEARCH_ERROR'
        );
      } else {
        throw new ContactsError(
          'Failed to search contacts due to an unknown issue',
          'UNKNOWN_ERROR'
        );
      }
    }
  }

  /**
   * Maps the flat write fields onto a People API Person request body.
   * Only provided fields are included; `updatePersonFields` mirrors that set
   * so an update replaces exactly the fields the caller sent.
   */
  private buildPersonRequestBody(fields: ContactWriteFields): {
    body: people_v1.Schema$Person;
    personFields: string[];
  } {
    const body: people_v1.Schema$Person = {};
    const personFields: string[] = [];

    if (fields.givenName !== undefined || fields.familyName !== undefined) {
      body.names = [{
        givenName: fields.givenName ?? '',
        familyName: fields.familyName ?? ''
      }];
      personFields.push('names');
    }
    if (fields.emailAddress !== undefined) {
      body.emailAddresses = [{
        value: fields.emailAddress,
        ...(fields.emailType && { type: fields.emailType })
      }];
      personFields.push('emailAddresses');
    }
    if (fields.phoneNumber !== undefined) {
      body.phoneNumbers = [{
        value: fields.phoneNumber,
        ...(fields.phoneType && { type: fields.phoneType })
      }];
      personFields.push('phoneNumbers');
    }
    if (fields.organization !== undefined || fields.jobTitle !== undefined) {
      body.organizations = [{
        name: fields.organization ?? '',
        title: fields.jobTitle ?? ''
      }];
      personFields.push('organizations');
    }
    if (fields.notes !== undefined) {
      body.biographies = [{ value: fields.notes, contentType: 'TEXT_PLAIN' }];
      personFields.push('biographies');
    }

    return { body, personFields };
  }

  private toWriteResult(person: people_v1.Schema$Person): ContactWriteResult {
    return {
      resourceName: person.resourceName || '',
      etag: person.etag || undefined,
      displayName: person.names?.[0]?.displayName || undefined,
      email: person.emailAddresses?.[0]?.value || undefined,
      phone: person.phoneNumbers?.[0]?.value || undefined,
      organization: person.organizations?.[0]?.name || undefined
    };
  }

  private wrapWriteError(error: unknown, action: string): ContactsError | Error {
    if (isAuthHandoffError(error) && error instanceof Error) return error;
    if (error instanceof GoogleServiceError) {
      const gError = error as McpError & { data?: { code?: string; details?: string } };
      return new ContactsError(
        gError.message || `Error ${action} contact`,
        gError.data?.code || 'GOOGLE_SERVICE_ERROR',
        gError.data?.details
      );
    }
    if (error instanceof Error) {
      return new ContactsError(`Failed to ${action} contact: ${describeApiError(error)}`, 'WRITE_ERROR');
    }
    return new ContactsError(`Failed to ${action} contact due to an unknown issue`, 'UNKNOWN_ERROR');
  }

  /**
   * Create a new contact via the People API.
   */
  async createContact(params: CreateContactParams): Promise<ContactWriteResult> {
    const { email, ...fields } = params;
    try {
      await this.validateScopes(email, [CONTACTS_SCOPES.CONTACTS]);
      const peopleApi = await this.getPeopleClient(email);
      const { body, personFields } = this.buildPersonRequestBody(fields);

      const response = await peopleApi.people.createContact({
        requestBody: body,
        personFields: personFields.join(',')
      });

      return this.toWriteResult(response.data);
    } catch (error) {
      throw this.wrapWriteError(error, 'create');
    }
  }

  /**
   * Update an existing contact via the People API. The People API requires the
   * contact's current etag, so it is fetched first; only the provided fields
   * are replaced (updatePersonFields semantics).
   */
  async updateContact(params: UpdateContactParams): Promise<ContactWriteResult> {
    const { email, resourceName, ...fields } = params;
    try {
      await this.validateScopes(email, [CONTACTS_SCOPES.CONTACTS]);
      const peopleApi = await this.getPeopleClient(email);
      const { body, personFields } = this.buildPersonRequestBody(fields);

      if (personFields.length === 0) {
        throw new ContactsError(
          'No fields to update',
          'INVALID_PARAMS',
          'Provide at least one field to change (e.g. phoneNumber or organization)'
        );
      }

      const current = await peopleApi.people.get({
        resourceName,
        personFields: 'names,emailAddresses,phoneNumbers,organizations,biographies'
      });

      const response = await peopleApi.people.updateContact({
        resourceName,
        updatePersonFields: personFields.join(','),
        personFields: personFields.join(','),
        requestBody: {
          ...body,
          etag: current.data.etag || undefined
        }
      });

      return this.toWriteResult(response.data);
    } catch (error) {
      if (error instanceof ContactsError) {
        throw error;
      }
      throw this.wrapWriteError(error, 'update');
    }
  }
}

// Optional: Export a singleton instance if needed by the module structure
// let contactsServiceInstance: ContactsService | null = null;
// export function getContactsService(): ContactsService {
//   if (!contactsServiceInstance) {
//     contactsServiceInstance = new ContactsService();
//   }
//   return contactsServiceInstance;
// }
