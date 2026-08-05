/**
 * Field-level untrusted-content wrapping for TalentLMS payloads.
 *
 * AGENTS.md security invariant #6 requires every attacker-influenceable text
 * field returned by the API (course descriptions, user bios, group
 * descriptions, test/survey answers, user-authored names, custom fields) to
 * reach the model inside an `<untrusted-content>` envelope. TalentLMS payloads
 * also carry connector-essential metadata — ids, statuses, roles, timestamps,
 * scores, URLs — which the model must be able to copy verbatim into follow-up
 * tool calls (e.g. a user_id from list_talentlms_users into get_talentlms_user).
 * Wrapping those would break tool chaining, so this helper wraps ONLY the
 * known text fields below (plus dynamic `custom_field_*` keys, which are
 * account-defined free-text fields) and leaves everything else untouched.
 */

import { wrapUntrusted } from './untrusted-content.js';

const EXTERNAL_TEXT_KEYS = new Set([
  // user-authored identity/profile text
  'first_name',
  'last_name',
  'login',
  'email',
  'bio',
  // names/descriptions of courses, groups, branches, categories, units
  'name',
  'course_name',
  'description',
  'code',
  'key',
  // assessment text (questions and free-text answers)
  'question',
  'answer',
  'user_answer',
  'correct_answer',
  // tenant/instructor-authored settings text
  'site_name',
  'timezone',
  'language',
  'instructor',
  'location',
]);

/** Custom registration/course fields are account-defined free text: custom_field_1..20. */
const CUSTOM_FIELD_PREFIX = 'custom_field_';

function isExternalTextKey(key: string): boolean {
  return EXTERNAL_TEXT_KEYS.has(key) || key.startsWith(CUSTOM_FIELD_PREFIX);
}

/**
 * Recursively wrap the external-text fields of a TalentLMS API payload.
 * Non-string leaves and non-text keys pass through unchanged.
 */
export function wrapExternalTextFields<T>(value: T, source: string): T {
  if (Array.isArray(value)) {
    return value.map((item) => wrapExternalTextFields(item, source)) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isExternalTextKey(key) && typeof item === 'string'
          ? wrapUntrusted(item, source)
          : wrapExternalTextFields(item, source),
      ]),
    ) as T;
  }
  return value;
}
