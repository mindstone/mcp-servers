import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { PurchaseOrder } from "xero-node";

type PurchaseOrderStatus =
  | "DRAFT"
  | "SUBMITTED"
  | "AUTHORISED"
  | "BILLED"
  | "DELETED";

async function getPurchaseOrders(
  status?: PurchaseOrderStatus,
  dateFrom?: string,
  dateTo?: string,
  order?: string,
  page?: number,
  pageSize?: number,
): Promise<PurchaseOrder[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getPurchaseOrders(
    xeroClient.tenantId,
    undefined, // ifModifiedSince
    status,
    dateFrom,
    dateTo,
    order,
    page,
    pageSize ?? 100,
    getClientHeaders(),
  );

  return response.body.purchaseOrders ?? [];
}

/**
 * List purchase orders from Xero
 */
export async function listXeroPurchaseOrders(
  page: number = 1,
  status?: PurchaseOrderStatus,
  dateFrom?: string,
  dateTo?: string,
  order?: string,
  pageSize?: number,
): Promise<XeroClientResponse<PurchaseOrder[]>> {
  try {
    const purchaseOrders = await getPurchaseOrders(
      status,
      dateFrom,
      dateTo,
      order,
      page,
      pageSize,
    );

    return {
      result: purchaseOrders,
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
