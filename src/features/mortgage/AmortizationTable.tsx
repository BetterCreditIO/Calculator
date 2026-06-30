/**
 * Year-by-year amortization schedule with a compact stacked bar that visualizes
 * the principal/interest split shifting over the life of the loan.
 */
import { useMemo } from "react";
import type { MortgageResult } from "./lib/mortgage";
import { summarizeByYear } from "./lib/mortgage";
import { formatCurrency } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";

export function AmortizationTable({ result }: { result: MortgageResult }) {
  const years = useMemo(
    () => summarizeByYear(result.schedule),
    [result.schedule],
  );

  if (years.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Enter a loan amount to see the amortization schedule.
      </p>
    );
  }

  return (
    <ScrollArea className="h-[360px] scroll-thin">
      <table className="w-full text-sm">
        <thead className="sticky top-0 bg-card">
          <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-2 text-left font-medium">Yr</th>
            <th className="py-2 px-2 text-right font-medium">Principal</th>
            <th className="py-2 px-2 text-right font-medium">Interest</th>
            <th className="py-2 pl-2 text-right font-medium">Balance</th>
          </tr>
        </thead>
        <tbody>
          {years.map((y) => {
            const total = y.principalPaid + y.interestPaid || 1;
            const principalPct = (y.principalPaid / total) * 100;
            return (
              <tr
                key={y.year}
                className="border-b border-border/50 transition-colors hover:bg-accent/40"
              >
                <td className="py-1.5 pr-2 tabular-nums text-muted-foreground">
                  {y.year}
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums">
                  <div>{formatCurrency(y.principalPaid)}</div>
                  <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-[hsl(var(--chart-1))]"
                      style={{ width: `${principalPct}%` }}
                    />
                  </div>
                </td>
                <td className="py-1.5 px-2 text-right tabular-nums text-muted-foreground">
                  {formatCurrency(y.interestPaid)}
                </td>
                <td className="py-1.5 pl-2 text-right tabular-nums font-medium">
                  {formatCurrency(y.endingBalance)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollArea>
  );
}
