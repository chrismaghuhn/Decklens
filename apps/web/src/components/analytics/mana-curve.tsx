"use client";

import { useMemo } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface ManaCurveProps {
  curve: Record<string, number>;
}

export function ManaCurveChart({ curve }: ManaCurveProps) {
  const data = useMemo(() => {
    const items = [];
    const maxCmc = 7;
    
    // Create buckets 0-7+
    for (let i = 0; i <= maxCmc; i++) {
      const label = i === maxCmc ? "7+" : String(i);
      let count = curve[String(i)] || 0;
      
      // Aggregate 7+
      if (i === maxCmc) {
        Object.entries(curve).forEach(([k, v]) => {
          if (Number(k) > maxCmc) count += v;
        });
      }
      
      items.push({ name: label, count });
    }
    return items;
  }, [curve]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Mana Curve</CardTitle>
      </CardHeader>
      <CardContent className="h-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="name" fontSize={12} tickLine={false} axisLine={false} />
            <Tooltip 
              cursor={{ fill: 'transparent' }}
              contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: '6px' }}
            />
            <Bar dataKey="count" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]}>
                {data.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill="hsl(var(--primary))" />
                ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
