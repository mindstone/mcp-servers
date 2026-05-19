import type { ChatContext, ContextProvider } from '../shared/chatController/types.js';
import type { DocumentContext } from './chatClient.js';

export interface OfficeDocumentContextProvider extends ContextProvider {
  captureContext(): ChatContext;
  getDocumentContext(): DocumentContext;
  setDocumentContext(context: DocumentContext): void;
}

function cloneDocumentContext(context: DocumentContext): DocumentContext {
  return {
    ...(context.host ? { host: context.host } : {}),
    ...(context.url ? { url: context.url } : {}),
    ...(context.title ? { title: context.title } : {}),
  };
}

function toChatContext(context: DocumentContext): ChatContext {
  const safeDocumentContext = toSafeDocumentContext(context);
  return {
    documentContext: safeDocumentContext,
    ...(safeDocumentContext.title
      ? {
          pageContext: {
            title: safeDocumentContext.title,
          },
        }
      : {}),
  };
}

function toSafeDocumentContext(context: DocumentContext): DocumentContext {
  return {
    ...(context.host ? { host: context.host } : {}),
    ...(context.title ? { title: context.title } : {}),
  };
}

export function createOfficeDocumentContextProvider(
  initialContext: DocumentContext = {},
): OfficeDocumentContextProvider {
  let currentContext = cloneDocumentContext(initialContext);

  return {
    captureContext(): ChatContext {
      return toChatContext(currentContext);
    },

    getDocumentContext(): DocumentContext {
      return cloneDocumentContext(currentContext);
    },

    setDocumentContext(context: DocumentContext): void {
      currentContext = cloneDocumentContext(context);
    },
  };
}
