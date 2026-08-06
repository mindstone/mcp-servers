import { xeroClient } from "../clients/xero-client.js";
import { formatError } from "./format-error.js";
import {
  contactDeepLink,
  creditNoteDeepLink,
  invoiceDeepLink,
  paymentDeepLink,
  manualJournalDeepLink,
  quoteDeepLink,
  billDeepLink,
} from "../consts/deeplinks.js";

export enum DeepLinkType {
  CONTACT,
  CREDIT_NOTE,
  INVOICE,
  MANUAL_JOURNAL,
  QUOTE,
  PAYMENT,
  BILL,
}

/**
 * Gets a deep link for a specific type and item ID, or `null` when the link
 * cannot be resolved. Best-effort by design: every caller has already
 * committed a successful write in Xero, so a deeplink failure must never
 * surface as a tool error — the model would retry and duplicate the record.
 * @param type
 * @param itemId
 * @returns
 */
export const getDeepLink = async (
  type: DeepLinkType,
  itemId: string,
): Promise<string | null> => {
  let orgShortCode: string | undefined;
  try {
    orgShortCode = await xeroClient.getShortCode();
  } catch (error) {
    console.warn(
      `Failed to resolve Xero deep link: ${formatError(error)}`,
    );
    return null;
  }

  if (!orgShortCode) {
    console.warn(
      "Failed to resolve Xero deep link: no organisation short code",
    );
    return null;
  }

  switch (type) {
    case DeepLinkType.CONTACT:
      return contactDeepLink(orgShortCode, itemId);
    case DeepLinkType.CREDIT_NOTE:
      return creditNoteDeepLink(orgShortCode, itemId);
    case DeepLinkType.MANUAL_JOURNAL:
      return manualJournalDeepLink(itemId);
    case DeepLinkType.INVOICE:
      return invoiceDeepLink(orgShortCode, itemId);
    case DeepLinkType.QUOTE:
      return quoteDeepLink(orgShortCode, itemId);
    case DeepLinkType.PAYMENT:
      return paymentDeepLink(orgShortCode, itemId);
    case DeepLinkType.BILL:
      return billDeepLink(orgShortCode, itemId);
  }
};
