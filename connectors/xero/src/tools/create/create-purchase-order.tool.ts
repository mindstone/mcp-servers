import { z } from "zod";
import { createXeroPurchaseOrder } from "../../handlers/create-xero-purchase-order.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";
import { CurrencyCode, PurchaseOrder } from "xero-node";

const lineItemSchema = z.object({
  description: z.string().describe("The description of the line item"),
  quantity: z.number().describe("The quantity of the line item"),
  unitAmount: z.number().describe("The price per unit of the line item"),
  accountCode: z.string().describe("The account code of the line item - can be obtained from the list-accounts tool"),
  taxType: z.string().describe("The tax type of the line item - can be obtained from the list-tax-rates tool"),
  itemCode: z.string().describe("The item code of the line item - can be obtained from the list-items tool").optional(),
});

const CreatePurchaseOrderTool = CreateXeroTool(
  "create-purchase-order",
  "Create a purchase order in Xero for a supplier. The purchase order is created as DRAFT unless a status is specified.",
  {
    contactId: z.string().describe("The ID of the supplier contact to create the purchase order for. \
      Can be obtained from the list-contacts tool."),
    lineItems: z.array(lineItemSchema),
    reference: z.string().describe("An additional reference for the purchase order.").optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").describe("The date the purchase order was issued (YYYY-MM-DD format). Defaults to today.").optional(),
    deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format").describe("The date the goods are to be delivered (YYYY-MM-DD format).").optional(),
    purchaseOrderNumber: z.string().describe("A unique alpha-numeric code for the purchase order. When omitted, Xero auto-generates one from the organisation settings.").optional(),
    currencyCode: z.nativeEnum(CurrencyCode).describe("Optional purchase order currency, such as USD. Only use a currency enabled in the connected Xero organisation.").optional(),
    status: z.enum(["DRAFT", "SUBMITTED", "AUTHORISED"]).describe("The status to create the purchase order with. Defaults to DRAFT.").optional(),
  },
  async ({ contactId, lineItems, reference, date, deliveryDate, purchaseOrderNumber, currencyCode, status }) => {
    const statusMap: Record<string, PurchaseOrder.StatusEnum> = {
      DRAFT: PurchaseOrder.StatusEnum.DRAFT,
      SUBMITTED: PurchaseOrder.StatusEnum.SUBMITTED,
      AUTHORISED: PurchaseOrder.StatusEnum.AUTHORISED,
    };

    const result = await createXeroPurchaseOrder(
      contactId,
      lineItems,
      reference,
      date,
      deliveryDate,
      purchaseOrderNumber,
      currencyCode,
      status ? statusMap[status] : undefined,
    );

    if (result.isError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error creating purchase order: ${result.error}`,
          },
        ],
        isError: true,
      };
    }

    const purchaseOrder = result.result;

    return {
      content: [
        {
          type: "text" as const,
          text: [
            "Purchase order created successfully:",
            `ID: ${purchaseOrder?.purchaseOrderID}`,
            `Purchase Order: ${purchaseOrder?.purchaseOrderNumber}`,
            `Contact: ${purchaseOrder?.contact?.name}`,
            purchaseOrder?.date ? `Date: ${purchaseOrder.date}` : null,
            purchaseOrder?.deliveryDate
              ? `Delivery Date: ${purchaseOrder.deliveryDate}`
              : null,
            purchaseOrder?.currencyCode
              ? `Currency: ${purchaseOrder.currencyCode}`
              : null,
            `Total: ${purchaseOrder?.total}`,
            `Status: ${purchaseOrder?.status}`,
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    };
  },
);

export default CreatePurchaseOrderTool;
