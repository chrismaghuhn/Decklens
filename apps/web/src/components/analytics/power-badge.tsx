"use client";

import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import type { PowerFactor } from "@/lib/deck-logic/power-level";

interface PowerLevelBadgeProps {
  level: number;
  bracket: number;
  label: string;
  factors: PowerFactor[];
}

export function PowerLevelBadge({ level, bracket, label, factors }: PowerLevelBadgeProps) {
  const bracketColors = ["", "text-green-500", "text-yellow-500", "text-orange-500", "text-red-500"];
  const colorClass = bracketColors[bracket] || "text-gray-500";

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Power Level</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-2 mb-4">
          <span className={`text-5xl font-bold ${colorClass}`}>{level}</span>
          <div className="flex flex-col pb-1">
            <span className="font-semibold text-sm">Bracket {bracket}</span>
            <span className="text-xs text-muted-foreground">{label}</span>
          </div>
        </div>
        
        <div className="space-y-2">
          {factors.filter(f => f.value !== 0 && f.label !== 'Base').map((f, i) => (
            <div key={i} className="flex justify-between text-xs">
              <span>{f.label}</span>
              <span className={f.value > 0 ? "text-green-500" : "text-red-500"}>
                {f.value > 0 ? "+" : ""}{f.value}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
