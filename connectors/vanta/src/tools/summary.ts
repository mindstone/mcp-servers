import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';

const MAX_SUMMARY_PAGES = 5;
const SUMMARY_PAGE_SIZE = 100;
const MAX_SUMMARY_TESTS = MAX_SUMMARY_PAGES * SUMMARY_PAGE_SIZE;
const UNKNOWN_FRAMEWORK = 'Unspecified';

interface FrameworkSummary {
  total: number;
  pass: number;
  fail: number;
  disabled: number;
  other: number;
}

export const complianceSummarySchema = z.object({
  framework: z.string().optional().describe('Filter summary to one framework, such as SOC2, ISO27001, or HIPAA'),
});

export type ComplianceSummaryArgs = z.infer<typeof complianceSummarySchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringField = (value: unknown, fields: string[]): string | undefined => {
  if (!isRecord(value)) return undefined;
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
};

const createFrameworkSummary = (): FrameworkSummary => ({
  total: 0,
  pass: 0,
  fail: 0,
  disabled: 0,
  other: 0,
});

const addTestToSummary = (
  frameworks: Record<string, FrameworkSummary>,
  test: unknown,
  frameworkFilter: string | undefined,
): boolean => {
  const frameworkName = readStringField(test, ['framework', 'frameworkName']) ?? UNKNOWN_FRAMEWORK;
  if (frameworkFilter && frameworkName !== frameworkFilter) {
    return false;
  }

  const status = (readStringField(test, ['status', 'result', 'testStatus']) ?? 'OTHER').toUpperCase();
  const frameworkSummary = frameworks[frameworkName] ?? createFrameworkSummary();
  frameworkSummary.total++;

  if (status === 'PASS' || status === 'PASSED') {
    frameworkSummary.pass++;
  } else if (status === 'FAIL' || status === 'FAILED') {
    frameworkSummary.fail++;
  } else if (status === 'DISABLED') {
    frameworkSummary.disabled++;
  } else {
    frameworkSummary.other++;
  }

  frameworks[frameworkName] = frameworkSummary;
  return true;
};

export async function vantaGetComplianceSummary(
  client: VantaApiClient,
  args: ComplianceSummaryArgs,
): Promise<string> {
  try {
    const frameworks: Record<string, FrameworkSummary> = {};
    let pageCursor: string | undefined;
    let totalTests = 0;
    let partial = false;

    for (let page = 0; page < MAX_SUMMARY_PAGES && totalTests < MAX_SUMMARY_TESTS; page++) {
      const result = await client.getPaginated('/v1/tests', {
        framework: args.framework,
        page_size: SUMMARY_PAGE_SIZE,
        page_cursor: pageCursor,
      });
      const remaining = MAX_SUMMARY_TESTS - totalTests;
      const tests = result.data.slice(0, remaining);

      for (const test of tests) {
        if (addTestToSummary(frameworks, test, args.framework)) {
          totalTests++;
        }
      }
      if (result.data.length > remaining) {
        partial = true;
        break;
      }

      if (!result.pageInfo.hasNextPage) {
        break;
      }

      pageCursor = result.pageInfo.endCursor ?? undefined;
      if (!pageCursor) {
        partial = true;
        break;
      }

      if (page === MAX_SUMMARY_PAGES - 1) {
        partial = true;
      }
    }

    const summary: Record<string, unknown> = {
      frameworks,
      totalTests,
      passRate: totalTests === 0
        ? 0
        : Object.values(frameworks).reduce((sum, framework) => sum + framework.pass, 0) / totalTests,
    };

    if (partial) {
      summary.partial = true;
      summary.note = `Summary based on first ${totalTests} tests`;
    }

    return stringifyToolResult({
      ok: true,
      summary,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
