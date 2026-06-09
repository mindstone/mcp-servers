import { describe, expect, it } from "vitest";

import {
  XERO_CUSTOM_CONNECTION_SCOPE,
  XERO_CUSTOM_CONNECTION_SCOPES,
} from "../src/clients/xero-scopes.js";

describe("Xero Custom Connection scopes", () => {
  it("requests the granular scopes exposed by the Xero Custom Connection portal", () => {
    expect(XERO_CUSTOM_CONNECTION_SCOPES).toEqual([
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
    ]);
    expect(XERO_CUSTOM_CONNECTION_SCOPE).not.toContain("accounting.transactions");
    expect(XERO_CUSTOM_CONNECTION_SCOPE).not.toContain("accounting.reports.read");
  });
});
