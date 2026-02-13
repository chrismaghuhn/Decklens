import { Card, CardContent } from "@/components/ui/card";
import { type VariantProps, cva } from "class-variance-authority";
import { cn } from "@/lib/utils";

interface CardData {
  id: string;
  name: string;
  imageUris?: {
    small: string;
    normal: string;
    large: string;
  };
  set: string;
  collectorNumber: string;
  rarity: string;
}

interface CardGridProps {
  cards: CardData[];
  onCardClick?: (card: CardData) => void;
  isLoading?: boolean;
}

export function CardGrid({ cards, onCardClick, isLoading }: CardGridProps) {
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {[...Array(10)].map((_, i) => (
          <div key={i} className="aspect-[5/7] w-full animate-pulse rounded-lg bg-secondary/50" />
        ))}
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="flex h-40 w-full items-center justify-center text-muted-foreground">
        No cards found.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
      {cards.map((card) => (
        <div key={card.id} className="group relative transition-transform hover:-translate-y-1">
          <Card className="overflow-hidden border-0 bg-transparent shadow-none">
            <CardContent className="p-0">
              <div className="relative aspect-[5/7] w-full overflow-hidden rounded-lg bg-secondary">
                {card.imageUris?.normal ? (
                  <img
                    src={card.imageUris.normal}
                    alt={card.name}
                    loading="lazy"
                    className="h-full w-full object-cover transition-all duration-300 group-hover:scale-105"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center bg-muted text-center text-xs text-muted-foreground p-2">
                    {card.name} (No Image)
                  </div>
                )}
                {/* Overlay with Set/Rarity/Number could go here */}
                <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/40 to-transparent p-2 text-white opacity-0 transition-opacity group-hover:opacity-100">
                   <p className="text-xs font-medium truncate">{card.name}</p>
                   <p className="text-[10px] opacity-80">{card.set.toUpperCase()} • #{card.collectorNumber}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      ))}
    </div>
  );
}
