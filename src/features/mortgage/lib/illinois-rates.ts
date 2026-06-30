/**
 * Illinois property-tax and homeowners-insurance reference data.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THESE ARE ESTIMATES. They are surfaced to the user as clearly-labeled
 * estimates throughout the calculator UI. Actual property taxes depend on the
 * assessed value, local levies, and exemptions (e.g. homestead, senior); actual
 * insurance depends on the carrier, dwelling rebuild cost, deductible, and
 * coverage. Always confirm with the county assessor and an insurance agent.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Sources (accessed mid-2026):
 *   • Effective property-tax rates: SmartAsset Illinois Property Tax Calculator
 *     (county-level, a single internally-consistent dataset). Illinois ranks
 *     #1–#2 nationally; the U.S. median effective rate is ~0.89% for context.
 *     The Illinois Policy Institute cites ~2.07% statewide for 2025 — the
 *     spread reflects methodology (assessor data vs. Census ACS). We expose the
 *     SmartAsset county set so the per-county and statewide figures agree.
 *   • Homeowners insurance: Bankrate (Nov 2025) IL average ≈ $2,225/yr for
 *     $300k dwelling coverage (≈ $7.4 per $1,000); NerdWallet (2026) ≈ $2,490
 *     for $400k. We model insurance as a rate per $1,000 of coverage so the
 *     estimate scales sensibly with home price, with the state average shown
 *     for reference.
 */

/** A selectable Illinois county (plus a statewide-average option). */
export interface CountyRate {
  id: string;
  name: string;
  /** Effective annual property tax as a percentage of home market value. */
  effectiveTaxRatePercent: number;
  /** Short note shown beneath the selector. */
  note?: string;
}

/**
 * County effective property-tax rates (SmartAsset, mid-2026 dataset).
 * Ordered with the statewide average first, then the largest/most-searched
 * counties in the Chicago metro and collar counties.
 */
export const ILLINOIS_COUNTIES: CountyRate[] = [
  {
    id: "il-statewide",
    name: "Illinois (statewide avg.)",
    effectiveTaxRatePercent: 1.92,
    note: "State average — roughly double the U.S. median of ~0.89%.",
  },
  {
    id: "cook",
    name: "Cook County (Chicago)",
    effectiveTaxRatePercent: 1.89,
    note: "Median annual tax ≈ $6,350.",
  },
  {
    id: "dupage",
    name: "DuPage County",
    effectiveTaxRatePercent: 1.91,
    note: "Median annual tax ≈ $7,800.",
  },
  {
    id: "lake",
    name: "Lake County",
    effectiveTaxRatePercent: 2.43,
    note: "Among the highest rates in the state.",
  },
  {
    id: "will",
    name: "Will County",
    effectiveTaxRatePercent: 2.12,
  },
  {
    id: "kane",
    name: "Kane County",
    effectiveTaxRatePercent: 2.26,
  },
  {
    id: "mchenry",
    name: "McHenry County",
    effectiveTaxRatePercent: 2.18,
  },
];

/** The default county selection (statewide average). */
export const DEFAULT_COUNTY_ID = "il-statewide";

export function getCountyById(id: string): CountyRate {
  return (
    ILLINOIS_COUNTIES.find((c) => c.id === id) ?? ILLINOIS_COUNTIES[0]!
  );
}

/** Homeowners-insurance reference figures for Illinois. */
export const ILLINOIS_INSURANCE = {
  /** Bankrate Nov-2025 statewide average annual premium ($300k dwelling). */
  averageAnnual: 2225,
  /** National average annual premium, for the comparison label. */
  nationalAverageAnnual: 2424,
  /**
   * Modeling rate: dollars of annual premium per $1,000 of dwelling coverage.
   * ~$7.4/yr per $1,000 (derived from the IL average at $300k coverage).
   */
  ratePerThousand: 7.4,
  /** Floor so very low-price scenarios still carry a realistic minimum. */
  minimumAnnual: 900,
} as const;

/**
 * Estimate an annual homeowners-insurance premium for a given home price.
 *
 * Insurance is priced on rebuild cost, not sale price; we use the purchase
 * price as a transparent, conservative proxy and scale by the IL per-$1,000
 * rate, never dropping below a realistic floor.
 */
export function estimateIllinoisInsurance(purchasePrice: number): number {
  if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
    return ILLINOIS_INSURANCE.minimumAnnual;
  }
  const scaled = (purchasePrice / 1000) * ILLINOIS_INSURANCE.ratePerThousand;
  return Math.round(Math.max(ILLINOIS_INSURANCE.minimumAnnual, scaled));
}

/** Standard fixed-rate loan term options offered in the UI. */
export const LOAN_TERMS = [30, 20, 15, 10] as const;

/**
 * Sensible default interest rate (annual %). 2026 context: 30-yr fixed has
 * hovered in the high-6% range. This is only a starting value the user edits.
 */
export const DEFAULT_INTEREST_RATE = 6.75;
