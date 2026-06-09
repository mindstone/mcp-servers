import { Currency, CurrencyCode } from "xero-node";
import { xeroClient } from "../clients/xero-client.js";
import { getClientHeaders } from "./get-client-headers.js";

export async function listXeroCurrencies(): Promise<Currency[]> {
  await xeroClient.authenticate();

  const response = await xeroClient.accountingApi.getCurrencies(
    xeroClient.tenantId,
    undefined, // where
    undefined, // order
    getClientHeaders(),
  );

  return response.body.currencies ?? [];
}

export async function assertXeroCurrencyEnabled(
  currencyCode: CurrencyCode | undefined,
): Promise<void> {
  if (!currencyCode) return;

  const currencies = await listXeroCurrencies();
  const enabledCurrencyCodes = currencies
    .map((currency) => currency.code)
    .filter((code): code is CurrencyCode => Boolean(code));

  if (enabledCurrencyCodes.includes(currencyCode)) return;

  const enabledList = enabledCurrencyCodes.length
    ? enabledCurrencyCodes.join(", ")
    : "none";

  throw new Error(
    `Currency ${currencyCode} is not enabled in this Xero organisation. Enabled currencies: ${enabledList}. Add ${currencyCode} in Xero before creating or updating invoices in that currency.`,
  );
}
