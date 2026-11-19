import { describe, expect, it } from 'vitest';
import {
  GraphRequestTargetError,
  graphDrivePath,
  graphIdSegment,
  graphQueryValue,
  graphSiteId,
  graphUserSegment,
  odataStringLiteral,
} from '../src/graph-request-target.js';

function refusal(fn: () => unknown): GraphRequestTargetError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(GraphRequestTargetError);
    return err as GraphRequestTargetError;
  }
  throw new Error('expected a GraphRequestTargetError');
}

const HOSTILE_IDS = [
  '',
  '..',
  '.',
  '../../users/victim',
  'abc/../def',
  'abc/./def',
  'abc?$select=id',
  'abc#frag',
  'abc%2e%2e',
  '%2e%2e',
  'abc\\def',
  'abc\r\nHost: x',
  'abc\u0000',
  'abc\u007f',
];

describe('graphIdSegment', () => {
  it.each(HOSTILE_IDS)('refuses %j', (value) => {
    const err = refusal(() => graphIdSegment(value, 'id', 'list_things'));
    expect(err.field).toBe('id');
    expect(err.nextStep).toBe('list_things');
  });

  it('refuses non-strings', () => {
    refusal(() => graphIdSegment(undefined, 'id', 'list_things'));
    refusal(() => graphIdSegment(42, 'id', 'list_things'));
  });

  it.each([
    ['AAMkAGI2THVSAAA=', 'AAMkAGI2THVSAAA%3D'],
    ['AAMk+AG/I2_x-y=', 'AAMk%2BAG%2FI2_x-y%3D'],
    ['19:abc123@thread.v2', '19%3Aabc123%40thread.v2'],
    ['19:a1b2_c3d4@unq.gbl.spaces', '19%3Aa1b2_c3d4%40unq.gbl.spaces'],
    ['1700000000000', '1700000000000'],
    ['b!abc-DEF_123', 'b!abc-DEF_123'],
    ['Project Tasks', 'Project%20Tasks'],
    ['01ABCDEF2GHIJKL', '01ABCDEF2GHIJKL'],
    ['...', '...'],
  ])('encodes %j as %j', (value, expected) => {
    expect(graphIdSegment(value, 'id', 'list_things')).toBe(expected);
  });

  it('never echoes the refused value in the error', () => {
    const hostile = 'zz-hostile-marker/../../users?$select=secret';
    const err = refusal(() => graphIdSegment(hostile, 'messageId', 'list_things'));
    expect(err.message).not.toContain('zz-hostile-marker');
    expect(err.message).not.toContain('secret');
    expect(err.actionRequired).not.toContain('zz-hostile-marker');
    expect(err.message).toContain('"messageId"');
  });
});

describe('graphUserSegment', () => {
  it.each([
    ['jane@example.com', 'jane%40example.com'],
    ['jane_example.com#EXT#@tenant.example', 'jane_example.com%23EXT%23%40tenant.example'],
    ['8f2b3c4d-1111-2222-3333-444455556666', '8f2b3c4d-1111-2222-3333-444455556666'],
  ])('encodes %j as %j', (value, expected) => {
    expect(graphUserSegment(value, 'userId', 'search_users')).toBe(expected);
  });

  it.each(['', '.', '..', 'a/b', '../me', 'a?b', 'a%40b', 'a\\b', 'a\nb'])('refuses %j', (value) => {
    refusal(() => graphUserSegment(value, 'userId', 'search_users'));
  });
});

describe('graphDrivePath', () => {
  it.each([
    ['/', ''],
    ['', ''],
    ['/Documents', '/Documents'],
    ['/Documents/Q3 Report.docx', '/Documents/Q3%20Report.docx'],
    ['//Documents//a.txt', '/Documents/a.txt'],
    ['/Docs/a#b.txt', '/Docs/a%23b.txt'],
    ['/Docs/50%.xlsx', '/Docs/50%25.xlsx'],
    ['/Docs/%2e%2e', '/Docs/%252e%252e'],
    ['/Docs/what?.txt', '/Docs/what%3F.txt'],
    ["/Jane's Files/notes.txt", "/Jane's%20Files/notes.txt"],
    ['/Docs/résumé – 日本.txt', `/Docs/${encodeURIComponent('résumé – 日本.txt')}`],
    ['/Docs/a:b', '/Docs/a%3Ab'],
  ])('encodes %j as %j', (value, expected) => {
    expect(graphDrivePath(value, 'path', 'list_files')).toBe(expected);
  });

  it.each(['/..', '/Docs/../../x', '/./a', '/a\\b', '/a\nb', '/a\u0000'])('refuses %j', (value) => {
    refusal(() => graphDrivePath(value, 'path', 'list_files'));
  });
});

describe('graphSiteId', () => {
  it('encodes the opaque host,guid,guid form as one segment', () => {
    expect(
      graphSiteId(
        'acme.sharepoint.com,2c712604-1370-44e7-a1f5-426573fdc3c8,2d2244e3-7ba1-4b5d-a6a9-1f0d1e2a3b4c',
        'siteId',
        'list_sites',
      ),
    ).toBe(
      'acme.sharepoint.com%2C2c712604-1370-44e7-a1f5-426573fdc3c8%2C2d2244e3-7ba1-4b5d-a6a9-1f0d1e2a3b4c',
    );
  });

  it.each([
    ['root', 'root'],
    ['acme.sharepoint.com', 'acme.sharepoint.com'],
    ['acme.sharepoint.com:/sites/marketing', 'acme.sharepoint.com:/sites/marketing:'],
    ['acme.sharepoint.com:/sites/marketing:', 'acme.sharepoint.com:/sites/marketing:'],
    ['acme.sharepoint.com:/teams/Team Site', 'acme.sharepoint.com:/teams/Team%20Site:'],
  ])('accepts %j as %j', (value, expected) => {
    expect(graphSiteId(value, 'siteId', 'list_sites')).toBe(expected);
  });

  it.each([
    '',
    '..',
    'a/b',
    'a,b?x=1',
    'acme.sharepoint.com:/sites/../../users',
    'acme.sharepoint.com:sites/x',
    'acme.sharepoint.com:/',
    'acme.sharepoint.com:/sites/x:/lists',
    'evil host:/sites/x',
    'acme.sharepoint.com/x:/sites/y',
    'acme.sharepoint.com:/sites/x#y',
    'acme.sharepoint.com:/sites/x%2F',
  ])('refuses %j', (value) => {
    refusal(() => graphSiteId(value, 'siteId', 'list_sites'));
  });
});

describe('odataStringLiteral', () => {
  it('doubles single quotes and encodes the rest', () => {
    expect(odataStringLiteral("x' or 1 eq 1")).toBe("'x''%20or%201%20eq%201'");
  });

  it('keeps a percent-encoded quote literal', () => {
    expect(odataStringLiteral('x%27 or true')).toBe("'x%2527%20or%20true'");
  });

  it('cannot add query keys', () => {
    const literal = odataStringLiteral("a&$select=id#x");
    expect(literal).not.toMatch(/[&#]/);
    expect(literal).toBe("'a%26%24select%3Did%23x'");
  });
});

describe('graphQueryValue', () => {
  it('encodes a filter as a single query value', () => {
    expect(graphQueryValue("isRead eq false&$select=body")).toBe(
      'isRead%20eq%20false%26%24select%3Dbody',
    );
  });
});
