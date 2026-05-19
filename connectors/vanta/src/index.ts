#!/usr/bin/env node
import { createRequire } from 'node:module';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { VantaApiClient } from './api.js';

const SERVER_VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
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

const server = new McpServer({ name: 'mcp-server-vanta', version: SERVER_VERSION });
const client = new VantaApiClient();

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
  description: `Get details for one Vanta vulnerability by ID.

WORKFLOW:
- Call vanta_list_vulnerabilities first to find the vulnerability_id.
- Use this when you need the full record for remediation or audit review.

RELATED TOOLS:
- vanta_list_vulnerabilities to discover IDs.

RETURNS:
- JSON with ok and vulnerability.`,
  annotations: readOnlyAnnotations,
  inputSchema: getVulnerabilitySchema,
}, async (input) => textResult(await vantaGetVulnerability(client, input)));

server.registerTool('vanta_list_tests', {
  title: 'List Vanta Tests',
  description: `List compliance tests from Vanta with optional status and framework filters.

WORKFLOW:
- Use this to find passing, failing, disabled, or framework-specific tests.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_get_test for full details on one test.
- vanta_list_controls to inspect mapped controls.

RETURNS:
- JSON with ok, tests, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listTestsSchema,
}, async (input) => textResult(await vantaListTests(client, input)));

server.registerTool('vanta_get_test', {
  title: 'Get Vanta Test',
  description: `Get details for one Vanta compliance test by ID.

WORKFLOW:
- Call vanta_list_tests first to find the test_id.
- Use this to inspect evidence, status, and remediation context for one test.

RELATED TOOLS:
- vanta_list_tests to discover IDs.
- vanta_list_controls to review related controls.

RETURNS:
- JSON with ok and test.`,
  annotations: readOnlyAnnotations,
  inputSchema: getTestSchema,
}, async (input) => textResult(await vantaGetTest(client, input)));

server.registerTool('vanta_list_controls', {
  title: 'List Vanta Controls',
  description: `List Vanta controls with optional framework and status filters.

WORKFLOW:
- Use this to review SOC2, ISO27001, HIPAA, or other framework control posture.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_get_control for one control's details.
- vanta_list_tests to inspect test status behind controls.

RETURNS:
- JSON with ok, controls, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listControlsSchema,
}, async (input) => textResult(await vantaListControls(client, input)));

server.registerTool('vanta_get_control', {
  title: 'Get Vanta Control',
  description: `Get details for one Vanta control by ID.

WORKFLOW:
- Call vanta_list_controls first to find the control_id.
- Use this for detailed control review and mapped test context.

RELATED TOOLS:
- vanta_list_controls to discover IDs.
- vanta_list_tests to inspect related tests.

RETURNS:
- JSON with ok and control.`,
  annotations: readOnlyAnnotations,
  inputSchema: getControlSchema,
}, async (input) => textResult(await vantaGetControl(client, input)));

server.registerTool('vanta_list_resources', {
  title: 'List Vanta Resources',
  description: `List monitored resources from Vanta with an optional resource_type filter.

WORKFLOW:
- Use this to inspect computers, cloud accounts, repositories, and SaaS applications tracked by Vanta.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_list_tests to see compliance test status.
- vanta_list_vulnerabilities to review vulnerability posture.

RETURNS:
- JSON with ok, resources, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listResourcesSchema,
}, async (input) => textResult(await vantaListResources(client, input)));

server.registerTool('vanta_list_evidence', {
  title: 'List Vanta Evidence',
  description: `List evidence items from Vanta with optional type and status filters.

WORKFLOW:
- Use this to review uploaded evidence for compliance audits.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_list_tests to see which tests reference this evidence.

RETURNS:
- JSON with ok, evidence, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listEvidenceSchema,
}, async (input) => textResult(await vantaListEvidence(client, input)));

server.registerTool('vanta_list_people', {
  title: 'List Vanta People',
  description: `List people tracked in Vanta with optional role and status filters.

WORKFLOW:
- Use this to review employees, contractors, and their compliance status.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_list_resources for non-people resources.

RETURNS:
- JSON with ok, people, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listPeopleSchema,
}, async (input) => textResult(await vantaListPeople(client, input)));

server.registerTool('vanta_query_test_results', {
  title: 'Query Vanta Test Results',
  description: `Query Vanta test results with flexible filters including date range.

WORKFLOW:
- Use this for time-scoped compliance queries (e.g., 'tests that failed this month').
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_list_tests for simpler test listing.
- vanta_get_compliance_summary for aggregate pass/fail rates.

RETURNS:
- JSON with ok, testResults, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: queryTestResultsSchema,
}, async (input) => textResult(await vantaQueryTestResults(client, input)));

server.registerTool('vanta_get_compliance_summary', {
  title: 'Get Vanta Compliance Summary',
  description: `Get an aggregate compliance summary with pass/fail counts by framework.

WORKFLOW:
- Use this for a quick compliance posture overview.
- Optionally filter to one framework (e.g., SOC2).
- Aggregates up to 500 tests across 5 pages.

RELATED TOOLS:
- vanta_list_tests for detailed per-test data.
- vanta_list_controls for control-level posture.

RETURNS:
- JSON with ok, summary (frameworks, totalTests, passRate), and partial flag if truncated.`,
  annotations: readOnlyAnnotations,
  inputSchema: complianceSummarySchema,
}, async (input) => textResult(await vantaGetComplianceSummary(client, input)));

// --- Vendor tools ---

server.registerTool('vanta_list_vendors', {
  title: 'List Vanta Vendors',
  description: `List vendors tracked in Vanta with optional category and status filters.

WORKFLOW:
- Use this to review your third-party vendor inventory and compliance posture.
- Use page_size and page_cursor for pagination.

RELATED TOOLS:
- vanta_get_vendor for full details on one vendor.
- vanta_create_vendor to add a new vendor.

RETURNS:
- JSON with ok, vendors, count, and pageInfo.`,
  annotations: readOnlyAnnotations,
  inputSchema: listVendorsSchema,
}, async (input) => textResult(await vantaListVendors(client, input)));

server.registerTool('vanta_get_vendor', {
  title: 'Get Vanta Vendor',
  description: `Get details for one Vanta vendor by ID.

WORKFLOW:
- Call vanta_list_vendors first to find the vendor_id.
- Use this to inspect vendor details, risk level, and compliance documentation.

RELATED TOOLS:
- vanta_list_vendors to discover IDs.
- vanta_update_vendor to modify vendor fields.
- vanta_attach_vendor_document to attach compliance documents.

RETURNS:
- JSON with ok and vendor.`,
  annotations: readOnlyAnnotations,
  inputSchema: getVendorSchema,
}, async (input) => textResult(await vantaGetVendor(client, input)));

server.registerTool('vanta_create_vendor', {
  title: 'Create Vanta Vendor',
  description: `Create a new vendor in Vanta.

WORKFLOW:
- Use this to register a new third-party vendor in your compliance system.
- Provide vendor name, website, and category at minimum.

RELATED TOOLS:
- vanta_list_vendors to check existing vendors.
- vanta_attach_vendor_document to add documents after creation.

RETURNS:
- JSON with ok and the created vendor.`,
  annotations: createAnnotations,
  inputSchema: createVendorSchema,
}, async (input) => textResult(await vantaCreateVendor(client, input)));

server.registerTool('vanta_update_vendor', {
  title: 'Update Vanta Vendor',
  description: `Update an existing vendor's fields in Vanta.

WORKFLOW:
- Call vanta_get_vendor first to confirm the current state.
- Only the fields you provide will be updated; others remain unchanged.

RELATED TOOLS:
- vanta_get_vendor to review before updating.
- vanta_list_vendors to discover vendor IDs.

RETURNS:
- JSON with ok and the updated vendor.`,
  annotations: mutateAnnotations,
  inputSchema: updateVendorSchema,
}, async (input) => textResult(await vantaUpdateVendor(client, input)));

server.registerTool('vanta_attach_vendor_document', {
  title: 'Attach Document to Vanta Vendor',
  description: `Attach a compliance document to an existing vendor in Vanta.

WORKFLOW:
- Use this to attach SOC2 reports, security questionnaires, or contracts to a vendor.
- Provide a URL to the document; Vanta stores the reference.

RELATED TOOLS:
- vanta_get_vendor to review vendor before attaching.
- vanta_create_vendor to create the vendor first if needed.

RETURNS:
- JSON with ok and the attached document.`,
  annotations: createAnnotations,
  inputSchema: attachVendorDocumentSchema,
}, async (input) => textResult(await vantaAttachVendorDocument(client, input)));

// --- Write tools for existing domains ---

server.registerTool('vanta_update_vulnerability', {
  title: 'Update Vanta Vulnerability',
  description: `Update the status or remediation info for a Vanta vulnerability.

WORKFLOW:
- Call vanta_get_vulnerability first to confirm the current state.
- Use this to mark vulnerabilities as fixed, accepted, or to add remediation notes.

RELATED TOOLS:
- vanta_list_vulnerabilities to discover vulnerability IDs.
- vanta_get_vulnerability to review before updating.

RETURNS:
- JSON with ok and the updated vulnerability.`,
  annotations: mutateAnnotations,
  inputSchema: updateVulnerabilitySchema,
}, async (input) => textResult(await vantaUpdateVulnerability(client, input)));

server.registerTool('vanta_upload_document', {
  title: 'Upload Vanta Evidence Document',
  description: `Upload an evidence document to Vanta for compliance audits.

WORKFLOW:
- Use this to add new evidence documents (policies, procedures, reports).
- Provide a URL to the document; Vanta stores the reference.

RELATED TOOLS:
- vanta_list_evidence to review existing evidence.

RETURNS:
- JSON with ok and the uploaded document.`,
  annotations: createAnnotations,
  inputSchema: uploadDocumentSchema,
}, async (input) => textResult(await vantaUploadDocument(client, input)));

const transport = new StdioServerTransport();
server.connect(transport)
  .then(() => {
    console.error('[Vanta] Server started');
  })
  .catch((err) => {
    console.error('[Vanta] Failed to start', err);
    process.exit(1);
  });
