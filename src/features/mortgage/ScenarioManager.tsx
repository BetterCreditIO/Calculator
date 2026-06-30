/**
 * Save, load, and delete named mortgage scenarios. Each saved scenario shows
 * its computed monthly total so they can be compared at a glance.
 */
import { useMemo, useState } from "react";
import { Bookmark, Trash2, Check } from "lucide-react";
import {
  useCalculatorStore,
  buildMortgageInput,
  type SavedScenario,
} from "@/stores/calculator-store";
import { computeMortgage } from "./lib/mortgage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrencyCents } from "@/lib/utils";
import { toast } from "@/hooks/use-toast";

export function ScenarioManager() {
  const scenarios = useCalculatorStore((s) => s.scenarios);
  const saveScenario = useCalculatorStore((s) => s.saveScenario);
  const loadScenario = useCalculatorStore((s) => s.loadScenario);
  const deleteScenario = useCalculatorStore((s) => s.deleteScenario);
  const [name, setName] = useState("");

  function handleSave() {
    saveScenario(name);
    setName("");
    toast.success("Scenario saved");
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder="Name this scenario…"
        />
        <Button onClick={handleSave} className="shrink-0 gap-1.5">
          <Bookmark className="h-4 w-4" />
          Save
        </Button>
      </div>

      {scenarios.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No saved scenarios yet. Save the current inputs to compare options
          side by side.
        </p>
      ) : (
        <ul className="space-y-2">
          {scenarios.map((scn) => (
            <ScenarioRow
              key={scn.id}
              scenario={scn}
              onLoad={() => {
                loadScenario(scn.id);
                toast.show("Scenario loaded", scn.name);
              }}
              onDelete={() => deleteScenario(scn.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ScenarioRow({
  scenario,
  onLoad,
  onDelete,
}: {
  scenario: SavedScenario;
  onLoad: () => void;
  onDelete: () => void;
}) {
  const monthly = useMemo(
    () => computeMortgage(buildMortgageInput(scenario.inputs)).monthly.total,
    [scenario.inputs],
  );

  return (
    <li className="group flex items-center gap-2 rounded-lg border bg-card p-3 transition-smooth hover:border-primary/40">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{scenario.name}</p>
        <p className="text-xs text-muted-foreground">
          {formatCurrencyCents(scenario.inputs.purchasePrice)} home ·{" "}
          {scenario.inputs.downPaymentPercent}% down ·{" "}
          {scenario.inputs.loanTermYears}yr
        </p>
      </div>
      <div className="text-right">
        <p className="text-sm font-semibold tabular-nums">
          {formatCurrencyCents(monthly)}
        </p>
        <p className="text-[10px] text-muted-foreground">/mo</p>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={onLoad}
          className="rounded-md p-1.5 text-muted-foreground transition-smooth hover:bg-accent hover:text-primary"
          title="Load scenario"
        >
          <Check className="h-4 w-4" />
        </button>
        <button
          onClick={onDelete}
          className="rounded-md p-1.5 text-muted-foreground opacity-0 transition-smooth hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
          title="Delete scenario"
        >
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </li>
  );
}
