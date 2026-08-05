import { scopeRegistry } from "../../modules/tools/scope-registry.js";

// Define Contacts scopes as constants
// Reference: https://developers.google.com/people/api/rest/v1/people.connections/list (and other People API docs)
export const CONTACTS_SCOPES = {
  READONLY: "https://www.googleapis.com/auth/contacts.readonly",
  // Full contacts access (read + write); required for people.createContact / people.updateContact
  CONTACTS: "https://www.googleapis.com/auth/contacts"
};

// Register the contacts scopes with the scope registry
scopeRegistry.registerScope("contacts", CONTACTS_SCOPES.READONLY);
