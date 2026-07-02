/**
 * The mortgage & affordability calculator panel.
 *
 * The panel holds only inputs; the {@link MortgageResult} is derived with
 * `useMemo` so the breakdown, chart, and schedule always reflect the current
 * inputs. Property-tax and insurance figures are clearly labeled ESTIMATES
 * based on Illinois county/state averages.
 */
import { useMemo, useState } from "react";
import { Info, Download, RotateCcw, Plus, Minus } from "lucide-react";
import {
  useCalculatorStore,
  buildMortgageInput,
} from "@/stores/calculator-store";
import {
  ILLINOIS_COUNTIES,
  LOAN_TERMS,
  estimateIllinoisInsurance,
  getCountyById,
} from "./lib/illinois-rates";
import { computeMortgage, PMI_THRESHOLD_PERCENT } from "./lib/mortgage";
import { PaymentBreakdownChart } from "./PaymentBreakdownChart";
import { AmortizationTable } from "./AmortizationTable";
import { ScenarioManager } from "./ScenarioManager";
import { exportReport, exportCsv } from "./lib/export";
import { exportDocx } from "./lib/export-docx";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { FileText, Table2, FileType2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  cn,
  formatCurrency,
  formatCurrencyCents,
  formatPercent,
} from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

export function MortgageCalculator() {
  const inputs = useCalculatorStore((s) => s.inputs);
  const setInput = useCalculatorStore((s) => s.setInput);
  const resetInputs = useCalculatorStore((s) => s.resetInputs);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const result = useMemo(
    () => computeMortgage(buildMortgageInput(inputs)),
    [inputs],
  );
  const county = getCountyById(inputs.countyId);
  const estimatedInsurance = estimateIllinoisInsurance(inputs.purchasePrice);
  const insuranceAnnual =
    inputs.insuranceMode === "custom"
      ? inputs.customInsuranceAnnual
      : estimatedInsurance;

  const belowPmiThreshold = inputs.downPaymentPercent < PMI_THRESHOLD_PERCENT;

  async function handleExport(kind: "docx" | "csv" | "text") {
    try {
      if (kind === "docx") {
        const status = await exportDocx(inputs, result, county.name, insuranceAnnual);
        if (status === "saved") toast.success("Word document exported");
        return;
      }
      if (kind === "csv") {
        const status = await exportCsv(inputs, result, county.name);
        if (status === "saved") toast.success("Amortization CSV exported");
        return;
      }
      const status = await exportReport(inputs, result, county.name, insuranceAnnual);
      if (status === "saved") toast.success("Estimate exported");
      else if (status === "copied")
        toast.success("Copied to clipboard", "Paste it anywhere.");
    } catch (err) {
      toast.error(
        "Export failed",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Mortgage & Affordability</h2>
          <p className="text-xs text-muted-foreground">Illinois estimates</p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={resetInputs}
          title="Reset to defaults"
        >
          <RotateCcw className="h-4 w-4" />
        </Button>
      </div>

      <ScrollArea className="flex-1 scroll-thin">
        <div className="space-y-5 p-4">
          {/* ---- Inputs ---- */}
          <section className="space-y-4">
            <Field label="Purchase price">
              <NumericField
                value={inputs.purchasePrice}
                onChange={(v) => setInput("purchasePrice", v)}
                prefix="$"
                format={formatThousands}
                ariaLabel="Purchase price"
              />
            </Field>

            <Field
              label="Down payment"
              hint={`${formatCurrency(result.downPaymentAmount)} · ${formatPercent(
                result.loanToValue,
              )} LTV`}
            >
              <div className="flex items-center gap-3">
                <Slider
                  value={[inputs.downPaymentPercent]}
                  min={0}
                  max={50}
                  step={1}
                  onValueChange={([v]) =>
                    setInput("downPaymentPercent", v ?? 0)
                  }
                  className="flex-1"
                />
                <NumericField
                  value={inputs.downPaymentPercent}
                  onChange={(v) => setInput("downPaymentPercent", clampPct(v))}
                  suffix="%"
                  ariaLabel="Down payment percent"
                  className="w-20"
                />
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Interest rate">
                <NumericField
                  value={inputs.annualInterestRatePercent}
                  onChange={(v) => setInput("annualInterestRatePercent", v)}
                  suffix="%"
                  ariaLabel="Interest rate"
                />
              </Field>

              <Field label="Loan term">
                <Select
                  value={String(inputs.loanTermYears)}
                  onValueChange={(v) => setInput("loanTermYears", Number(v))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOAN_TERMS.map((t) => (
                      <SelectItem key={t} value={String(t)}>
                        {t} years
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field label="County (property tax)" hint={county.note}>
              <Select
                value={inputs.countyId}
                onValueChange={(v) => setInput("countyId", v)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ILLINOIS_COUNTIES.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name} · {c.effectiveTaxRatePercent}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field
              label="Homeowners insurance"
              hint={
                inputs.insuranceMode === "estimate"
                  ? `Estimated ${formatCurrency(estimatedInsurance)}/yr for IL`
                  : "Custom annual premium"
              }
            >
              <div className="flex gap-2">
                <div className="flex shrink-0 rounded-md border border-input p-0.5">
                  <ModeButton
                    active={inputs.insuranceMode === "estimate"}
                    onClick={() => setInput("insuranceMode", "estimate")}
                  >
                    Estimate
                  </ModeButton>
                  <ModeButton
                    active={inputs.insuranceMode === "custom"}
                    onClick={() => setInput("insuranceMode", "custom")}
                  >
                    Custom
                  </ModeButton>
                </div>
                {inputs.insuranceMode === "custom" && (
                  <NumericField
                    value={inputs.customInsuranceAnnual}
                    onChange={(v) => setInput("customInsuranceAnnual", v)}
                    prefix="$"
                    format={formatThousands}
                    ariaLabel="Annual insurance premium"
                    className="flex-1"
                  />
                )}
              </div>
            </Field>

            {/* Advanced */}
            <button
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <span>Advanced (HOA, PMI)</span>
              {showAdvanced ? (
                <Minus className="h-3.5 w-3.5" />
              ) : (
                <Plus className="h-3.5 w-3.5" />
              )}
            </button>
            {showAdvanced && (
              <div className="grid grid-cols-2 gap-3">
                <Field label="HOA dues / mo">
                  <NumericField
                    value={inputs.monthlyHoaDues}
                    onChange={(v) => setInput("monthlyHoaDues", v)}
                    prefix="$"
                    format={formatThousands}
                    ariaLabel="Monthly HOA dues"
                  />
                </Field>
                <Field label="PMI rate / yr">
                  <NumericField
                    value={inputs.pmiRatePercent}
                    onChange={(v) => setInput("pmiRatePercent", v)}
                    suffix="%"
                    ariaLabel="PMI rate"
                  />
                </Field>
              </div>
            )}
          </section>

          <Separator />

          {/* ---- Results ---- */}
          <Tabs defaultValue="summary">
            <TabsList className="w-full">
              <TabsTrigger value="summary" className="flex-1">
                Summary
              </TabsTrigger>
              <TabsTrigger value="schedule" className="flex-1">
                Schedule
              </TabsTrigger>
              <TabsTrigger value="scenarios" className="flex-1">
                Scenarios
              </TabsTrigger>
            </TabsList>

            <TabsContent value="summary" className="space-y-4 pt-2">
              <div className="rounded-xl border bg-gradient-to-br from-primary/5 to-violet-500/5 p-4">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Estimated total monthly
                </p>
                <p className="mt-1 text-3xl font-semibold tabular-nums">
                  {formatCurrencyCents(result.monthly.total)}
                </p>
              </div>

              <PaymentBreakdownChart monthly={result.monthly} />

              {belowPmiThreshold && result.monthly.pmi > 0 && (
                <p className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  PMI applies because the down payment is under{" "}
                  {PMI_THRESHOLD_PERCENT}%. It is estimated to drop off after{" "}
                  {Math.round(result.pmiMonths / 12)} years (
                  {result.pmiMonths} payments).
                </p>
              )}

              <div className="space-y-1.5 rounded-lg border p-3 text-sm">
                <SummaryRow
                  label="Loan amount"
                  value={formatCurrency(result.loanAmount)}
                />
                <SummaryRow
                  label="Total interest"
                  value={formatCurrency(result.totalInterest)}
                />
                <SummaryRow
                  label="Total of payments"
                  value={formatCurrency(result.totalOfPayments)}
                />
                <SummaryRow
                  label={`Property tax (${county.effectiveTaxRatePercent}%/yr)`}
                  value={`${formatCurrency(result.monthly.propertyTax * 12)}/yr`}
                />
              </div>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full gap-2">
                    <Download className="h-4 w-4" />
                    Export estimate
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="center" className="w-64">
                  <DropdownMenuItem onClick={() => void handleExport("docx")}>
                    <FileType2 className="h-4 w-4" />
                    Word document (.docx)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleExport("csv")}>
                    <Table2 className="h-4 w-4" />
                    Amortization for Excel (.csv)
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => void handleExport("text")}>
                    <FileText className="h-4 w-4" />
                    Plain text (.txt)
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TabsContent>

            <TabsContent value="schedule" className="pt-2">
              <AmortizationTable result={result} />
            </TabsContent>

            <TabsContent value="scenarios" className="pt-2">
              <ScenarioManager />
            </TabsContent>
          </Tabs>

          {/* Disclaimer */}
          <div className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              Property tax and insurance are <strong>estimates</strong> from
              Illinois county and state averages and will differ from your
              actual costs. This tool is for planning only and is not financial
              advice.{" "}
              <Badge variant="warning" className="ml-1 align-middle">
                Estimate
              </Badge>
            </p>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label>{label}</Label>
        {hint && (
          <span className="truncate text-xs text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Text-backed numeric input. The displayed string is held in local state while
 * focused, so intermediate values like "6." and "6.0" survive keystrokes (a
 * fully-controlled numeric input would re-parse and erase a trailing decimal).
 * The parsed number is pushed to the store live; when not focused the field
 * shows a formatted version of the current value.
 */
function NumericField({
  value,
  onChange,
  prefix,
  suffix,
  format,
  ariaLabel,
  className,
}: {
  value: number;
  onChange: (v: number) => void;
  prefix?: string;
  suffix?: string;
  format?: (v: number) => string;
  ariaLabel?: string;
  className?: string;
}) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);

  const display = focused
    ? text
    : format
      ? format(value)
      : value
        ? String(value)
        : "";

  return (
    <div
      className={cn(
        "flex items-center rounded-md border border-input bg-background px-3 focus-within:ring-2 focus-within:ring-ring",
        className,
      )}
    >
      {prefix && <span className="text-sm text-muted-foreground">{prefix}</span>}
      <input
        inputMode="decimal"
        aria-label={ariaLabel}
        className="w-full bg-transparent px-1 py-1.5 text-sm tabular-nums outline-none"
        value={display}
        onFocus={() => {
          setText(value ? String(value) : "");
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          onChange(parseNumber(e.target.value));
        }}
      />
      {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "rounded px-2.5 py-1 text-xs font-medium transition-smooth " +
        (active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      {children}
    </button>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

function parseNumber(s: string): number {
  const n = Number(String(s).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function formatThousands(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "";
  return n.toLocaleString("en-US");
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}
