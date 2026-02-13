"use client";

import { useCollection } from "@/hooks/use-collection";
import { CardGrid } from "@/components/search/card-grid";

export default function CollectionPage() {
  const userId = "11111111-1111-1111-1111-111111111111"; // Mock user
  const { data: collection, isLoading, error } = useCollection(userId);

  if (error) {
    return <div className="text-destructive text-center p-4">Error loading collection</div>;
  }

  // Transform collection format for CardGrid component
  const cards = collection?.map(item => ({
    id: item.card.id,
    name: item.card.name,
    imageUris: item.card.imageUris,
    set: item.card.set,
    collectorNumber: item.card.collectorNumber,
    rarity: "unknown", // Rarity missing from collection query for now
    quantity: item.quantity, // Add quantity badge logic later
  })) || [];

  return (
    <div className="flex min-h-screen flex-col items-center p-6 md:p-12 bg-background text-foreground">
      <div className="z-10 w-full max-w-5xl flex items-center justify-between mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Collection</h1>
        <div className="text-sm text-muted-foreground">
          {collection?.length || 0} items
        </div>
      </div>
      
      <div className="w-full max-w-7xl">
        {isLoading ? (
             <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 animate-pulse">
                {[...Array(10)].map((_, i) => (
                  <div key={i} className="aspect-[5/7] w-full rounded-lg bg-muted/50" />
                ))}
             </div>
        ) : (
            <CardGrid cards={cards} />
        )}
      </div>
    </div>
  );
}
