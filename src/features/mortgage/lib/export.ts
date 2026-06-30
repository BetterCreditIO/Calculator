/**
 * Export a mortgage scenario to a human-readable text report and write it to
 * disk via the native save dialog. Falls back to the clipboard when not running
 * in the desktop shell.
 */
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { isTauri, writeTextFile } from "@/lib/tauri";
import { formatCurrency, formatCurrencyCents, formatPercent } from "@/lib/utils";
import type { CalculatorInputs } from "@/stores/calculator-store";
import type { MortgageResult } from "./mortgage";
import { summarizeByYear } from "./mortgage";

export function buildReportText(
  inputs: CalculatorInputs,
  result: MortgageResult,
  countyName: string,
  insuranceAnnual: number,
): string {
  const lines: string[] = [];
  const rule = "=".repeat(52);
  lines.push("LUMEN PDF — MORTGAGE & AFFORDABILITY ESTIMATE");
  lines.push(rule);
  lines.push("");
  lines.push("LOAN DETAILS");
  lines.push(`  Purchase price        ${formatCurrency(inputs.purchasePrice)}`);
  lines.push(
    `  Down payment          ${formatCurrency(result.downPaymentAmount)} (${inputs.downPaymentPercent}%)`,
  );
  lines.push(`  Loan amount           ${formatCurrency(result.loanAmount)}`);
  lines.push(`  Loan-to-value         ${formatPercent(result.loanToValue)}`);
  lines.push(`  Interest rate         ${inputs.annualInterestRatePercent}% APR`);
  lines.push(`  Term                  ${inputs.loanTermYears} years`);
  lines.push("");
  lines.push("ESTIMATED MONTHLY PAYMENT");
  lines.push(
    `  Principal & interest  ${formatCurrencyCents(result.monthly.principalAndInterest)}`,
  );
  lines.push(
    `  Property tax*         ${formatCurrencyCents(result.monthly.propertyTax)}  (${countyName})`,
  );
  lines.push(
    `  Homeowners insurance* ${formatCurrencyCents(result.monthly.insurance)}`,
  );
  if (result.monthly.pmi > 0) {
    lines.push(`  PMI                   ${formatCurrencyCents(result.monthly.pmi)}`);
  }
  if (result.monthly.hoa > 0) {
    lines.push(`  HOA dues              ${formatCurrencyCents(result.monthly.hoa)}`);
  }
  lines.push("  " + "-".repeat(48));
  lines.push(
    `  TOTAL MONTHLY         ${formatCurrencyCents(result.monthly.total)}`,
  );
  lines.push("");
  lines.push("LOAN TOTALS");
  lines.push(`  Total interest paid   ${formatCurrency(result.totalInterest)}`);
  lines.push(
    `  Total of payments     ${formatCurrency(result.totalOfPayments)}`,
  );
  lines.push(`  Annual insurance est. ${formatCurrency(insuranceAnnual)}`);
  if (result.pmiMonths > 0) {
    lines.push(
      `  PMI drops off after   ${result.pmiMonths} months (${formatCurrency(result.totalPmi)} total)`,
    );
  }
  lines.push("");
  lines.push("YEARLY AMORTIZATION (principal / interest / balance)");
  for (const y of summarizeByYear(result.schedule)) {
    lines.push(
      `  Year ${String(y.year).padStart(2)}  ` +
        `${formatCurrency(y.principalPaid).padStart(12)}  ` +
        `${formatCurrency(y.interestPaid).padStart(12)}  ` +
        `${formatCurrency(y.endingBalance).padStart(12)}`,
    );
  }
  lines.push("");
  lines.push(rule);
  lines.push(
    "* Property tax and homeowners insurance are ESTIMATES based on Illinois",
  );
  lines.push(
    "  county and state averages. Actual amounts vary by assessment,",
  );
  lines.push(
    "  exemptions, carrier, and coverage. Confirm with your county assessor",
  );
  lines.push("  and an insurance agent. Not financial advice.");
  return lines.join("\n");
}

/** Returns a status string for a toast, or throws on a real failure. */
export async function exportReport(
  inputs: CalculatorInputs,
  result: MortgageResult,
  countyName: string,
  insuranceAnnual: number,
): Promise<"saved" | "copied" | "cancelled"> {
  const text = buildReportText(inputs, result, countyName, insuranceAnnual);

  if (!isTauri()) {
    await navigator.clipboard.writeText(text);
    return "copied";
  }

  const path = await saveDialog({
    defaultPath: "mortgage-estimate.txt",
    filters: [{ name: "Text", extensions: ["txt"] }],
    title: "Export Mortgage Estimate",
  });
  if (!path) return "cancelled";
  await writeTextFile(path, text);
  return "saved";
}
