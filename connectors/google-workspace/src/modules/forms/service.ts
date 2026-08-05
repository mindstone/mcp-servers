import { google, forms_v1 } from 'googleapis';
import { BaseGoogleService } from '../../services/base/BaseGoogleService.js';
import { describeApiError, isAuthHandoffError } from '../../utils/apiError.js';
import { FORMS_SCOPES } from './scopes.js';
import {
  Form,
  FormResponse,
  ListResponsesOptions,
  FormsOperationResult
} from './types.js';

/**
 * Service for interacting with Google Forms API.
 * Provides read-only access to form structure and responses.
 * 
 * Note: To list forms, use DriveService.searchFiles with mimeType filter.
 */
export class FormsService extends BaseGoogleService<forms_v1.Forms> {
  private initialized = false;

  constructor() {
    super({
      serviceName: 'Google Forms',
      version: 'v1'
    });
  }

  /**
   * Initialize the Forms service and all dependencies.
   */
  public async initialize(): Promise<void> {
    try {
      await super.initialize();
      this.initialized = true;
    } catch (error) {
      throw this.handleError(error, 'Failed to initialize Forms service');
    }
  }

  /**
   * Ensure the Forms service is initialized.
   */
  public async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Check if the service is initialized.
   */
  private checkInitialized(): void {
    if (!this.initialized) {
      throw this.handleError(
        new Error('Forms service not initialized'),
        'Please ensure the service is initialized before use'
      );
    }
  }

  /**
   * Get a form by ID.
   * @param email - The user's email address
   * @param formId - The form ID
   * @returns The form structure with questions
   */
  async getForm(email: string, formId: string): Promise<FormsOperationResult<Form>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [FORMS_SCOPES.BODY_READONLY]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.forms({ version: 'v1', auth })
      );

      const response = await client.forms.get({
        formId
      });

      const form: Form = {
        formId: response.data.formId || formId,
        info: {
          title: response.data.info?.title || 'Untitled Form',
          description: response.data.info?.description || undefined,
          documentTitle: response.data.info?.documentTitle || undefined
        },
        settings: response.data.settings ? {
          quizSettings: response.data.settings.quizSettings ? {
            isQuiz: response.data.settings.quizSettings.isQuiz || false
          } : undefined
        } : undefined,
        items: response.data.items?.map(item => ({
          itemId: item.itemId || '',
          title: item.title || undefined,
          description: item.description || undefined,
          questionItem: item.questionItem ? {
            question: {
              questionId: item.questionItem.question?.questionId || '',
              required: item.questionItem.question?.required || false,
              choiceQuestion: item.questionItem.question?.choiceQuestion ? {
                type: (item.questionItem.question.choiceQuestion.type || 'RADIO') as 'RADIO' | 'CHECKBOX' | 'DROP_DOWN',
                options: (item.questionItem.question.choiceQuestion.options || []).map(opt => ({
                  value: opt.value || '',
                  isOther: opt.isOther || false
                })),
                shuffle: item.questionItem.question.choiceQuestion.shuffle || false
              } : undefined,
              textQuestion: item.questionItem.question?.textQuestion ? {
                paragraph: item.questionItem.question.textQuestion.paragraph || false
              } : undefined,
              scaleQuestion: item.questionItem.question?.scaleQuestion ? {
                low: item.questionItem.question.scaleQuestion.low || 1,
                high: item.questionItem.question.scaleQuestion.high || 5,
                lowLabel: item.questionItem.question.scaleQuestion.lowLabel || undefined,
                highLabel: item.questionItem.question.scaleQuestion.highLabel || undefined
              } : undefined,
              dateQuestion: item.questionItem.question?.dateQuestion ? {
                includeYear: item.questionItem.question.dateQuestion.includeYear || false,
                includeTime: item.questionItem.question.dateQuestion.includeTime || false
              } : undefined,
              timeQuestion: item.questionItem.question?.timeQuestion ? {
                duration: item.questionItem.question.timeQuestion.duration || false
              } : undefined
            }
          } : undefined,
          questionGroupItem: item.questionGroupItem ? {
            questions: (item.questionGroupItem.questions || []).map(q => ({
              questionId: q.questionId || '',
              required: q.required || false,
              rowQuestion: q.rowQuestion ? {
                title: q.rowQuestion.title || ''
              } : undefined
            })),
            grid: item.questionGroupItem.grid ? {
              columns: {
                type: (item.questionGroupItem.grid.columns?.type || 'RADIO') as 'RADIO' | 'CHECKBOX',
                options: (item.questionGroupItem.grid.columns?.options || []).map(opt => ({
                  value: opt.value || ''
                }))
              }
            } : undefined
          } : undefined,
          pageBreakItem: item.pageBreakItem ? {} : undefined,
          textItem: item.textItem ? {} : undefined,
          imageItem: item.imageItem ? {
            image: {
              contentUri: item.imageItem.image?.contentUri || undefined,
              altText: item.imageItem.image?.altText || undefined,
              sourceUri: item.imageItem.image?.sourceUri || undefined
            }
          } : undefined,
          videoItem: item.videoItem ? {
            video: {
              youtubeUri: item.videoItem.video?.youtubeUri || '',
            },
            caption: item.videoItem.caption || undefined
          } : undefined
        })) || [],
        revisionId: response.data.revisionId || undefined,
        responderUri: response.data.responderUri || undefined,
        linkedSheetId: response.data.linkedSheetId || undefined
      };

      return {
        success: true,
        data: form
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      return {
        success: false,
        error: describeApiError(error)
      };
    }
  }

  /**
   * List all responses for a form.
   * @param email - The user's email address
   * @param formId - The form ID
   * @param options - Pagination and filtering options
   * @returns List of form responses
   */
  async listResponses(
    email: string,
    formId: string,
    options: ListResponsesOptions = {}
  ): Promise<FormsOperationResult<{ responses: FormResponse[]; nextPageToken?: string }>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [FORMS_SCOPES.RESPONSES_READONLY]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.forms({ version: 'v1', auth })
      );

      const response = await client.forms.responses.list({
        formId,
        pageSize: options.maxResults || 20,
        pageToken: options.pageToken || undefined,
        filter: options.filter || undefined
      });

      const responses: FormResponse[] = (response.data.responses || []).map(r => ({
        responseId: r.responseId || '',
        createTime: r.createTime || '',
        lastSubmittedTime: r.lastSubmittedTime || '',
        respondentEmail: r.respondentEmail || undefined,
        answers: r.answers ? Object.fromEntries(
          Object.entries(r.answers).map(([questionId, answer]) => [
            questionId,
            {
              questionId: answer.questionId || questionId,
              textAnswers: answer.textAnswers ? {
                answers: (answer.textAnswers.answers || []).map(a => ({
                  value: a.value || ''
                }))
              } : undefined,
              fileUploadAnswers: answer.fileUploadAnswers ? {
                answers: (answer.fileUploadAnswers.answers || []).map(a => ({
                  fileId: a.fileId || '',
                  fileName: a.fileName || '',
                  mimeType: a.mimeType || ''
                }))
              } : undefined,
              grade: answer.grade ? {
                score: answer.grade.score || 0,
                correct: answer.grade.correct || false,
                feedback: answer.grade.feedback ? {
                  text: answer.grade.feedback.text || undefined
                } : undefined
              } : undefined
            }
          ])
        ) : undefined,
        totalScore: r.totalScore || undefined
      }));

      return {
        success: true,
        data: {
          responses,
          nextPageToken: response.data.nextPageToken || undefined
        }
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      return {
        success: false,
        error: describeApiError(error)
      };
    }
  }

  /**
   * Get a specific response by ID.
   * @param email - The user's email address
   * @param formId - The form ID
   * @param responseId - The response ID
   * @returns The specific form response
   */
  async getResponse(
    email: string,
    formId: string,
    responseId: string
  ): Promise<FormsOperationResult<FormResponse>> {
    try {
      await this.ensureInitialized();
      this.checkInitialized();
      await this.validateScopes(email, [FORMS_SCOPES.RESPONSES_READONLY]);

      const client = await this.getAuthenticatedClient(
        email,
        (auth) => google.forms({ version: 'v1', auth })
      );

      const response = await client.forms.responses.get({
        formId,
        responseId
      });

      const formResponse: FormResponse = {
        responseId: response.data.responseId || responseId,
        createTime: response.data.createTime || '',
        lastSubmittedTime: response.data.lastSubmittedTime || '',
        respondentEmail: response.data.respondentEmail || undefined,
        answers: response.data.answers ? Object.fromEntries(
          Object.entries(response.data.answers).map(([questionId, answer]) => [
            questionId,
            {
              questionId: answer.questionId || questionId,
              textAnswers: answer.textAnswers ? {
                answers: (answer.textAnswers.answers || []).map(a => ({
                  value: a.value || ''
                }))
              } : undefined,
              fileUploadAnswers: answer.fileUploadAnswers ? {
                answers: (answer.fileUploadAnswers.answers || []).map(a => ({
                  fileId: a.fileId || '',
                  fileName: a.fileName || '',
                  mimeType: a.mimeType || ''
                }))
              } : undefined,
              grade: answer.grade ? {
                score: answer.grade.score || 0,
                correct: answer.grade.correct || false,
                feedback: answer.grade.feedback ? {
                  text: answer.grade.feedback.text || undefined
                } : undefined
              } : undefined
            }
          ])
        ) : undefined,
        totalScore: response.data.totalScore || undefined
      };

      return {
        success: true,
        data: formResponse
      };
    } catch (error) {
      // An expired/revoked grant must keep its reconnect signal — folding it
      // into a plain error string would skip the host's auth_required handoff.
      if (isAuthHandoffError(error)) throw error;
      return {
        success: false,
        error: describeApiError(error)
      };
    }
  }
}
