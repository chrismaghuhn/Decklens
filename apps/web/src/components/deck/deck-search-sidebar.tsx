"use client";

import { useState } from "react";
import { SearchBar } from "@/components/search/search-bar";
import { useCardSearch, type Card } from "@/hooks/use-card-search";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

interface DeckSearchSidebarProps {
  deckId: string;
  onClose: () => void;
}

export function DeckSearchSidebar({ deckId, onClose }: DeckSearchSidebarProps) {
  const [query, setQuery] = useState("");
  const { data, isLoading } = useCardSearch(query);
  const queryClient = useQueryClient();
  const [addingId, setAddingId] = useState<string | null>(null);

  const handleAddCard = async (card: Card) => {
    setAddingId(card.id);
    try {
      const res = await fetch(`http://localhost:3001/decks/${deckId}/cards`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cardId: card.id,
          quantity: 1,
          section: "mainboard", // Default to mainboard for now
        }),
      });

      if (!res.ok) throw new Error("Failed to add card");

      toast.success(`Added ${card.name}`);
      queryClient.invalidateQueries({ queryKey: ["deck", deckId] });
    } catch (error) {
      toast.error("Failed to add card");
      console.error(error);
    } finally {
      setAddingId(null);
    }
  };

  return (
    <div className="flex flex-col h-full border-l bg-background">
      <div className="p-4 border-b flex items-center justify-between">
        <h2 className="font-semibold">Add Cards</h2>
        <Button variant="ghost" size="icon" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      
      <div className="p-4 border-b">
        <SearchBar onSearch={setQuery} placeholder="Search for cards..." />
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {isLoading ? (
          <div className="space-y-4 animate-pulse">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="h-16 bg-muted rounded" />
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {data?.data.map((card) => (
              <div key={card.id} className="flex items-center gap-3 border p-2 rounded hover:bg-accent group">
                <div className="w-12 h-16 bg-secondary rounded overflow-hidden flex-shrink-0">
                    {card.imageUris?.small && (
                        <img src={card.imageUris.small} alt={card.name} className="w-full h-full object-cover" />
                    )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">{card.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{card.typeLine}</div>
                </div>
                <Button 
                    size="icon" 
                    variant="ghost" 
                    className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"
                    onClick={() => handleAddCard(card)}
                    disabled={addingId === card.id}
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            ))}
            {query && data?.data.length === 0 && (
                <div className="text-center text-muted-foreground py-8">No results found</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
