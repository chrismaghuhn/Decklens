import { useQuery } from "@tanstack/react-query";
import { Card } from "./use-card-search";

interface CollectionItem {
  collectionId: string;
  quantity: number;
  condition: string;
  isFoil: boolean;
  updatedAt: string;
  card: {
    id: string;
    name: string;
    set: string;
    collectorNumber: string;
    imageUris: { small: string; normal: string; large: string };
    prices: { usd: string; eur: string };
  };
}

const API_URL = "http://localhost:3001"; // TODO: Move to env

async function fetchCollection(userId: string): Promise<CollectionItem[]> {
  const res = await fetch(`${API_URL}/collection/${userId}`);
  if (!res.ok) {
    throw new Error("Failed to fetch collection");
  }
  return await res.json();
}

export function useCollection(userId: string) {
  return useQuery({
    queryKey: ["collection", userId],
    queryFn: () => fetchCollection(userId),
    staleTime: 60 * 1000,
  });
}
