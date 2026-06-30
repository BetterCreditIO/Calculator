/**
 * Donut chart of the monthly payment breakdown. Colors come from the theme's
 * chart tokens so the chart adapts to light/dark automatically.
 */
import { PieChart, Pie, Cell, ResponsiveContainer } from "recharts";
import type { MonthlyBreakdown } from "./lib/mortgage";
import { formatCurrencyCents } from "@/lib/utils";

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
}

export function PaymentBreakdownChart({
  monthly,
}: {
  monthly: MonthlyBreakdown;
}) {
  const segments: Segment[] = [
    {
      key: "pi",
      label: "Principal & Interest",
      value: monthly.principalAndInterest,
      color: "hsl(var(--chart-1))",
    },
    {
      key: "tax",
      label: "Property Tax",
      value: monthly.propertyTax,
      color: "hsl(var(--chart-3))",
    },
    {
      key: "ins",
      label: "Insurance",
      value: monthly.insurance,
      color: "hsl(var(--chart-4))",
    },
    {
      key: "pmi",
      label: "PMI",
      value: monthly.pmi,
      color: "hsl(var(--chart-5))",
    },
    {
      key: "hoa",
      label: "HOA",
      value: monthly.hoa,
      color: "hsl(var(--chart-2))",
    },
  ].filter((s) => s.value > 0.005);

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-36 w-36 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={segments}
              dataKey="value"
              nameKey="label"
              cx="50%"
              cy="50%"
              innerRadius={48}
              outerRadius={68}
              paddingAngle={segments.length > 1 ? 2 : 0}
              strokeWidth={0}
              isAnimationActive
            >
              {segments.map((s) => (
                <Cell key={s.key} fill={s.color} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Monthly
          </span>
          <span className="text-base font-semibold tabular-nums">
            {formatCurrencyCents(monthly.total)}
          </span>
        </div>
      </div>

      <ul className="flex-1 space-y-1.5">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="flex-1 text-muted-foreground">{s.label}</span>
            <span className="tabular-nums font-medium">
              {formatCurrencyCents(s.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
