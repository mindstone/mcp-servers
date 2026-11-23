/** Headers the connector sets itself on every request, so no catalogue entry may leave one out. */
export const connectorHeaders = ['xi-api-key', 'content-type', 'content-length'];

export const credentialIdentifiers = new Set(['secret_id', 'variable_name', 'env_var_label', 'auth_connection_id', 'credential_id', 'workspace_api_key_id']);
const continuationIdentifier = /^(?:(?:next_|previous_)?(?:page_)?(?:token|cursor)|continuation_?token|(?:last|start_after|starting_after|ending_before)_.+_id)$/i;
const credentialKey = /(?:authorization|api_?key|(?:^|_)(?:token|secret|password|credential)$|request_headers|request_meta|encrypted_value|^nonce$)/i;

/** @param {string} key */
export function isCredentialKey(key) {
  return !credentialIdentifiers.has(key) && !(key !== 'token' && continuationIdentifier.test(key)) && credentialKey.test(key);
}

/**
 * A signed link is a bearer credential: masked unless the operation declares it as an intended return.
 * The generator declares schema-declared ones by this same rule, so both sides agree.
 * @param {string} key
 */
export function isSignedLinkKey(key) {
  return /url$/i.test(key) && /(?:^|_)signed(?:_|$)/i.test(key);
}
