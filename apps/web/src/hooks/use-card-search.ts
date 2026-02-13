"use client";

import { useQuery } from "@tanstack/react-query";

export interface Card {
  id: string;
  name: string;
  imageUris: { normal: string; small: string; large: string };
  manaCost: string;
  typeLine: string;
  set: string;
  collectorNumber: string;
  rarity: string;
  cmc: number;
}

interface SearchResponse {
  data: Card[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

const API_URL = "http://localhost:3002"; // TODO: Move to env

async function fetchCards(q: string, page = 1): Promise<SearchResponse> {
  // If q is empty, don't fetch anything to avoid fetching all
  if (!q) {
      return { data: [], meta: { total: 0, page: 1, limit: 50, totalPages: 0 } };
  }
  
  const res = await fetch(`${API_URL}/cards?q=${encodeURIComponent(q)}&page=${page}`);
  if (!res.ok) {
    throw new Error("Network response was not ok");
  }
  return await res.json();
}

export function useCardSearch(q: string, page: number = 1) {
  return useQuery({
    queryKey: ["cards", q, page],
    queryFn: () => fetchCards(q, page),
    enabled: q.length > 2, // Only run if query is long enough
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  });
}
