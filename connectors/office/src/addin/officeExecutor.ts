/**
 * Office.js execution wrappers for Word, Excel, and PowerPoint.
 * Wraps all Office.js calls in {App}.run() and normalizes errors to structured responses.
 * Runs in the Office WebView (browser context).
 *
 * Office.js globals: Word, Excel, PowerPoint, Office, OfficeExtension (from @types/office-js)
 */

export interface CommandSuccess<T = unknown> {
  success: true;
  data: T;
}

export interface CommandError {
  success: false;
  error: string;
  code: string;
}

export type CommandResult<T = unknown> = CommandSuccess<T> | CommandError;

/**
 * Known Office.js error codes mapped to user-friendly messages.
 * See: https://learn.microsoft.com/en-us/javascript/api/office/officeextension.error
 */
const OFFICE_ERROR_MAP: Record<string, { message: string; code: string }> = {
  InvalidArgument: {
    message: 'An invalid argument was provided to the Office API.',
    code: 'INVALID_ARGUMENT',
  },
  ItemNotFound: {
    message: 'The requested item was not found.',
    code: 'ITEM_NOT_FOUND',
  },
  AccessDenied: {
    message: 'The file is read-only. Save it locally or enable editing to make changes.',
    code: 'READ_ONLY',
  },
  GeneralException: {
    message: 'Office encountered an error processing the request.',
    code: 'GENERAL_EXCEPTION',
  },
  InvalidOperation: {
    message: 'The operation is not valid in the current state.',
    code: 'INVALID_OPERATION',
  },
};

/** Map of app name to the "no file open" error message. */
const NO_FILE_MESSAGES: Record<string, string> = {
  Word: 'No document is open in Word. Open or create a document first.',
  Excel: 'No workbook is open in Excel. Open or create a workbook first.',
  PowerPoint: 'No presentation is open in PowerPoint. Open or create a presentation first.',
};

function normalizeOfficeError(error: unknown, appName = 'Word'): CommandError {
  // Check for OfficeExtension.Error (has code + message + debugInfo)
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const officeError = error as { code: string; message: string; debugInfo?: unknown };
    const mapped = OFFICE_ERROR_MAP[officeError.code];

    if (mapped) {
      return { success: false, error: mapped.message, code: mapped.code };
    }

    return {
      success: false,
      error: `${appName} reported an error: ${officeError.message}`,
      code: officeError.code,
    };
  }

  if (error instanceof Error) {
    // Detect common patterns from error messages
    const msg = error.message.toLowerCase();
    if (msg.includes('not open') || msg.includes('no document') || msg.includes('no workbook') || msg.includes('no presentation')) {
      return {
        success: false,
        error: NO_FILE_MESSAGES[appName] ?? `No file is open in ${appName}. Open or create a file first.`,
        code: 'NO_DOCUMENT',
      };
    }

    if (msg.includes('read-only') || msg.includes('read only') || msg.includes('protected')) {
      return {
        success: false,
        error: 'The file is read-only. Save it locally or enable editing to make changes.',
        code: 'READ_ONLY',
      };
    }

    return {
      success: false,
      error: `${appName} reported an error: ${error.message}`,
      code: 'UNKNOWN_ERROR',
    };
  }

  return {
    success: false,
    error: `An unexpected error occurred while executing the ${appName} command.`,
    code: 'UNKNOWN_ERROR',
  };
}

/**
 * Execute a Word.js command within a Word.run() context.
 * The callback receives the Word.RequestContext and must call context.sync()
 * to load queued property reads before accessing them.
 * Word.run() handles context lifecycle and cleanup automatically.
 */
export async function executeWordCommand<T>(
  fn: (context: Word.RequestContext) => Promise<T>,
): Promise<CommandResult<T>> {
  try {
    const data = await Word.run(async (context) => {
      return await fn(context);
    });

    return { success: true, data };
  } catch (error) {
    return normalizeOfficeError(error, 'Word');
  }
}

/**
 * Execute an Excel.js command within an Excel.run() context.
 */
export async function executeExcelCommand<T>(
  fn: (context: Excel.RequestContext) => Promise<T>,
): Promise<CommandResult<T>> {
  try {
    const data = await Excel.run(async (context) => {
      return await fn(context);
    });

    return { success: true, data };
  } catch (error) {
    return normalizeOfficeError(error, 'Excel');
  }
}

/**
 * Execute a PowerPoint.js command within a PowerPoint.run() context.
 */
export async function executePowerpointCommand<T>(
  fn: (context: PowerPoint.RequestContext) => Promise<T>,
): Promise<CommandResult<T>> {
  try {
    const data = await PowerPoint.run(async (context) => {
      return await fn(context);
    });

    return { success: true, data };
  } catch (error) {
    return normalizeOfficeError(error, 'PowerPoint');
  }
}
