import { useQuery } from "@tanstack/react-query";
import type { DeckbuilderDeck } from "@/lib/deck-logic/types";
import type { AnalyzerCardView } from "@/lib/deck-logic/types";

interface DeckResponse {
  deck: DeckbuilderDeck;
  resolvedCards: Record<string, AnalyzerCardView>;
}

const API_URL = "http://localhost:3001"; // TODO: Env

async function fetchDeck(id: string): Promise<DeckResponse> {
  const res = await fetch(`${API_URL}/decks/${id}`);
  if (!res.ok) {
    if (res.status === 404) throw new Error("Deck not found");
    throw new Error("Failed to fetch deck");
  }
  return await res.json();
}

export function useDeck(id: string) {
  return useQuery({
    queryKey: ["deck", id],
    queryFn: () => fetchDeck(id),
    staleTime: 5 * 60 * 1000,
  });
}
