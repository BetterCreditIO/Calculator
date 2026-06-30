/**
 * Mortgage calculator state: the live input scenario plus any saved scenarios.
 *
 * The store holds only the raw inputs. The derived {@link MortgageResult} is
 * computed in the component with `useMemo` from {@link buildMortgageInput} so
 * it can never go stale relative to the inputs.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MortgageInput } from "@/features/mortgage/lib/mortgage";
import {
  DEFAULT_COUNTY_ID,
  DEFAULT_INTEREST_RATE,
  estimateIllinoisInsurance,
  getCountyById,
} from "@/features/mortgage/lib/illinois-rates";
import { DEFAULT_PMI_RATE_PERCENT } from "@/features/mortgage/lib/mortgage";
import { uid } from "@/lib/utils";

/** Whether insurance is auto-estimated from price or entered manually. */
export type InsuranceMode = "estimate" | "custom";

/** The editable inputs for a single mortgage scenario. */
export interface CalculatorInputs {
  purchasePrice: number;
  downPaymentPercent: number;
  loanTermYears: number;
  annualInterestRatePercent: number;
  /** Selected county id (drives the property-tax rate). */
  countyId: string;
  insuranceMode: InsuranceMode;
  /** Annual premium used when insuranceMode === "custom". */
  customInsuranceAnnual: number;
  monthlyHoaDues: number;
  pmiRatePercent: number;
}

/** A persisted, named scenario. */
export interface SavedScenario {
  id: string;
  name: string;
  createdAt: string;
  inputs: CalculatorInputs;
}

export const DEFAULT_INPUTS: CalculatorInputs = {
  purchasePrice: 350_000,
  downPaymentPercent: 20,
  loanTermYears: 30,
  annualInterestRatePercent: DEFAULT_INTEREST_RATE,
  countyId: DEFAULT_COUNTY_ID,
  insuranceMode: "estimate",
  customInsuranceAnnual: 2_225,
  monthlyHoaDues: 0,
  pmiRatePercent: DEFAULT_PMI_RATE_PERCENT,
};

interface CalculatorState {
  inputs: CalculatorInputs;
  scenarios: SavedScenario[];

  /** Patch one or more input fields. */
  setInput: <K extends keyof CalculatorInputs>(
    key: K,
    value: CalculatorInputs[K],
  ) => void;
  resetInputs: () => void;

  saveScenario: (name: string) => void;
  loadScenario: (id: string) => void;
  deleteScenario: (id: string) => void;
}

export const useCalculatorStore = create<CalculatorState>()(
  persist(
    (set, get) => ({
      inputs: DEFAULT_INPUTS,
      scenarios: [],

      setInput: (key, value) =>
        set((s) => ({ inputs: { ...s.inputs, [key]: value } })),

      resetInputs: () => set({ inputs: DEFAULT_INPUTS }),

      saveScenario: (name) => {
        const scenario: SavedScenario = {
          id: uid("scn"),
          name: name.trim() || "Untitled scenario",
          createdAt: new Date().toISOString(),
          inputs: { ...get().inputs },
        };
        set((s) => ({ scenarios: [scenario, ...s.scenarios] }));
      },

      loadScenario: (id) => {
        const scenario = get().scenarios.find((sc) => sc.id === id);
        if (scenario) set({ inputs: { ...scenario.inputs } });
      },

      deleteScenario: (id) =>
        set((s) => ({ scenarios: s.scenarios.filter((sc) => sc.id !== id) })),
    }),
    {
      name: "lumen-calculator",
      version: 1,
    },
  ),
);

/**
 * Resolve UI inputs into the pure {@link MortgageInput} consumed by the math
 * engine — mapping the selected county to its tax rate and resolving the
 * insurance mode to a concrete annual premium.
 */
export function buildMortgageInput(inputs: CalculatorInputs): MortgageInput {
  const county = getCountyById(inputs.countyId);
  const annualHomeownersInsurance =
    inputs.insuranceMode === "custom"
      ? inputs.customInsuranceAnnual
      : estimateIllinoisInsurance(inputs.purchasePrice);

  return {
    purchasePrice: inputs.purchasePrice,
    downPaymentPercent: inputs.downPaymentPercent,
    loanTermYears: inputs.loanTermYears,
    annualInterestRatePercent: inputs.annualInterestRatePercent,
    propertyTaxRatePercent: county.effectiveTaxRatePercent,
    annualHomeownersInsurance,
    monthlyHoaDues: inputs.monthlyHoaDues,
    pmiRatePercent: inputs.pmiRatePercent,
  };
}
