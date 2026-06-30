import { describe, it, expect } from "vitest";
import {
  computeMortgage,
  monthlyPrincipalAndInterest,
  summarizeByYear,
  type MortgageInput,
} from "./mortgage";

const baseInput: MortgageInput = {
  purchasePrice: 375_000,
  downPaymentPercent: 20,
  loanTermYears: 30,
  annualInterestRatePercent: 6.5,
  propertyTaxRatePercent: 2.07,
  annualHomeownersInsurance: 1_700,
  monthlyHoaDues: 0,
};

describe("monthlyPrincipalAndInterest", () => {
  it("matches the standard amortization formula for a typical loan", () => {
    // $300,000 @ 6% for 30 years → ~$1,798.65/mo (well-known reference value).
    const m = monthlyPrincipalAndInterest(300_000, 6, 30);
    expect(m).toBeCloseTo(1798.65, 2);
  });

  it("handles a 0% interest loan as straight-line principal", () => {
    expect(monthlyPrincipalAndInterest(120_000, 0, 30)).toBeCloseTo(
      120_000 / 360,
      6,
    );
  });

  it("returns 0 for non-positive principal or term", () => {
    expect(monthlyPrincipalAndInterest(0, 6, 30)).toBe(0);
    expect(monthlyPrincipalAndInterest(100_000, 6, 0)).toBe(0);
  });

  it("produces a larger payment for a shorter term", () => {
    const p30 = monthlyPrincipalAndInterest(300_000, 6, 30);
    const p15 = monthlyPrincipalAndInterest(300_000, 6, 15);
    expect(p15).toBeGreaterThan(p30);
  });
});

describe("computeMortgage", () => {
  it("derives loan amount, down payment and LTV correctly", () => {
    const r = computeMortgage(baseInput);
    expect(r.downPaymentAmount).toBeCloseTo(75_000, 2);
    expect(r.loanAmount).toBeCloseTo(300_000, 2);
    expect(r.loanToValue).toBeCloseTo(0.8, 6);
  });

  it("computes monthly property tax from the effective rate", () => {
    const r = computeMortgage(baseInput);
    // 375,000 * 2.07% / 12
    expect(r.monthly.propertyTax).toBeCloseTo((375_000 * 0.0207) / 12, 4);
  });

  it("computes monthly insurance from the annual premium", () => {
    const r = computeMortgage(baseInput);
    expect(r.monthly.insurance).toBeCloseTo(1_700 / 12, 4);
  });

  it("does NOT charge PMI when down payment is 20% or more", () => {
    const r = computeMortgage(baseInput);
    expect(r.monthly.pmi).toBe(0);
    expect(r.pmiMonths).toBe(0);
    expect(r.totalPmi).toBe(0);
  });

  it("charges PMI when down payment is below 20% and cancels it later", () => {
    const r = computeMortgage({ ...baseInput, downPaymentPercent: 10 });
    expect(r.monthly.pmi).toBeGreaterThan(0);
    expect(r.pmiMonths).toBeGreaterThan(0);
    // PMI must end before the loan does (LTV reaches 80%).
    expect(r.pmiMonths).toBeLessThan(r.schedule.length);
    // PMI is gone by the final payment.
    expect(r.schedule[r.schedule.length - 1]?.pmi).toBe(0);
  });

  it("fully amortizes: principal sums to the loan and balance ends at 0", () => {
    const r = computeMortgage(baseInput);
    const principalSum = r.schedule.reduce((s, p) => s + p.principal, 0);
    expect(principalSum).toBeCloseTo(r.loanAmount, 2);
    expect(r.schedule[r.schedule.length - 1]?.balance).toBeCloseTo(0, 2);
    expect(r.schedule.length).toBe(360);
  });

  it("total interest equals cumulative interest of the final period", () => {
    const r = computeMortgage(baseInput);
    const last = r.schedule[r.schedule.length - 1];
    expect(r.totalInterest).toBeCloseTo(last?.cumulativeInterest ?? -1, 2);
  });

  it("total of payments equals principal plus total interest", () => {
    const r = computeMortgage(baseInput);
    expect(r.totalOfPayments).toBeCloseTo(r.loanAmount + r.totalInterest, 2);
  });

  it("monthly total is the sum of all PITI components", () => {
    const r = computeMortgage({ ...baseInput, monthlyHoaDues: 250 });
    const { principalAndInterest, propertyTax, insurance, pmi, hoa, total } =
      r.monthly;
    expect(total).toBeCloseTo(
      principalAndInterest + propertyTax + insurance + pmi + hoa,
      4,
    );
    expect(hoa).toBe(250);
  });

  it("is resilient to NaN / negative inputs (no NaN leaks out)", () => {
    const r = computeMortgage({
      purchasePrice: Number.NaN,
      downPaymentPercent: -5,
      loanTermYears: 0,
      annualInterestRatePercent: -1,
      propertyTaxRatePercent: Number.POSITIVE_INFINITY,
      annualHomeownersInsurance: -100,
    });
    for (const v of Object.values(r.monthly)) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(Number.isFinite(r.totalInterest)).toBe(true);
  });
});

describe("summarizeByYear", () => {
  it("rolls the schedule into the correct number of years", () => {
    const r = computeMortgage(baseInput);
    const years = summarizeByYear(r.schedule);
    expect(years.length).toBe(30);
    // Each year (except possibly the last) covers 12 payments.
    const totalPrincipal = years.reduce((s, y) => s + y.principalPaid, 0);
    expect(totalPrincipal).toBeCloseTo(r.loanAmount, 2);
    // Balance decreases monotonically year over year.
    for (let i = 1; i < years.length; i++) {
      expect(years[i]!.endingBalance).toBeLessThanOrEqual(
        years[i - 1]!.endingBalance + 1e-6,
      );
    }
  });
});
