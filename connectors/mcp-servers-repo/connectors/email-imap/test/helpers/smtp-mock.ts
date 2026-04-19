/**
 * Mock factory for nodemailer module.
 *
 * Creates a mock transport that simulates SMTP operations
 * without connecting to a real server.
 */

import { vi } from 'vitest';

export interface SmtpMockOptions {
  /** If set, sendMail() throws with this message */
  sendError?: string;
  /** If set, verify() throws with this message */
  verifyError?: string;
}

export function createSmtpMock(options: SmtpMockOptions = {}) {
  const { sendError, verifyError } = options;

  const mockTransport = {
    sendMail: vi.fn(async (mailOptions: Record<string, unknown>) => {
      if (sendError) {
        throw new Error(sendError);
      }
      return { messageId: mailOptions.messageId ?? '<test@localhost>' };
    }),
    close: vi.fn(),
    verify: vi.fn(async () => {
      if (verifyError) {
        throw new Error(verifyError);
      }
      return true;
    }),
  };

  // Also support stream-transport for draft creation
  const streamTransport = {
    sendMail: vi.fn(async (mailOptions: Record<string, unknown>) => {
      return {
        messageId: mailOptions.messageId ?? '<draft@localhost>',
        message: Buffer.from('Subject: Test Draft\r\n\r\nDraft body'),
      };
    }),
    close: vi.fn(),
  };

  const createTransport = vi.fn((config: Record<string, unknown>) => {
    if (config.streamTransport) {
      return streamTransport;
    }
    return mockTransport;
  });

  return { createTransport, mockTransport, streamTransport };
}
