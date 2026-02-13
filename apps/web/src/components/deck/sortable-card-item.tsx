"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Card, CardContent } from "@/components/ui/card";
import { GripVertical } from "lucide-react";
import type { DeckbuilderCardEntry } from "@/lib/deck-logic/types";

interface SortableCardItemProps {
  entry: DeckbuilderCardEntry;
}

export function SortableCardItem({ entry }: SortableCardItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: entry.name });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      className="border-0 bg-secondary/30 hover:bg-secondary/60 transition-colors cursor-grab"
    >
      <CardContent className="p-2 flex justify-between items-center">
        <div className="flex items-center gap-2">
            <button {...attributes} {...listeners} className="p-1 text-muted-foreground rounded-md hover:bg-background/50">
                <GripVertical className="h-4 w-4" />
            </button>
            <span className="font-medium text-sm truncate">{entry.name}</span>
        </div>
        <span className="text-xs bg-background/50 px-2 py-0.5 rounded-full shrink-0">
          x{entry.qty}
        </span>
      </CardContent>
    </Card>
  );
}
