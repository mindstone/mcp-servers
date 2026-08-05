import { z } from "zod";
import { emailXeroInvoice } from "../../handlers/email-xero-invoice.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const EmailInvoiceTool = CreateXeroTool(
  "email-invoice",
  "Email a copy of an invoice to its related contact via Xero. The invoice must be AUTHORISED — Xero rejects emails for DRAFT or SUBMITTED invoices. Use list-invoices to find the invoice ID.",
  {
    invoiceId: z
      .string()
      .describe("The Xero invoice ID (UUID) of the AUTHORISED invoice to email"),
  },
  async ({ invoiceId }) => {
    const response = await emailXeroInvoice(invoiceId);

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error emailing invoice: ${response.error}`,
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Invoice ${invoiceId} was emailed to its related contact.`,
        },
      ],
    };
  },
);

export default EmailInvoiceTool;
