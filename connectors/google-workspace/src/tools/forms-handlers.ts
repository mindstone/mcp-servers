import { getFormsService, FormsService } from '../modules/forms/index.js';
import { getDriveService, DriveService } from '../modules/drive/index.js';
import { getAccountManager, resolveEmail } from '../modules/accounts/index.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { toMcpError } from '../utils/apiError.js';
import { Form, FormItem, FormResponse, Question } from '../modules/forms/types.js';
import {
  readAliasedNumber,
  readAliasedString
} from './arg-aliases.js';
import { wrapUntrustedContent } from '../utils/untrusted-content.js';

const HOST_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

// Singleton instances
let formsService: FormsService;
let driveService: DriveService;
let accountManager: ReturnType<typeof getAccountManager>;

/**
 * Initialize required services
 */
async function initializeServices() {
  if (!formsService) {
    formsService = getFormsService();
    await formsService.ensureInitialized();
  }
  
  if (!driveService) {
    driveService = await getDriveService();
    await driveService.ensureInitialized();
  }
  
  if (!accountManager) {
    accountManager = getAccountManager();
  }
}

// ============================================================================
// Handler Parameter Interfaces
// ============================================================================

export interface ListFormsParams {
  email?: string;
  max_results?: number;
  maxResults?: number;
  query?: string;
}

export interface GetFormParams {
  email?: string;
  form_id?: string;
  formId: string;
}

export interface ListFormResponsesParams {
  email?: string;
  form_id?: string;
  formId: string;
  max_results?: number;
  maxResults?: number;
  page_token?: string;
  pageToken?: string;
}

export interface GetFormResponseParams {
  email?: string;
  form_id?: string;
  formId: string;
  response_id?: string;
  responseId: string;
}

// ============================================================================
// Formatting Helpers
// ============================================================================

/**
 * Format a question type to human-readable text.
 */
function formatQuestionType(question: Question): string {
  if (question.choiceQuestion) {
    const type = question.choiceQuestion.type;
    switch (type) {
      case 'RADIO': return 'Multiple Choice';
      case 'CHECKBOX': return 'Checkboxes';
      case 'DROP_DOWN': return 'Dropdown';
      default: return 'Choice';
    }
  }
  if (question.textQuestion) {
    return question.textQuestion.paragraph ? 'Paragraph' : 'Short Answer';
  }
  if (question.scaleQuestion) return 'Scale';
  if (question.dateQuestion) return 'Date';
  if (question.timeQuestion) return 'Time';
  if (question.fileUploadQuestion) return 'File Upload';
  if (question.rowQuestion) return 'Grid Row';
  return 'Unknown';
}

/**
 * Format choice options for display.
 */
function formatChoiceOptions(question: Question): string {
  if (!question.choiceQuestion?.options) return '';
  
  const options = question.choiceQuestion.options
    .map((opt, i) => `      ${i + 1}. ${opt.value}${opt.isOther ? ' (Other)' : ''}`)
    .join('\n');
  return `\n${options}`;
}

/**
 * Format a form item (question) for display.
 */
export function formatFormItem(item: FormItem, index: number): string {
  const lines: string[] = [];
  
  if (item.questionItem?.question) {
    const q = item.questionItem.question;
    const required = q.required ? ' *' : '';
    const type = formatQuestionType(q);
    
    lines.push(`${index}. **${item.title || 'Untitled Question'}**${required} (${type})`);
    
    if (item.description) {
      lines.push(`   _${item.description}_`);
    }
    
    // Show options for choice questions
    const options = formatChoiceOptions(q);
    if (options) {
      lines.push(`   Options:${options}`);
    }
    
    // Show scale range
    if (q.scaleQuestion) {
      const lowLabel = q.scaleQuestion.lowLabel || q.scaleQuestion.low;
      const highLabel = q.scaleQuestion.highLabel || q.scaleQuestion.high;
      lines.push(`   Scale: ${lowLabel} to ${highLabel}`);
    }
    
    lines.push(`   [Question ID: ${q.questionId}]`);
  } else if (item.questionGroupItem) {
    lines.push(`${index}. **${item.title || 'Question Grid'}** (Grid)`);
    if (item.description) {
      lines.push(`   _${item.description}_`);
    }
    const rows = item.questionGroupItem.questions?.length || 0;
    const cols = item.questionGroupItem.grid?.columns?.options?.length || 0;
    lines.push(`   Grid: ${rows} rows × ${cols} columns`);
  } else if (item.pageBreakItem !== undefined) {
    lines.push(`${index}. --- Page Break ---`);
    if (item.title) {
      lines.push(`   Section: ${item.title}`);
    }
  } else if (item.textItem !== undefined) {
    lines.push(`${index}. **${item.title || 'Text'}** (Info)`);
    if (item.description) {
      lines.push(`   ${item.description}`);
    }
  } else if (item.imageItem) {
    lines.push(`${index}. [Image${item.imageItem.image?.altText ? `: ${item.imageItem.image.altText}` : ''}]`);
  } else if (item.videoItem) {
    lines.push(`${index}. [Video: ${item.videoItem.caption || item.videoItem.video?.youtubeUri || 'YouTube'}]`);
  }
  
  return lines.join('\n');
}

/**
 * Format a non-question form item (page break, text, image, video).
 */
function formatFormItemNonQuestion(item: FormItem): string {
  const lines: string[] = [];
  
  if (item.pageBreakItem !== undefined) {
    lines.push('--- Page Break ---');
    if (item.title) {
      lines.push(`   Section: ${item.title}`);
    }
  } else if (item.textItem !== undefined) {
    lines.push(`**${item.title || 'Text'}** (Info)`);
    if (item.description) {
      lines.push(`   ${item.description}`);
    }
  } else if (item.imageItem) {
    lines.push(`[Image${item.imageItem.image?.altText ? `: ${item.imageItem.image.altText}` : ''}]`);
  } else if (item.videoItem) {
    lines.push(`[Video: ${item.videoItem.caption || item.videoItem.video?.youtubeUri || 'YouTube'}]`);
  }
  
  return lines.join('\n');
}

/**
 * Format answers for display.
 */
export function formatAnswers(answers: Record<string, { questionId: string; textAnswers?: { answers: { value: string }[] }; fileUploadAnswers?: { answers: { fileId: string; fileName: string; mimeType: string }[] }; grade?: { score: number; correct: boolean } }>, form?: Form): string {
  const lines: string[] = [];
  
  // Build a map of questionId to question title
  const questionTitles: Record<string, string> = {};
  if (form?.items) {
    for (const item of form.items) {
      if (item.questionItem?.question?.questionId) {
        questionTitles[item.questionItem.question.questionId] = item.title || 'Untitled';
      }
      if (item.questionGroupItem?.questions) {
        for (const q of item.questionGroupItem.questions) {
          if (q.questionId && q.rowQuestion) {
            questionTitles[q.questionId] = q.rowQuestion.title || 'Untitled Row';
          }
        }
      }
    }
  }
  
  for (const [questionId, answer] of Object.entries(answers)) {
    const title = questionTitles[questionId] || `Question ${questionId.substring(0, 8)}`;
    
    if (answer.textAnswers?.answers) {
      const values = answer.textAnswers.answers.map(a => a.value).join(', ');
      lines.push(`- **${title}**: ${values}`);
    } else if (answer.fileUploadAnswers?.answers) {
      const files = answer.fileUploadAnswers.answers.map(f => f.fileName).join(', ');
      lines.push(`- **${title}**: [Files: ${files}]`);
    }
    
    if (answer.grade) {
      const gradeInfo = answer.grade.correct ? '✓' : '✗';
      lines.push(`  Score: ${answer.grade.score} ${gradeInfo}`);
    }
  }
  
  return lines.join('\n');
}

// ============================================================================
// Handlers
// ============================================================================

/**
 * List Google Forms accessible to the account.
 * Uses Drive API to search for forms by mimeType.
 */
export async function handleListForms(params: ListFormsParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const maxResults = Math.min(readAliasedNumber(rawParams, 'max_results', 'maxResults') || 20, 100);

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Use Drive API to search for forms by mimeType
      const searchOptions: { mimeType: string; pageSize: number; fullText?: string } = {
        mimeType: 'application/vnd.google-apps.form',
        pageSize: maxResults
      };
      
      if (params.query) {
        searchOptions.fullText = params.query;
      }
      
      const result = await driveService.searchFiles(email, searchOptions);
      
      if (!result.success) {
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list forms: ${result.error}`
        );
      }

      const files = (result.data as { files?: { id: string; name: string; modifiedTime?: string }[] })?.files || [];
      
      if (files.length === 0) {
        return params.query 
          ? `No forms found matching "${params.query}".`
          : 'No Google Forms found in this account.';
      }

      const lines: string[] = [];
      lines.push(`Found ${files.length} form${files.length !== 1 ? 's' : ''}:\n`);
      
      files.forEach((file, i) => {
        lines.push(`${i + 1}. **${file.name}**`);
        lines.push(`   Form ID: ${file.id}`);
        if (file.modifiedTime) {
          const date = new Date(file.modifiedTime).toLocaleDateString('en-US', { timeZone: HOST_TIMEZONE });
          lines.push(`   Modified: ${date}`);
        }
        lines.push('');
      });

      lines.push('Use get_form with the Form ID to see questions and structure.');
      lines.push('Use list_form_responses to see submissions.');

      return wrapUntrustedContent(lines.join('\n'), 'google-workspace:forms:list');
    } catch (error) {
      throw toMcpError(error, 'Failed to list forms');
    }
  });
}

/**
 * Get the structure of a Google Form.
 */
export async function handleGetForm(params: GetFormParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const formId = readAliasedString(params as unknown as Record<string, unknown>, 'form_id', 'formId');

  if (!formId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "form_id". Use list_forms to find form IDs.'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      const result = await formsService.getForm(email, formId);
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Form not found: "${formId}". Use list_forms to see available forms.`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get form: ${result.error}`
        );
      }

      const form = result.data!;
      const lines: string[] = [];
      
      // Header
      lines.push(`# ${form.info.title}`);
      if (form.info.description) {
        lines.push(`\n_${form.info.description}_`);
      }
      lines.push('');
      
      // Form metadata
      lines.push(`**Form ID:** ${form.formId}`);
      if (form.settings?.quizSettings?.isQuiz) {
        lines.push('**Type:** Quiz');
      }
      if (form.responderUri) {
        lines.push(`**Response URL:** ${form.responderUri}`);
      }
      lines.push('');
      
      // Questions
      if (form.items && form.items.length > 0) {
        lines.push(`## Questions (${form.items.length} items)\n`);
        
        let questionNum = 1;
        for (const item of form.items) {
          // Only increment for actual questions (not page breaks, text items, etc.)
          const isQuestion = item.questionItem || item.questionGroupItem;
          if (isQuestion) {
            lines.push(formatFormItem(item, questionNum++));
          } else {
            // Non-question items (page breaks, text, images) don't get numbered
            lines.push(formatFormItemNonQuestion(item));
          }
          lines.push('');
        }
      } else {
        lines.push('_No questions in this form._');
      }
      
      lines.push('\nUse list_form_responses to see submissions for this form.');

      return wrapUntrustedContent(lines.join('\n'), `google-workspace:forms:form/${formId}`);
    } catch (error) {
      throw toMcpError(error, 'Failed to get form');
    }
  });
}

/**
 * List all responses for a form.
 */
export async function handleListFormResponses(params: ListFormResponsesParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const formId = readAliasedString(rawParams, 'form_id', 'formId');

  if (!formId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "form_id". Use list_forms to find form IDs.'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // First get the form to understand question structure
      const formResult = await formsService.getForm(email, formId);
      const form = formResult.success ? formResult.data : undefined;
      
      // Get responses (clamp maxResults to API limit of 5000)
      const maxResults = Math.min(readAliasedNumber(rawParams, 'max_results', 'maxResults') || 50, 5000);
      const result = await formsService.listResponses(email, formId, {
        maxResults,
        pageToken: readAliasedString(rawParams, 'page_token', 'pageToken')
      });
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Form not found: "${formId}". Use list_forms to see available forms.`
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to list form responses: ${result.error}`
        );
      }

      const { responses, nextPageToken } = result.data!;
      
      if (responses.length === 0) {
        return `No responses found for form "${formId}".`;
      }

      const lines: string[] = [];
      lines.push(`# Form Responses (${responses.length} found)\n`);
      
      if (form) {
        lines.push(`**Form:** ${form.info.title}`);
        lines.push('');
      }
      
      responses.forEach((response, i) => {
        lines.push(`## Response ${i + 1}`);
        lines.push(`**Response ID:** ${response.responseId}`);
        lines.push(`**Submitted:** ${new Date(response.lastSubmittedTime).toLocaleString('en-US', { timeZone: HOST_TIMEZONE })}`);
        
        if (response.respondentEmail) {
          lines.push(`**Respondent:** ${response.respondentEmail}`);
        }
        
        if (response.totalScore !== undefined) {
          lines.push(`**Score:** ${response.totalScore}`);
        }
        
        if (response.answers && Object.keys(response.answers).length > 0) {
          lines.push('\n**Answers:**');
          lines.push(formatAnswers(response.answers, form));
        }
        
        lines.push('');
      });

      if (nextPageToken) {
        lines.push(`---\nMore responses available. Use page_token: "${nextPageToken}" to continue.`);
      }

      return wrapUntrustedContent(lines.join('\n'), `google-workspace:forms:responses/${formId}`);
    } catch (error) {
      throw toMcpError(error, 'Failed to list form responses');
    }
  });
}

/**
 * Get a specific form response by ID.
 */
export async function handleGetFormResponse(params: GetFormResponseParams) {
  await initializeServices();
  
  const email = await resolveEmail(params);
  const rawParams = params as unknown as Record<string, unknown>;
  const formId = readAliasedString(rawParams, 'form_id', 'formId');
  const responseId = readAliasedString(rawParams, 'response_id', 'responseId');

  if (!formId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "form_id". Use list_forms to find form IDs.'
    );
  }

  if (!responseId) {
    throw new McpError(
      ErrorCode.InvalidParams,
      'Missing required parameter: "response_id". Use list_form_responses to find response IDs.'
    );
  }

  return accountManager.withTokenRenewal(email, async () => {
    try {
      // Get the form for context
      const formResult = await formsService.getForm(email, formId);
      const form = formResult.success ? formResult.data : undefined;
      
      // Get the specific response
      const result = await formsService.getResponse(email, formId, responseId);
      
      if (!result.success) {
        if (result.error?.includes('not found') || result.error?.includes('404')) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Response not found: "${responseId}" in form "${formId}". ` +
            'Use list_form_responses to see available responses.'
          );
        }
        throw new McpError(
          ErrorCode.InternalError,
          `Failed to get form response: ${result.error}`
        );
      }

      const response = result.data!;
      const lines: string[] = [];
      
      lines.push(`# Form Response Details\n`);
      
      if (form) {
        lines.push(`**Form:** ${form.info.title}`);
      }
      
      lines.push(`**Response ID:** ${response.responseId}`);
      lines.push(`**Created:** ${new Date(response.createTime).toLocaleString('en-US', { timeZone: HOST_TIMEZONE })}`);
      lines.push(`**Last Submitted:** ${new Date(response.lastSubmittedTime).toLocaleString('en-US', { timeZone: HOST_TIMEZONE })}`);
      
      if (response.respondentEmail) {
        lines.push(`**Respondent:** ${response.respondentEmail}`);
      }
      
      if (response.totalScore !== undefined) {
        lines.push(`**Total Score:** ${response.totalScore}`);
      }
      
      lines.push('');
      
      if (response.answers && Object.keys(response.answers).length > 0) {
        lines.push('## Answers\n');
        lines.push(formatAnswers(response.answers, form));
      } else {
        lines.push('_No answers in this response._');
      }

      return wrapUntrustedContent(lines.join('\n'), `google-workspace:forms:response/${responseId}`);
    } catch (error) {
      throw toMcpError(error, 'Failed to get form response');
    }
  });
}
