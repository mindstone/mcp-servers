import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mswServer } from './helpers/setup.js';
import { createTalentLMSHandlers } from './helpers/talentlms-mock-server.js';
import { createTestClient, type McpTestClient } from './helpers/mcp-test-client.js';
import { MOCK_API_KEY, MOCK_DOMAIN } from './fixtures/talentlms-data.js';

describe('Assessment tools', () => {
  let testClient: McpTestClient;

  beforeEach(() => {
    mswServer.use(...createTalentLMSHandlers());
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    if (testClient) await testClient.close();
  });

  async function getClient() {
    if (testClient) return testClient;
    testClient = await createTestClient({
      env: {
        TALENTLMS_API_KEY: MOCK_API_KEY,
        TALENTLMS_DOMAIN: MOCK_DOMAIN,
        MCP_HOST_BRIDGE_STATE: '',
      },
    });
    return testClient;
  }

  it('get_talentlms_test_answers returns quiz results', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_test_answers', { test_id: '102', user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.testAnswers.score).toBe('50');
    expect(data.testAnswers.questions).toHaveLength(2);
    expect(data.testAnswers.questions[0].correct).toBe(true);
    expect(data.testAnswers.questions[1].correct).toBe(false);
  });

  it('get_talentlms_survey_answers returns survey responses', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_survey_answers', { survey_id: '200', user_id: '1' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.surveyAnswers.questions).toHaveLength(2);
    expect(data.surveyAnswers.questions[0].answer).toBe('<untrusted-content source="talentlms:survey-answers">5/5</untrusted-content>');
    expect(data.surveyAnswers.questions[1].answer).toBe('<untrusted-content source="talentlms:survey-answers">Great course!</untrusted-content>');
  });

  it('get_talentlms_ilt_sessions returns ILT sessions', async () => {
    const client = await getClient();
    const result = await client.callTool('get_talentlms_ilt_sessions', { ilt_id: '30' });
    const data = JSON.parse(result.content[0].text as string);

    expect(data.ok).toBe(true);
    expect(data.sessions).toHaveLength(1);
    expect(data.count).toBe(1);
    expect(data.sessions[0].instructor).toBe('<untrusted-content source="talentlms:ilt-sessions">Bob Smith</untrusted-content>');
    expect(data.sessions[0].location).toBe('<untrusted-content source="talentlms:ilt-sessions">Room A</untrusted-content>');
  });
});
