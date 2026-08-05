import { z } from 'zod';

import { stringifyToolResult, toToolErrorResponse, type VantaApiClient } from '../api.js';
import { sanitizeExternalText } from '../sanitize.js';

const MAX_SUMMARY_PAGES = 5;
const SUMMARY_PAGE_SIZE = 100;

interface FrameworkSummary {
  id?: string;
  displayName?: string;
  shorthandName?: string;
  controlsCompleted: number;
  controlsTotal: number;
  controlsIncomplete: number;
  documentsPassing: number;
  documentsTotal: number;
  documentsFailing: number;
  testsPassing: number;
  testsTotal: number;
  testsFailing: number;
  testPassRate: number;
}

export const complianceSummarySchema = z.object({
  framework: z.string().optional().describe('Filter summary to one framework, such as SOC2, ISO27001, or HIPAA'),
});

export type ComplianceSummaryArgs = z.infer<typeof complianceSummarySchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStringField = (value: Record<string, unknown>, fields: string[]): string | undefined => {
  for (const field of fields) {
    const candidate = value[field];
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate;
    }
  }
  return undefined;
};

const readNumberField = (value: Record<string, unknown>, field: string): number => {
  const candidate = value[field];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 0;
};

const matchesFramework = (framework: Record<string, unknown>, filter: string | undefined): boolean => {
  if (!filter) return true;
  const normalizedFilter = filter.trim().toLowerCase();
  return ['id', 'displayName', 'shorthandName'].some((field) => {
    const value = framework[field];
    return typeof value === 'string' && value.trim().toLowerCase() === normalizedFilter;
  });
};

const summarizeFramework = (framework: Record<string, unknown>): FrameworkSummary => {
  const controlsCompleted = readNumberField(framework, 'numControlsCompleted');
  const controlsTotal = readNumberField(framework, 'numControlsTotal');
  const documentsPassing = readNumberField(framework, 'numDocumentsPassing');
  const documentsTotal = readNumberField(framework, 'numDocumentsTotal');
  const testsPassing = readNumberField(framework, 'numTestsPassing');
  const testsTotal = readNumberField(framework, 'numTestsTotal');

  return {
    id: readStringField(framework, ['id']),
    displayName: readStringField(framework, ['displayName']),
    shorthandName: readStringField(framework, ['shorthandName']),
    controlsCompleted,
    controlsTotal,
    controlsIncomplete: Math.max(controlsTotal - controlsCompleted, 0),
    documentsPassing,
    documentsTotal,
    documentsFailing: Math.max(documentsTotal - documentsPassing, 0),
    testsPassing,
    testsTotal,
    testsFailing: Math.max(testsTotal - testsPassing, 0),
    testPassRate: testsTotal === 0 ? 0 : testsPassing / testsTotal,
  };
};

export async function vantaGetComplianceSummary(
  client: VantaApiClient,
  args: ComplianceSummaryArgs,
): Promise<string> {
  try {
    const frameworks: Record<string, FrameworkSummary> = {};
    let pageCursor: string | undefined;
    let totalFrameworks = 0;
    let testsPassing = 0;
    let testsTotal = 0;
    let partial = false;

    for (let page = 0; page < MAX_SUMMARY_PAGES; page++) {
      const result = await client.getPaginated('/v1/frameworks', {
        page_size: SUMMARY_PAGE_SIZE,
        page_cursor: pageCursor,
      });

      for (const framework of result.data) {
        if (!isRecord(framework) || !matchesFramework(framework, args.framework)) continue;
        // Envelope external text (displayName, shorthandName) before it enters
        // the summary payload; connector-authored keys (note, totals) are
        // assembled later and never pass through the sanitizer.
        const summary = summarizeFramework(sanitizeExternalText(framework));
        const key = summary.id ?? summary.displayName ?? `framework-${totalFrameworks + 1}`;
        frameworks[key] = summary;
        totalFrameworks++;
        testsPassing += summary.testsPassing;
        testsTotal += summary.testsTotal;
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
      totalFrameworks,
      totals: {
        testsPassing,
        testsTotal,
        testsFailing: Math.max(testsTotal - testsPassing, 0),
        testPassRate: testsTotal === 0 ? 0 : testsPassing / testsTotal,
      },
    };

    if (partial) {
      summary.partial = true;
      summary.note = `Summary based on first ${MAX_SUMMARY_PAGES} framework pages`;
    }

    return stringifyToolResult({
      ok: true,
      summary,
    });
  } catch (error) {
    return toToolErrorResponse(error);
  }
}
