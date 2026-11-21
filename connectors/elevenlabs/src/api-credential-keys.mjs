/** Headers the connector sets itself on every request, so no catalogue entry may leave one out. */
export const connectorHeaders = ['xi-api-key', 'content-type', 'content-length'];

export const credentialIdentifiers = new Set(['secret_id', 'auth_connection_id', 'credential_id']);
const credentialKey = /(?:authorization|api_?key|(?:^|_)(?:token|secret|password|credential)$|request_headers|request_meta|encrypted_value|^nonce$)/i;

/** @param {string} key */
export function isCredentialKey(key) {
  return !credentialIdentifiers.has(key) && credentialKey.test(key);
}
