/**
 * Professional Word (.docx) export of a mortgage scenario.
 *
 * The `docx` library is imported DYNAMICALLY so its ~300 KB never loads until
 * the user actually exports — keeping app startup lean. The generated document
 * uses real Word tables and styles, so it can be re-branded, edited, and
 * merged into loan packets like any native Word file.
 */
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "@/lib/tauri";
import {
  formatCurrency,
  formatCurrencyCents,
  formatPercent,
} from "@/lib/utils";
import type { CalculatorInputs } from "@/stores/calculator-store";
import type { MortgageResult } from "./mortgage";
import { summarizeByYear } from "./mortgage";

const ACCENT = "4F46E5"; // brand indigo
const MUTED = "6B7280";

export async function exportDocx(
  inputs: CalculatorInputs,
  result: MortgageResult,
  countyName: string,
  insuranceAnnual: number,
): Promise<"saved" | "cancelled"> {
  const path = await saveDialog({
    defaultPath: "mortgage-estimate.docx",
    filters: [{ name: "Word Document", extensions: ["docx"] }],
    title: "Export Mortgage Estimate (Word)",
  });
  if (!path) return "cancelled";

  const docx = await import("docx");
  const {
    Document,
    Packer,
    Paragraph,
    TextRun,
    Table,
    TableRow,
    TableCell,
    WidthType,
    AlignmentType,
    BorderStyle,
    HeadingLevel,
  } = docx;

  const noBorder = {
    style: BorderStyle.NONE as (typeof BorderStyle)["NONE"],
    size: 0,
    color: "FFFFFF",
  };
  const hairline = {
    style: BorderStyle.SINGLE as (typeof BorderStyle)["SINGLE"],
    size: 4,
    color: "E5E7EB",
  };

  /** Two-column label/value row for the summary tables. */
  function kvRow(label: string, value: string, bold = false) {
    return new TableRow({
      children: [
        new TableCell({
          width: { size: 55, type: WidthType.PERCENTAGE },
          borders: { top: hairline, bottom: hairline, left: noBorder, right: noBorder },
          children: [
            new Paragraph({
              children: [new TextRun({ text: label, color: MUTED, size: 21 })],
            }),
          ],
        }),
        new TableCell({
          width: { size: 45, type: WidthType.PERCENTAGE },
          borders: { top: hairline, bottom: hairline, left: noBorder, right: noBorder },
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [new TextRun({ text: value, bold, size: 21 })],
            }),
          ],
        }),
      ],
    });
  }

  function kvTable(rows: ReturnType<typeof kvRow>[]) {
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: noBorder,
        bottom: noBorder,
        left: noBorder,
        right: noBorder,
        insideHorizontal: hairline,
        insideVertical: noBorder,
      },
      rows,
    });
  }

  function heading(text: string) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 280, after: 120 },
      children: [new TextRun({ text, bold: true, color: ACCENT, size: 24 })],
    });
  }

  const m = result.monthly;
  const monthlyRows = [
    kvRow("Principal & interest", formatCurrencyCents(m.principalAndInterest)),
    kvRow(`Property tax (est., ${countyName})`, formatCurrencyCents(m.propertyTax)),
    kvRow("Homeowners insurance (est.)", formatCurrencyCents(m.insurance)),
  ];
  if (m.pmi > 0) monthlyRows.push(kvRow("PMI", formatCurrencyCents(m.pmi)));
  if (m.hoa > 0) monthlyRows.push(kvRow("HOA dues", formatCurrencyCents(m.hoa)));
  monthlyRows.push(
    kvRow("Total estimated monthly payment", formatCurrencyCents(m.total), true),
  );

  const years = summarizeByYear(result.schedule);
  const amortHeader = new TableRow({
    tableHeader: true,
    children: ["Year", "Principal Paid", "Interest Paid", "Ending Balance"].map(
      (h, i) =>
        new TableCell({
          borders: { top: hairline, bottom: hairline, left: noBorder, right: noBorder },
          children: [
            new Paragraph({
              alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT,
              children: [
                new TextRun({ text: h, bold: true, color: ACCENT, size: 20 }),
              ],
            }),
          ],
        }),
    ),
  });
  const amortRows = years.map(
    (y) =>
      new TableRow({
        children: [
          String(y.year),
          formatCurrency(y.principalPaid),
          formatCurrency(y.interestPaid),
          formatCurrency(y.endingBalance),
        ].map(
          (value, i) =>
            new TableCell({
              borders: { top: noBorder, bottom: hairline, left: noBorder, right: noBorder },
              children: [
                new Paragraph({
                  alignment: i === 0 ? AlignmentType.LEFT : AlignmentType.RIGHT,
                  children: [new TextRun({ text: value, size: 20 })],
                }),
              ],
            }),
        ),
      }),
  );

  const document = new Document({
    creator: "GoodBoyPdf — Goodboy Labs",
    title: "Mortgage & Affordability Estimate",
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    sections: [
      {
        children: [
          new Paragraph({
            spacing: { after: 60 },
            children: [
              new TextRun({
                text: "Mortgage & Affordability Estimate",
                bold: true,
                size: 40,
              }),
            ],
          }),
          new Paragraph({
            spacing: { after: 240 },
            children: [
              new TextRun({
                text: `Prepared ${new Date().toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "long",
                  day: "numeric",
                })} · GoodBoyPdf by Goodboy Labs`,
                color: MUTED,
                size: 20,
              }),
            ],
          }),

          heading("Loan Details"),
          kvTable([
            kvRow("Purchase price", formatCurrency(inputs.purchasePrice)),
            kvRow(
              "Down payment",
              `${formatCurrency(result.downPaymentAmount)} (${inputs.downPaymentPercent}%)`,
            ),
            kvRow("Loan amount", formatCurrency(result.loanAmount)),
            kvRow("Loan-to-value", formatPercent(result.loanToValue)),
            kvRow("Interest rate", `${inputs.annualInterestRatePercent}% APR`),
            kvRow("Term", `${inputs.loanTermYears} years`),
          ]),

          heading("Estimated Monthly Payment"),
          kvTable(monthlyRows),

          heading("Loan Totals"),
          kvTable([
            kvRow("Total interest paid", formatCurrency(result.totalInterest)),
            kvRow("Total of payments", formatCurrency(result.totalOfPayments)),
            kvRow(
              "Annual insurance (est.)",
              `${formatCurrency(insuranceAnnual)}/yr`,
            ),
            ...(result.pmiMonths > 0
              ? [
                  kvRow(
                    "PMI drops off after",
                    `${result.pmiMonths} payments (${formatCurrency(result.totalPmi)} total)`,
                  ),
                ]
              : []),
          ]),

          heading("Yearly Amortization"),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: noBorder,
              bottom: noBorder,
              left: noBorder,
              right: noBorder,
              insideHorizontal: hairline,
              insideVertical: noBorder,
            },
            rows: [amortHeader, ...amortRows],
          }),

          new Paragraph({
            spacing: { before: 320 },
            children: [
              new TextRun({
                text: "Property tax and homeowners insurance are ESTIMATES based on Illinois county and state averages; actual amounts vary by assessment, exemptions, carrier, and coverage. Confirm with your county assessor and an insurance agent. This document is for planning purposes only and is not financial advice.",
                italics: true,
                color: MUTED,
                size: 18,
              }),
            ],
          }),
          new Paragraph({
            spacing: { before: 120 },
            children: [
              new TextRun({
                text: "Generated by GoodBoyPdf · Goodboy Labs",
                color: MUTED,
                size: 18,
              }),
            ],
          }),
        ],
      },
    ],
  });

  const base64 = await Packer.toBase64String(document);
  await writeBinaryFile(path, base64);
  return "saved";
}
