import { z } from "zod";
import { listXeroPurchaseOrders } from "../../handlers/list-xero-purchase-orders.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListPurchaseOrdersTool = CreateXeroTool(
  "list-purchase-orders",
  `List purchase orders in Xero. Returns up to pageSize results per page (default 100, max 100).

FILTERING: Use status to filter (DRAFT, SUBMITTED, AUTHORISED, BILLED, DELETED). Use dateFrom/dateTo for date ranges (YYYY-MM-DD).

PAGINATION: If results returned equals pageSize, there may be more pages. Call again with page+1.`,
  {
    page: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Page number (1-based). If results equal pageSize, there may be more pages.",
      ),
    status: z
      .enum(["DRAFT", "SUBMITTED", "AUTHORISED", "BILLED", "DELETED"])
      .optional()
      .describe("Filter by purchase order status"),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Only purchase orders on or after this date (YYYY-MM-DD)"),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
      .optional()
      .describe("Only purchase orders on or before this date (YYYY-MM-DD)"),
    orderBy: z
      .enum(["Date", "DeliveryDate", "PurchaseOrderNumber"])
      .optional()
      .describe("Sort field. Default: Xero's default order"),
    orderDirection: z
      .enum(["ASC", "DESC"])
      .optional()
      .describe("Sort direction. Only applied when orderBy is set"),
    pageSize: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Results per page (default 100, max 100)"),
  },
  async ({ page, status, dateFrom, dateTo, orderBy, orderDirection, pageSize }) => {
    const order = orderBy
      ? `${orderBy} ${orderDirection ?? "ASC"}`
      : undefined;

    const response = await listXeroPurchaseOrders(
      page ?? 1,
      status,
      dateFrom,
      dateTo,
      order,
      pageSize,
    );

    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing purchase orders: ${response.error}`,
          },
        ],
        isError: true,
      };
    }

    const purchaseOrders = response.result;
    const effectivePageSize = pageSize ?? 100;
    const count = purchaseOrders?.length ?? 0;

    return {
      content: [
        {
          type: "text" as const,
          text:
            count === effectivePageSize
              ? `Found ${count} purchase orders. The number of results equals pageSize (${effectivePageSize}), so there may be more pages.`
              : `Found ${count} purchase orders:`,
        },
        ...(purchaseOrders?.map((purchaseOrder) => ({
          type: "text" as const,
          text: [
            `Purchase Order ID: ${purchaseOrder.purchaseOrderID}`,
            `Purchase Order: ${purchaseOrder.purchaseOrderNumber}`,
            purchaseOrder.reference
              ? `Reference: ${purchaseOrder.reference}`
              : null,
            `Status: ${purchaseOrder.status || "Unknown"}`,
            purchaseOrder.contact
              ? `Contact: ${purchaseOrder.contact.name} (${purchaseOrder.contact.contactID})`
              : null,
            purchaseOrder.date ? `Date: ${purchaseOrder.date}` : null,
            purchaseOrder.deliveryDate
              ? `Delivery Date: ${purchaseOrder.deliveryDate}`
              : null,
            purchaseOrder.currencyCode
              ? `Currency: ${purchaseOrder.currencyCode}`
              : null,
            `Total: ${purchaseOrder.total || 0}`,
          ]
            .filter(Boolean)
            .join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListPurchaseOrdersTool;
