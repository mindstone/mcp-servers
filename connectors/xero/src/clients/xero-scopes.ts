export const XERO_CUSTOM_CONNECTION_SCOPES = [
  "accounting.attachments.read",
  "accounting.banktransactions",
  "accounting.contacts",
  "accounting.invoices",
  "accounting.manualjournals",
  "accounting.payments",
  "accounting.reports.aged.read",
  "accounting.reports.balancesheet.read",
  "accounting.reports.banksummary.read",
  "accounting.reports.budgetsummary.read",
  "accounting.reports.executivesummary.read",
  "accounting.reports.profitandloss.read",
  "accounting.reports.taxreports.read",
  "accounting.reports.tenninetynine.read",
  "accounting.reports.trialbalance.read",
  "accounting.settings",
  "payroll.employees",
  "payroll.settings",
  "payroll.timesheets",
] as const;

export const XERO_CUSTOM_CONNECTION_SCOPE = XERO_CUSTOM_CONNECTION_SCOPES.join(" ");
export const XERO_CUSTOM_CONNECTION_SCOPE_MESSAGE =
  XERO_CUSTOM_CONNECTION_SCOPES.join(", ");

/**
 * What "Sign in with Xero" asks for: the same access as a Custom Connection,
 * plus offline_access so Xero hands back a refresh token.
 */
export const XERO_SIGN_IN_SCOPES = [
  "offline_access",
  ...XERO_CUSTOM_CONNECTION_SCOPES,
] as const;
