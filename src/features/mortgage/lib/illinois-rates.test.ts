import { describe, it, expect } from "vitest";
import {
  ILLINOIS_COUNTIES,
  DEFAULT_COUNTY_ID,
  getCountyById,
  estimateIllinoisInsurance,
  ILLINOIS_INSURANCE,
} from "./illinois-rates";

describe("getCountyById", () => {
  it("returns the requested county", () => {
    expect(getCountyById("cook").name).toContain("Cook");
  });

  it("falls back to the first county for an unknown id", () => {
    expect(getCountyById("nope").id).toBe(ILLINOIS_COUNTIES[0]!.id);
  });

  it("has a valid default county", () => {
    expect(getCountyById(DEFAULT_COUNTY_ID).id).toBe(DEFAULT_COUNTY_ID);
  });

  it("every county has a plausible IL effective tax rate (1%–3%)", () => {
    for (const c of ILLINOIS_COUNTIES) {
      expect(c.effectiveTaxRatePercent).toBeGreaterThan(1);
      expect(c.effectiveTaxRatePercent).toBeLessThan(3);
    }
  });
});

describe("estimateIllinoisInsurance", () => {
  it("scales with home price via the per-$1,000 rate", () => {
    const est = estimateIllinoisInsurance(400_000);
    expect(est).toBe(Math.round((400_000 / 1000) * ILLINOIS_INSURANCE.ratePerThousand));
  });

  it("never drops below the realistic floor", () => {
    expect(estimateIllinoisInsurance(10_000)).toBe(ILLINOIS_INSURANCE.minimumAnnual);
    expect(estimateIllinoisInsurance(0)).toBe(ILLINOIS_INSURANCE.minimumAnnual);
  });

  it("is resilient to invalid input", () => {
    expect(estimateIllinoisInsurance(Number.NaN)).toBe(
      ILLINOIS_INSURANCE.minimumAnnual,
    );
    expect(estimateIllinoisInsurance(-5)).toBe(ILLINOIS_INSURANCE.minimumAnnual);
  });
});
