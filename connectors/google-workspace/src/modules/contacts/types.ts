/**
 * Parameters for retrieving contacts.
 */
export interface GetContactsParams {
  email: string; // The user account email
  pageSize?: number; // Max number of contacts to return
  pageToken?: string; // Token for pagination
  // Add other parameters like sortOrder, syncToken if needed later
  personFields: string; // Required: Fields to request e.g. 'names,emailAddresses,phoneNumbers'
}

/**
 * Response structure for getting contacts.
 */
export interface GetContactsResponse {
  connections: Contact[];
  nextPageToken?: string;
  totalPeople?: number;
  totalItems?: number; // Deprecated
}

/**
 * Represents a Google Contact (Person).
 * Based on People API Person resource.
 * Reference: https://developers.google.com/people/api/rest/v1/people#Person
 */
export interface Contact {
  resourceName: string;
  etag?: string;
  names?: Name[];
  emailAddresses?: EmailAddress[];
  phoneNumbers?: PhoneNumber[];
  // Add other fields as needed (e.g. photos, addresses, organizations, etc.)
}

// --- Sub-types based on People API ---

export interface Name {
  displayName?: string;
  familyName?: string;
  givenName?: string;
  // ... other name fields
}

export interface EmailAddress {
  value?: string;
  type?: string; // e.g. 'home', 'work'
  formattedType?: string;
  // ... other email fields
}

export interface PhoneNumber {
  value?: string;
  canonicalForm?: string;
  type?: string; // e.g. 'mobile', 'home', 'work'
  formattedType?: string;
  // ... other phone fields
}

/**
 * Base error class for Contacts service.
 */
export class ContactsError extends Error {
  code: string;
  details?: string;

  constructor(message: string, code: string, details?: string) {
    super(message);
    this.name = "ContactsError";
    this.code = code;
    this.details = details;
  }
}
