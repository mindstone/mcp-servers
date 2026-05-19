import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { VantaApiClient } from './api.js';
import {
  getControlSchema,
  listControlsSchema,
  vantaGetControl,
  vantaListControls,
} from './tools/controls.js';
import { listEvidenceSchema, vantaListEvidence } from './tools/evidence.js';
import { listPeopleSchema, vantaListPeople } from './tools/people.js';
import { queryTestResultsSchema, vantaQueryTestResults } from './tools/query-results.js';
import { listResourcesSchema, vantaListResources } from './tools/resources.js';
import { complianceSummarySchema, vantaGetComplianceSummary } from './tools/summary.js';
import {
  getTestSchema,
  listTestsSchema,
  vantaGetTest,
  vantaListTests,
} from './tools/tests.js';
import { uploadDocumentSchema, vantaUploadDocument } from './tools/documents.js';
import {
  attachVendorDocumentSchema,
  createVendorSchema,
  getVendorSchema,
  listVendorsSchema,
  updateVendorSchema,
  vantaAttachVendorDocument,
  vantaCreateVendor,
  vantaGetVendor,
  vantaListVendors,
  vantaUpdateVendor,
} from './tools/vendors.js';
import {
  getVulnerabilitySchema,
  listVulnerabilitiesSchema,
  updateVulnerabilitySchema,
  vantaGetVulnerability,
  vantaListVulnerabilities,
  vantaUpdateVulnerability,
} from './tools/vulnerabilities.js';

const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const createAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const mutateAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

const textResult = (text: string) => ({
  content: [{ type: 'text' as const, text }],
});

export interface CreateServerOptions {
  client?: VantaApiClient;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'mcp-server-vanta', version: SERVER_VERSION });
  const client = options.client ?? new VantaApiClient();

  server.registerTool('vanta_list_vulnerabilities', {
    title: 'List Vanta Vulnerabilities',
    description: `List vulnerabilities from Vanta with optional severity, status, and service filters.

WORKFLOW:
- Start here to review open vulnerability posture.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_get_vulnerability for full details on one vulnerability.

RETURNS:
- JSON with ok, vulnerabilities, count, and pageInfo.`,
    annotations: readOnlyAnnotations,
    inputSchema: listVulnerabilitiesSchema,
  }, async (input) => textResult(await vantaListVulnerabilities(client, input)));

  server.registerTool('vanta_get_vulnerability', {
    title: 'Get Vanta Vulnerability',
    description: 'Get details for one Vanta vulnerability by ID.',
    annotations: readOnlyAnnotations,
    inputSchema: getVulnerabilitySchema,
  }, async (input) => textResult(await vantaGetVulnerability(client, input)));

  server.registerTool('vanta_list_tests', {
    title: 'List Vanta Tests',
    description: 'List compliance tests from Vanta with optional status and framework filters.',
    annotations: readOnlyAnnotations,
    inputSchema: listTestsSchema,
  }, async (input) => textResult(await vantaListTests(client, input)));

  server.registerTool('vanta_get_test', {
    title: 'Get Vanta Test',
    description: 'Get details for one Vanta compliance test by ID.',
    annotations: readOnlyAnnotations,
    inputSchema: getTestSchema,
  }, async (input) => textResult(await vantaGetTest(client, input)));

  server.registerTool('vanta_list_controls', {
    title: 'List Vanta Controls',
    description: 'List Vanta controls with optional framework and status filters.',
    annotations: readOnlyAnnotations,
    inputSchema: listControlsSchema,
  }, async (input) => textResult(await vantaListControls(client, input)));

  server.registerTool('vanta_get_control', {
    title: 'Get Vanta Control',
    description: 'Get details for one Vanta control by ID.',
    annotations: readOnlyAnnotations,
    inputSchema: getControlSchema,
  }, async (input) => textResult(await vantaGetControl(client, input)));

  server.registerTool('vanta_list_resources', {
    title: 'List Vanta Resources',
    description: 'List monitored resources from Vanta with an optional resource_type filter.',
    annotations: readOnlyAnnotations,
    inputSchema: listResourcesSchema,
  }, async (input) => textResult(await vantaListResources(client, input)));

  server.registerTool('vanta_list_evidence', {
    title: 'List Vanta Evidence',
    description: 'List evidence items from Vanta with optional type and status filters.',
    annotations: readOnlyAnnotations,
    inputSchema: listEvidenceSchema,
  }, async (input) => textResult(await vantaListEvidence(client, input)));

  server.registerTool('vanta_list_people', {
    title: 'List Vanta People',
    description: 'List people tracked in Vanta with optional role and status filters.',
    annotations: readOnlyAnnotations,
    inputSchema: listPeopleSchema,
  }, async (input) => textResult(await vantaListPeople(client, input)));

  server.registerTool('vanta_query_test_results', {
    title: 'Query Vanta Test Results',
    description: 'Query Vanta test results with flexible filters including date range.',
    annotations: readOnlyAnnotations,
    inputSchema: queryTestResultsSchema,
  }, async (input) => textResult(await vantaQueryTestResults(client, input)));

  server.registerTool('vanta_get_compliance_summary', {
    title: 'Get Vanta Compliance Summary',
    description: 'Get an aggregate compliance summary with pass/fail counts by framework.',
    annotations: readOnlyAnnotations,
    inputSchema: complianceSummarySchema,
  }, async (input) => textResult(await vantaGetComplianceSummary(client, input)));

  server.registerTool('vanta_list_vendors', {
    title: 'List Vanta Vendors',
    description: 'List vendors tracked in Vanta with optional category and status filters.',
    annotations: readOnlyAnnotations,
    inputSchema: listVendorsSchema,
  }, async (input) => textResult(await vantaListVendors(client, input)));

  server.registerTool('vanta_get_vendor', {
    title: 'Get Vanta Vendor',
    description: 'Get details for one Vanta vendor by ID.',
    annotations: readOnlyAnnotations,
    inputSchema: getVendorSchema,
  }, async (input) => textResult(await vantaGetVendor(client, input)));

  server.registerTool('vanta_create_vendor', {
    title: 'Create Vanta Vendor',
    description: 'Create a new vendor in Vanta.',
    annotations: createAnnotations,
    inputSchema: createVendorSchema,
  }, async (input) => textResult(await vantaCreateVendor(client, input)));

  server.registerTool('vanta_update_vendor', {
    title: 'Update Vanta Vendor',
    description: 'Update an existing vendor in Vanta.',
    annotations: mutateAnnotations,
    inputSchema: updateVendorSchema,
  }, async (input) => textResult(await vantaUpdateVendor(client, input)));

  server.registerTool('vanta_attach_vendor_document', {
    title: 'Attach Document to Vanta Vendor',
    description: 'Attach a compliance document to an existing vendor in Vanta.',
    annotations: createAnnotations,
    inputSchema: attachVendorDocumentSchema,
  }, async (input) => textResult(await vantaAttachVendorDocument(client, input)));

  server.registerTool('vanta_update_vulnerability', {
    title: 'Update Vanta Vulnerability',
    description: 'Update the status or remediation info for a Vanta vulnerability.',
    annotations: mutateAnnotations,
    inputSchema: updateVulnerabilitySchema,
  }, async (input) => textResult(await vantaUpdateVulnerability(client, input)));

  server.registerTool('vanta_upload_document', {
    title: 'Upload Vanta Evidence Document',
    description: 'Upload an evidence document to Vanta for compliance audits.',
    annotations: createAnnotations,
    inputSchema: uploadDocumentSchema,
  }, async (input) => textResult(await vantaUploadDocument(client, input)));

  return server;
}
