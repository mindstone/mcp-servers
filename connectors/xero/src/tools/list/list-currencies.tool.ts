import { listEnabledXeroCurrencies } from "../../handlers/list-xero-currencies.handler.js";
import { CreateXeroTool } from "../../helpers/create-xero-tool.js";

const ListCurrenciesTool = CreateXeroTool(
  "list-currencies",
  "Lists currencies enabled in the connected Xero organisation. Use this before creating or updating invoices with a non-base currency.",
  {},
  async () => {
    const response = await listEnabledXeroCurrencies();
    if (response.error !== null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error listing currencies: ${response.error}`,
          },
        ],
      };
    }

    const currencies = response.result;

    return {
      content: [
        {
          type: "text" as const,
          text: `Found ${currencies?.length || 0} enabled currencies:`,
        },
        ...(currencies?.map((currency) => ({
          type: "text" as const,
          text: [
            `Currency: ${currency.code || "No code"}`,
            currency.description
              ? `Description: ${currency.description}`
              : null,
          ].filter(Boolean).join("\n"),
        })) || []),
      ],
    };
  },
);

export default ListCurrenciesTool;
