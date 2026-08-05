import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";

/**
 * Email a copy of an invoice to its related contact via Xero.
 * The invoice must be AUTHORISED — Xero rejects emails for DRAFT or
 * SUBMITTED invoices.
 */
export async function emailXeroInvoice(
  invoiceId: string,
): Promise<XeroClientResponse<true>> {
  try {
    await xeroClient.authenticate();

    await xeroClient.accountingApi.emailInvoice(
      xeroClient.tenantId,
      invoiceId,
      {},
      undefined, // idempotencyKey
      getClientHeaders(),
    );

    return {
      result: true,
      isError: false,
      error: null,
    };
  } catch (error) {
    return {
      result: null,
      isError: true,
      error: formatError(error),
    };
  }
}
