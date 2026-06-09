import { Currency } from "xero-node";
import { XeroClientResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";
import { listXeroCurrencies } from "../helpers/xero-currencies.js";

/**
 * List currencies enabled in the connected Xero organisation.
 */
export async function listEnabledXeroCurrencies(): Promise<
  XeroClientResponse<Currency[]>
> {
  try {
    const currencies = await listXeroCurrencies();

    return {
      result: currencies,
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
