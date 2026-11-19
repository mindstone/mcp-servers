/**
 * Envelope-wrapping for everything Humaans returns to the model (AGENTS.md
 * security invariant #6).
 *
 * `envelopeStrings` wraps every string, at any depth, in an untrusted-content
 * envelope, including fields Humaans adds later. The only strings left raw are
 * the structured tokens in RAW_FIELDS, and only when the value passes that
 * field's validator: the model needs them byte-for-byte to pass back as tool
 * inputs, and an envelope copied into a parameter would change the value. A
 * value that fails its validator is wrapped like any other text.
 *
 * Keys are treated the same way: only the Humaans field names in KNOWN_KEYS
 * stay raw; any other key is enveloped and shown as `?` in source paths.
 *
 * Authored text stays wrapped even when it looks like a token: names, labels,
 * notes, `contractType` and `employeeId` (both set by the company), location
 * ids, colours and every field not listed here.
 */
import { z } from 'zod';
import { wrapUntrusted } from './untrusted-content.js';

// A Humaans resource id, e.g. "VMB1yzL5uL8VvNNCJc9rykJz".
const resourceId = z.string().regex(/^[A-Za-z0-9]{1,64}$/);

// A calendar date (YYYY-MM-DD) or an ISO 8601 timestamp.
const dateOrTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);

const email = z.string().max(254).email();

// An IANA time zone name the runtime recognises, e.g. "Europe/London".
const timezone = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9/_+-]{0,63}$/)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });

/**
 * Every field that may stay raw, with its validator and the tool inputs that
 * consume it. Matched by exact key at any depth (e.g. `timeAwayType.id`).
 */
const RAW_FIELDS = new Map<string, z.ZodType<string>>([
  // personId (get_humaans_person, list_humaans_job_roles, the time away tools),
  // jobRoleId (get_humaans_job_role), timeAwayId (cancel/approve/decline),
  // timeAwayTypeId (create_humaans_time_away)
  ['id', resourceId],
  // personId filters and create_humaans_time_away.personId
  ['personId', resourceId],
  ['companyId', resourceId],
  // a manager's person id: get_humaans_person.personId
  ['reportingTo', resourceId],
  // a time away entry's requester and reviewer: get_humaans_person.personId
  ['requestedBy', resourceId],
  ['reviewedBy', resourceId],
  // create_humaans_time_away.timeAwayTypeId
  ['timeAwayTypeId', resourceId],
  // startDateAfter / startDateBefore / asOf / create_humaans_time_away dates
  ['startDate', dateOrTimestamp],
  ['endDate', dateOrTimestamp],
  ['effectiveDate', dateOrTimestamp],
  ['employmentStartDate', dateOrTimestamp],
  ['employmentEndDate', dateOrTimestamp],
  ['reviewedAt', dateOrTimestamp],
  ['createdAt', dateOrTimestamp],
  ['updatedAt', dateOrTimestamp],
  // list_humaans_people.email
  ['email', email],
  ['timezone', timezone],
  // list_humaans_people.status / list_humaans_teams.status
  ['status', z.enum(['active', 'offboarded', 'newHire'])],
  // list_humaans_time_away.requestStatus
  ['requestStatus', z.enum(['pending', 'approved', 'declined'])],
  // create_humaans_time_away.startPeriod / endPeriod
  ['startPeriod', z.enum(['full', 'am', 'pm'])],
  ['endPeriod', z.enum(['full', 'am'])],
  // a time away allocation's type
  ['type', z.enum(['specific', 'placeOfWork'])],
]);

/**
 * The Humaans field names this connector knows, the only keys kept raw. Every
 * other key, whatever its spelling, is vendor data: it is enveloped, and its
 * place in a source path is the fixed placeholder `?`. Drawn from `types.ts`,
 * the response schemas, the test fixtures, and the person, job role, company
 * and time away objects in the Humaans API reference (docs.humaans.io/api,
 * checked 2026-11-19). Not exhaustive: a key Humaans documents elsewhere or
 * adds later is enveloped like any unknown key.
 */
const KNOWN_KEYS: ReadonlySet<string> = new Set([
  ...RAW_FIELDS.keys(),
  // person (PersonCompact, the compact list shape and the full profile)
  'firstName', 'middleName', 'lastName', 'preferredName', 'contractType',
  'employeeId', 'teams', 'locationId', 'jobRole', 'jobTitle', 'department',
  'bio', 'phoneNumber', 'formattedPhoneNumber', 'spokenLanguages',
  'workingDays', 'remoteCity', 'remoteState', 'remoteRegionCode',
  'remoteCountryCode', 'firstWorkingDay', 'lastWorkingDay', 'probationEndDate',
  'spaceId', 'remoteTimezone', 'linkedIn', 'twitter', 'github', 'isManager',
  'isVerified', 'isWorkEmailHidden', 'publicHolidayCalendarId', 'leavingReason',
  'leavingNote', 'source', 'payrollProvider', 'turnoverImpact',
  // workingDays items
  'day',
  // person fields get_humaans_person strips; known, so a stray nested copy is
  // still labelled by name
  'calendarFeedToken', 'taxId', 'taxCode', 'personalEmail',
  'personalPhoneNumber', 'formattedPersonalPhoneNumber', 'birthday', 'address',
  'city', 'state', 'postcode', 'countryCode', 'profilePhoto', 'profilePhotoId',
  'nationality', 'nationalities', 'gender', 'dietaryPreference', 'foodAllergies',
  'shortBirthday',
  // job role
  'note', 'jobLibraryProfileId', 'jobLibraryLevelId', 'jobLibraryLevelCode',
  'jobLibraryLevelGrade', 'jobLibraryLevelName', 'jobLibraryLevelTrack',
  'deletedAt',
  // location and company
  'label', 'country', 'name', 'trialEndDate', 'timesheetEnabled',
  'paymentStatus', 'logo',
  // time away, its types, allocations and cancellation result
  'timeAwayType', 'days', 'reviewNote', 'color', 'timeAwayPolicyId',
  'timeAwayPolicy', 'deleted', 'startTime', 'endTime', 'isTimeOff',
  'workingFromLocationId',
  // time away breakdown items
  'breakdown', 'date', 'period', 'weekend', 'holiday',
]);

function isRawToken(key: string | undefined, value: string): boolean {
  if (key === undefined) return false;
  const validator = RAW_FIELDS.get(key);
  return validator !== undefined && validator.safeParse(value).success;
}

function walk(value: unknown, source: string, path: string, key: string | undefined): unknown {
  if (typeof value === 'string') {
    if (isRawToken(key, value)) return value;
    return wrapUntrusted(value, path ? `${source}:${path}` : source);
  }
  if (Array.isArray(value)) {
    // Array items share the array's key and path, so `teams[].name` is `teams.name`.
    return value.map((item) => walk(item, source, path, undefined));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, item]) => {
        const known = KNOWN_KEYS.has(k);
        const outKey = known ? k : (wrapUntrusted(k, `${source}:key`) ?? k);
        const segment = known ? k : '?';
        const childPath = path ? `${path}.${segment}` : segment;
        return [outKey, walk(item, source, childPath, known ? k : undefined)];
      }),
    );
  }
  return value;
}

/**
 * Wrap every string in `value`, at any depth, except a validated structured
 * token in RAW_FIELDS. Source labels are `<source>:<dotted.path>`.
 */
export function envelopeStrings(value: unknown, source: string): unknown {
  return walk(value, source, '', undefined);
}
