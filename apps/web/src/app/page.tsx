"use client";

import { useState } from "react";
import { SearchBar } from "@/components/search/search-bar";
import { CardGrid } from "@/components/search/card-grid";
import { useCardSearch } from "@/hooks/use-card-search";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Scan, Layers, Plus } from "lucide-react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [query, setQuery] = useState("");
  const { data, isLoading } = useCardSearch(query);
  const router = useRouter();

  const cards = data?.data || [];
  const meta = data?.meta;

  const handleCreateDeck = async () => {
    const userId = "11111111-1111-1111-1111-111111111111"; // Seeded user
    try {
        const res = await fetch("http://localhost:3001/decks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, name: "New Commander Deck" })
        });
        const deck = await res.json();
        router.push(`/deck/${deck.id}`);
    } catch (e) {
        console.error("Failed to create deck", e);
        alert("Failed to create deck");
    }
  };

  return (
    <main className="flex flex-col items-center bg-background text-foreground p-6 md:p-12">
      <div className="w-full max-w-3xl mb-12 flex flex-col items-center space-y-6">
        <h1 className="text-4xl font-bold tracking-tight text-center">
          Magic: The Gathering Deckbuilder
        </h1>
        <p className="text-muted-foreground text-center max-w-lg">
          Search for cards, manage your collection, and build your dream decks.
        </p>
        
        <div className="flex flex-wrap gap-4 w-full justify-center">
            <Link href="/scanner">
                <Button variant="outline" className="gap-2">
                    <Scan className="h-4 w-4" /> Scan Cards
                </Button>
            </Link>
            <Link href="/collection">
                <Button variant="outline" className="gap-2">
                    <Layers className="h-4 w-4" /> My Collection
                </Button>
            </Link>
            <Button onClick={handleCreateDeck} className="gap-2">
                <Plus className="h-4 w-4" /> New Deck
            </Button>
        </div>

        <div className="w-full max-w-xl pt-4">
             <SearchBar onSearch={setQuery} />
        </div>
        {meta && meta.total > 0 && (
          <p className="text-sm text-muted-foreground self-start pl-2">
            Found {meta.total} results
          </p>
        )}
      </div>

      <div className="w-full max-w-7xl">
         <CardGrid cards={cards} isLoading={isLoading} />
      </div>
    </main>
  );
}
