/**
 * Mortgage math engine — pure, deterministic, side-effect free.
 *
 * Every function here is referentially transparent so it can be unit-tested
 * exhaustively and reused from the UI, a worker, or a future export pipeline
 * without surprises. Currency is handled as plain numbers in US dollars; we
 * keep full floating-point precision through the amortization loop and only
 * round at the display boundary to avoid cumulative drift.
 *
 * IMPORTANT (product correctness): property tax and insurance figures are
 * ESTIMATES derived from county/state averages. They are clearly labeled as
 * such throughout the UI. Actual obligations vary by assessment, exemptions,
 * carrier, and coverage.
 */

/** A single payment frequency the amortization can be projected on. */
export const MONTHS_PER_YEAR = 12;

/** User-facing inputs for a mortgage scenario. */
export interface MortgageInput {
  /** Home purchase price in dollars. Used as the property-tax basis. */
  purchasePrice: number;
  /** Down payment as a percentage of the purchase price (0–100). */
  downPaymentPercent: number;
  /** Loan term in years (e.g. 30, 15). */
  loanTermYears: number;
  /** Annual nominal interest rate as a percentage (e.g. 6.5 for 6.5%). */
  annualInterestRatePercent: number;
  /**
   * Effective annual property-tax rate as a percentage of home value
   * (e.g. 2.07 for 2.07%). Typically sourced from the selected county.
   */
  propertyTaxRatePercent: number;
  /** Annual homeowners insurance premium in dollars. */
  annualHomeownersInsurance: number;
  /** Monthly HOA / condo association dues in dollars (optional). */
  monthlyHoaDues?: number;
  /**
   * Annual PMI rate as a percentage of the loan amount, applied while the
   * loan-to-value ratio exceeds 80%. Defaults to {@link DEFAULT_PMI_RATE_PERCENT}.
   */
  pmiRatePercent?: number;
}

/** One row of the amortization schedule. */
export interface AmortizationPeriod {
  /** 1-based payment number. */
  period: number;
  /** Calendar month index from loan start (1-based), useful for grouping by year. */
  monthFromStart: number;
  /** Portion of this payment applied to interest. */
  interest: number;
  /** Portion of this payment applied to principal. */
  principal: number;
  /** PMI charged this month (0 once LTV ≤ 80%). */
  pmi: number;
  /** Remaining loan balance after this payment. */
  balance: number;
  /** Cumulative interest paid through this period. */
  cumulativeInterest: number;
  /** Cumulative principal paid through this period. */
  cumulativePrincipal: number;
}

/** The computed monthly cost breakdown ("PITI" + PMI + HOA). */
export interface MonthlyBreakdown {
  /** Principal & interest portion of the payment. */
  principalAndInterest: number;
  /** Estimated monthly property tax. */
  propertyTax: number;
  /** Estimated monthly homeowners insurance. */
  insurance: number;
  /** Initial monthly PMI (0 if down payment ≥ 20%). */
  pmi: number;
  /** Monthly HOA dues. */
  hoa: number;
  /** Total estimated monthly housing cost at loan origination. */
  total: number;
}

/** The full result of a mortgage computation. */
export interface MortgageResult {
  loanAmount: number;
  downPaymentAmount: number;
  /** Effective loan-to-value ratio at origination (0–1). */
  loanToValue: number;
  monthly: MonthlyBreakdown;
  /** Total interest paid over the life of the loan. */
  totalInterest: number;
  /** Total PMI paid before it drops off. */
  totalPmi: number;
  /** Total of all principal + interest payments. */
  totalOfPayments: number;
  /** Number of months PMI is charged (0 if none). */
  pmiMonths: number;
  /** Full month-by-month amortization schedule. */
  schedule: AmortizationPeriod[];
}

/** Default PMI rate when down payment < 20% (annual % of loan amount). */
export const DEFAULT_PMI_RATE_PERCENT = 0.5;

/** Down payment percentage at or above which no PMI is required. */
export const PMI_THRESHOLD_PERCENT = 20;

/** LTV at which PMI automatically cancels (per the Homeowners Protection Act). */
const PMI_CANCEL_LTV = 0.8;

/**
 * Compute the fixed monthly principal & interest payment.
 *
 * Standard amortizing-loan formula:
 *
 *   M = P · [ r(1+r)^n ] / [ (1+r)^n − 1 ]
 *
 * where P is the principal, r the monthly interest rate (annual / 12), and n
 * the total number of payments. When r = 0 the loan is interest-free and the
 * payment is simply P / n.
 */
export function monthlyPrincipalAndInterest(
  principal: number,
  annualInterestRatePercent: number,
  loanTermYears: number,
): number {
  const n = Math.round(loanTermYears * MONTHS_PER_YEAR);
  if (n <= 0 || principal <= 0) return 0;

  const r = annualInterestRatePercent / 100 / MONTHS_PER_YEAR;
  if (r === 0) return principal / n;

  const growth = Math.pow(1 + r, n);
  return (principal * (r * growth)) / (growth - 1);
}

/**
 * Build the complete month-by-month amortization schedule, including PMI that
 * automatically cancels once the loan-to-value ratio reaches 80% of the
 * original home value (the statutory automatic-termination point).
 */
function buildSchedule(
  loanAmount: number,
  homeValue: number,
  annualInterestRatePercent: number,
  loanTermYears: number,
  pmiRatePercent: number,
): {
  schedule: AmortizationPeriod[];
  totalInterest: number;
  totalPmi: number;
  pmiMonths: number;
} {
  const n = Math.round(loanTermYears * MONTHS_PER_YEAR);
  const r = annualInterestRatePercent / 100 / MONTHS_PER_YEAR;
  const payment = monthlyPrincipalAndInterest(
    loanAmount,
    annualInterestRatePercent,
    loanTermYears,
  );
  const monthlyPmi = (loanAmount * (pmiRatePercent / 100)) / MONTHS_PER_YEAR;
  // PMI applies until the remaining balance is ≤ 80% of the ORIGINAL home value.
  const pmiCancelBalance = homeValue * PMI_CANCEL_LTV;
  const pmiRequiredAtOrigination = loanAmount > pmiCancelBalance;

  const schedule: AmortizationPeriod[] = [];
  let balance = loanAmount;
  let cumulativeInterest = 0;
  let cumulativePrincipal = 0;
  let totalPmi = 0;
  let pmiMonths = 0;

  for (let period = 1; period <= n && balance > 0; period++) {
    const interest = balance * r;
    let principalPaid = payment - interest;

    // Guard the final payment against floating-point overshoot.
    if (principalPaid > balance) principalPaid = balance;

    balance -= principalPaid;
    // Snap residual sub-cent balances to zero.
    if (balance < 0.005) balance = 0;

    const pmi =
      pmiRequiredAtOrigination && balance > pmiCancelBalance ? monthlyPmi : 0;
    if (pmi > 0) {
      totalPmi += pmi;
      pmiMonths++;
    }

    cumulativeInterest += interest;
    cumulativePrincipal += principalPaid;

    schedule.push({
      period,
      monthFromStart: period,
      interest,
      principal: principalPaid,
      pmi,
      balance,
      cumulativeInterest,
      cumulativePrincipal,
    });
  }

  return { schedule, totalInterest: cumulativeInterest, totalPmi, pmiMonths };
}

/**
 * Compute a complete mortgage scenario from user inputs.
 *
 * All inputs are clamped to safe ranges so the function never produces NaN or
 * Infinity, which keeps the UI resilient to mid-typing intermediate states.
 */
export function computeMortgage(input: MortgageInput): MortgageResult {
  const purchasePrice = clampNonNegative(input.purchasePrice);
  const downPaymentPercent = clamp(input.downPaymentPercent, 0, 100);
  const loanTermYears = clamp(input.loanTermYears, 1, 50);
  const annualInterestRatePercent = clamp(input.annualInterestRatePercent, 0, 30);
  const propertyTaxRatePercent = clampNonNegative(input.propertyTaxRatePercent);
  const annualHomeownersInsurance = clampNonNegative(
    input.annualHomeownersInsurance,
  );
  const monthlyHoaDues = clampNonNegative(input.monthlyHoaDues ?? 0);
  const pmiRatePercent = clampNonNegative(
    input.pmiRatePercent ?? DEFAULT_PMI_RATE_PERCENT,
  );

  const downPaymentAmount = (purchasePrice * downPaymentPercent) / 100;
  const loanAmount = Math.max(0, purchasePrice - downPaymentAmount);
  const loanToValue = purchasePrice > 0 ? loanAmount / purchasePrice : 0;

  const principalAndInterest = monthlyPrincipalAndInterest(
    loanAmount,
    annualInterestRatePercent,
    loanTermYears,
  );

  const propertyTax = (purchasePrice * (propertyTaxRatePercent / 100)) / MONTHS_PER_YEAR;
  const insurance = annualHomeownersInsurance / MONTHS_PER_YEAR;

  const { schedule, totalInterest, totalPmi, pmiMonths } = buildSchedule(
    loanAmount,
    purchasePrice,
    annualInterestRatePercent,
    loanTermYears,
    pmiRatePercent,
  );

  // Initial PMI: charged only when down payment is below the 20% threshold.
  const initialPmi =
    downPaymentPercent < PMI_THRESHOLD_PERCENT
      ? (loanAmount * (pmiRatePercent / 100)) / MONTHS_PER_YEAR
      : 0;

  const monthly: MonthlyBreakdown = {
    principalAndInterest,
    propertyTax,
    insurance,
    pmi: initialPmi,
    hoa: monthlyHoaDues,
    total:
      principalAndInterest +
      propertyTax +
      insurance +
      initialPmi +
      monthlyHoaDues,
  };

  return {
    loanAmount,
    downPaymentAmount,
    loanToValue,
    monthly,
    totalInterest,
    totalPmi,
    totalOfPayments: loanAmount + totalInterest,
    pmiMonths,
    schedule,
  };
}

/** Collapse the monthly schedule into per-year summary rows for display. */
export interface YearlyAmortization {
  year: number;
  interestPaid: number;
  principalPaid: number;
  pmiPaid: number;
  endingBalance: number;
}

export function summarizeByYear(
  schedule: AmortizationPeriod[],
): YearlyAmortization[] {
  const years: YearlyAmortization[] = [];
  for (const row of schedule) {
    const yearIndex = Math.ceil(row.monthFromStart / MONTHS_PER_YEAR) - 1;
    let bucket = years[yearIndex];
    if (!bucket) {
      bucket = {
        year: yearIndex + 1,
        interestPaid: 0,
        principalPaid: 0,
        pmiPaid: 0,
        endingBalance: row.balance,
      };
      years[yearIndex] = bucket;
    }
    bucket.interestPaid += row.interest;
    bucket.principalPaid += row.principal;
    bucket.pmiPaid += row.pmi;
    bucket.endingBalance = row.balance;
  }
  return years;
}

// ---------------------------------------------------------------------------
// Numeric guards
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampNonNegative(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value;
}
