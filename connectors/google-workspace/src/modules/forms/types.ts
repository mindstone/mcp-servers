/**
 * TypeScript interfaces for Google Forms API
 * Reference: https://developers.google.com/forms/api/reference/rest
 */

/**
 * A Google Form.
 */
export interface Form {
  /** The form ID */
  formId: string;
  /** Basic form info (title, description) */
  info: FormInfo;
  /** Settings for the form */
  settings?: FormSettings;
  /** The items (questions) in the form */
  items?: FormItem[];
  /** The revision ID of the form (used for write operations) */
  revisionId?: string;
  /** URL that respondents use to view the form */
  responderUri?: string;
  /** Link for the form owner to manage the linked spreadsheet */
  linkedSheetId?: string;
}

/**
 * Basic form info.
 */
export interface FormInfo {
  /** The title of the form */
  title: string;
  /** The description of the form */
  description?: string;
  /** The document title (shown in Drive) */
  documentTitle?: string;
}

/**
 * Form settings.
 */
export interface FormSettings {
  /** Quiz settings */
  quizSettings?: {
    isQuiz?: boolean;
  };
}

/**
 * An item in a form (question, page break, text, etc.)
 */
export interface FormItem {
  /** The item ID */
  itemId: string;
  /** The title of the item */
  title?: string;
  /** The description of the item */
  description?: string;
  /** Question item (if this is a question) */
  questionItem?: QuestionItem;
  /** Question group item (for question grids) */
  questionGroupItem?: QuestionGroupItem;
  /** Page break item */
  pageBreakItem?: PageBreakItem;
  /** Text item (informational) */
  textItem?: TextItem;
  /** Image item */
  imageItem?: ImageItem;
  /** Video item */
  videoItem?: VideoItem;
}

/**
 * A question item.
 */
export interface QuestionItem {
  /** The question */
  question: Question;
  /** Image associated with the question */
  image?: Image;
}

/**
 * A question.
 */
export interface Question {
  /** The question ID */
  questionId: string;
  /** Whether the question is required */
  required?: boolean;
  /** Grading settings (for quizzes) */
  grading?: Grading;
  /** Choice question (multiple choice, dropdown, checkbox) */
  choiceQuestion?: ChoiceQuestion;
  /** Text question (short answer, paragraph) */
  textQuestion?: TextQuestion;
  /** Scale question */
  scaleQuestion?: ScaleQuestion;
  /** Date question */
  dateQuestion?: DateQuestion;
  /** Time question */
  timeQuestion?: TimeQuestion;
  /** File upload question */
  fileUploadQuestion?: FileUploadQuestion;
  /** Row question (for grids) */
  rowQuestion?: RowQuestion;
}

/**
 * A choice question (multiple choice, dropdown, checkbox).
 */
export interface ChoiceQuestion {
  /** The type of choice question */
  type: 'RADIO' | 'CHECKBOX' | 'DROP_DOWN';
  /** The options for the question */
  options: Option[];
  /** Whether "Other" is an option */
  shuffle?: boolean;
}

/**
 * An option for a choice question.
 */
export interface Option {
  /** The value/text of the option */
  value: string;
  /** Image associated with the option */
  image?: Image;
  /** Whether this is the "Other" option */
  isOther?: boolean;
  /** Navigation destination when selected */
  goToAction?: 'NEXT_SECTION' | 'RESTART_FORM' | 'SUBMIT_FORM';
  /** Section ID to go to when selected */
  goToSectionId?: string;
}

/**
 * A text question (short answer, paragraph).
 */
export interface TextQuestion {
  /** Whether this is a paragraph question (long text) */
  paragraph?: boolean;
}

/**
 * A scale question.
 */
export interface ScaleQuestion {
  /** The low value of the scale */
  low: number;
  /** The high value of the scale */
  high: number;
  /** Label for the low value */
  lowLabel?: string;
  /** Label for the high value */
  highLabel?: string;
}

/**
 * A date question.
 */
export interface DateQuestion {
  /** Whether to include the year */
  includeYear?: boolean;
  /** Whether to include the time */
  includeTime?: boolean;
}

/**
 * A time question.
 */
export interface TimeQuestion {
  /** Whether this is a duration question */
  duration?: boolean;
}

/**
 * A file upload question.
 */
export interface FileUploadQuestion {
  /** The folder ID for uploaded files */
  folderId?: string;
  /** Allowed MIME types */
  types?: string[];
  /** Maximum number of files */
  maxFiles?: number;
  /** Maximum file size in bytes */
  maxFileSize?: number;
}

/**
 * A row question (for grids).
 */
export interface RowQuestion {
  /** The title of the row */
  title: string;
}

/**
 * A question group (for question grids).
 */
export interface QuestionGroupItem {
  /** The questions in the group */
  questions: Question[];
  /** Image associated with the group */
  image?: Image;
  /** Grid settings */
  grid?: Grid;
}

/**
 * Grid settings for question groups.
 */
export interface Grid {
  /** The columns in the grid */
  columns: {
    type: 'RADIO' | 'CHECKBOX';
    options: Option[];
  };
  /** Whether to shuffle rows */
  shuffleQuestions?: boolean;
}

/**
 * Grading settings for a question.
 */
export interface Grading {
  /** The point value */
  pointValue: number;
  /** Correct answers */
  correctAnswers?: CorrectAnswers;
  /** Feedback when answer is correct */
  whenRight?: Feedback;
  /** Feedback when answer is wrong */
  whenWrong?: Feedback;
  /** General feedback */
  generalFeedback?: Feedback;
}

/**
 * Correct answers for grading.
 */
export interface CorrectAnswers {
  /** List of correct answers */
  answers: CorrectAnswer[];
}

/**
 * A correct answer.
 */
export interface CorrectAnswer {
  /** The correct value */
  value: string;
}

/**
 * Feedback for grading.
 */
export interface Feedback {
  /** Text feedback */
  text?: string;
  /** Material (links, etc.) */
  material?: ExtraMaterial[];
}

/**
 * Extra material for feedback.
 */
export interface ExtraMaterial {
  /** Link */
  link?: {
    uri: string;
    displayText?: string;
  };
  /** Video */
  video?: {
    displayText?: string;
    youtubeUri?: string;
  };
}

/**
 * An image.
 */
export interface Image {
  /** The image content URI */
  contentUri?: string;
  /** Alt text */
  altText?: string;
  /** Properties */
  properties?: {
    alignment?: 'LEFT' | 'RIGHT' | 'CENTER';
    width?: number;
  };
  /** Source URI */
  sourceUri?: string;
}

/**
 * A page break item.
 */
export interface PageBreakItem {
  // Page break has no additional properties
}

/**
 * A text item (informational).
 */
export interface TextItem {
  // Text item has no additional properties (uses item title/description)
}

/**
 * An image item.
 */
export interface ImageItem {
  /** The image */
  image: Image;
}

/**
 * A video item.
 */
export interface VideoItem {
  /** The video */
  video: {
    youtubeUri: string;
    properties?: {
      alignment?: 'LEFT' | 'RIGHT' | 'CENTER';
      width?: number;
    };
  };
  /** Caption */
  caption?: string;
}

/**
 * A response to a form.
 */
export interface FormResponse {
  /** The response ID */
  responseId: string;
  /** When the response was created */
  createTime: string;
  /** When the response was last submitted */
  lastSubmittedTime: string;
  /** The respondent's email (if collected) */
  respondentEmail?: string;
  /** Answers keyed by question ID */
  answers?: Record<string, Answer>;
  /** Total score (for quizzes) */
  totalScore?: number;
}

/**
 * An answer to a question.
 */
export interface Answer {
  /** The question ID */
  questionId: string;
  /** Text answers */
  textAnswers?: TextAnswers;
  /** File upload answers */
  fileUploadAnswers?: FileUploadAnswers;
  /** Grade for this answer */
  grade?: Grade;
}

/**
 * Text answers.
 */
export interface TextAnswers {
  /** The text answer values */
  answers: TextAnswer[];
}

/**
 * A single text answer.
 */
export interface TextAnswer {
  /** The answer value */
  value: string;
}

/**
 * File upload answers.
 */
export interface FileUploadAnswers {
  /** The uploaded files */
  answers: FileUploadAnswer[];
}

/**
 * A single file upload answer.
 */
export interface FileUploadAnswer {
  /** The file ID */
  fileId: string;
  /** The file name */
  fileName: string;
  /** The MIME type */
  mimeType: string;
}

/**
 * Grade for an answer.
 */
export interface Grade {
  /** Points awarded */
  score: number;
  /** Whether the answer was correct */
  correct: boolean;
  /** Feedback given */
  feedback?: Feedback;
}

/**
 * Options for listing form responses.
 */
export interface ListResponsesOptions {
  /** Maximum number of responses to return (default: 20, max: 5000) */
  maxResults?: number;
  /** Pagination token from previous response */
  pageToken?: string;
  /** Filter responses updated after this timestamp (RFC 3339) */
  filter?: string;
}

/**
 * Result of a Forms operation.
 */
export interface FormsOperationResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}
