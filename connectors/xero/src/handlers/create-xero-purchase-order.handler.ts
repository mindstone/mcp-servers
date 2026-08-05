import { xeroClient } from "../clients/xero-client.js";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { getClientHeaders } from "../helpers/get-client-headers.js";
import { assertXeroCurrencyEnabled } from "../helpers/xero-currencies.js";
import { CurrencyCode, PurchaseOrder } from "xero-node";

interface PurchaseOrderLineItem {
  description: string;
  quantity: number;
  unitAmount: number;
  accountCode: string;
  taxType: string;
  itemCode?: string;
}

async function createPurchaseOrder(
  contactId: string,
  lineItems: PurchaseOrderLineItem[],
  reference: string | undefined,
  date: string | undefined,
  deliveryDate: string | undefined,
  purchaseOrderNumber: string | undefined,
  currencyCode: CurrencyCode | undefined,
  status: PurchaseOrder.StatusEnum | undefined,
): Promise<PurchaseOrder | undefined> {
  await xeroClient.authenticate();
  await assertXeroCurrencyEnabled(currencyCode);

  const purchaseOrder: PurchaseOrder = {
    contact: {
      contactID: contactId,
    },
    lineItems: lineItems,
    ...(date ? { date } : {}),
    ...(deliveryDate ? { deliveryDate } : {}),
    ...(reference ? { reference } : {}),
    ...(purchaseOrderNumber ? { purchaseOrderNumber } : {}),
    ...(currencyCode ? { currencyCode } : {}),
    status: status ?? PurchaseOrder.StatusEnum.DRAFT,
  };

  const response = await xeroClient.accountingApi.createPurchaseOrders(
    xeroClient.tenantId,
    {
      purchaseOrders: [purchaseOrder],
    },
    true, // summarizeErrors
    undefined, // idempotencyKey
    getClientHeaders(),
  );

  return response.body.purchaseOrders?.[0];
}

/**
 * Create a new purchase order in Xero
 */
export async function createXeroPurchaseOrder(
  contactId: string,
  lineItems: PurchaseOrderLineItem[],
  reference?: string,
  date?: string,
  deliveryDate?: string,
  purchaseOrderNumber?: string,
  currencyCode?: CurrencyCode,
  status?: PurchaseOrder.StatusEnum,
): Promise<XeroClientResponse<PurchaseOrder>> {
  try {
    const createdPurchaseOrder = await createPurchaseOrder(
      contactId,
      lineItems,
      reference,
      date,
      deliveryDate,
      purchaseOrderNumber,
      currencyCode,
      status,
    );

    if (!createdPurchaseOrder) {
      throw new Error("Purchase order creation failed.");
    }

    return {
      result: createdPurchaseOrder,
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
