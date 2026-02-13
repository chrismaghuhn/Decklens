"use client";

import { useMemo, useState, useEffect } from "react";
import { useDeck } from "@/hooks/use-deck";
import { estimatePowerLevel } from "@/lib/deck-logic/power-level";
import { computeAnalyticsData } from "@/lib/deck-logic/analytics";
import { getAutoTagForEntry } from "@/lib/deck-logic/auto-categories";
import { ManaCurveChart } from "@/components/analytics/mana-curve";
import { PowerLevelBadge } from "@/components/analytics/power-badge";
import { DeckSearchSidebar } from "@/components/deck/deck-search-sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, MoreHorizontal, Plus } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  DndContext,
  closestCenter,
  DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { SortableCardItem } from "@/components/deck/sortable-card-item";
import type { DeckbuilderDeck, DeckbuilderCardEntry } from "@/lib/deck-logic/types";

export default function DeckPage({ params }: { params: { id: string } }) {
  const { data: remoteData, isLoading, error } = useDeck(params.id);
  const [deck, setDeck] = useState<DeckbuilderDeck | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  useEffect(() => {
    if (remoteData?.deck) {
      setDeck(remoteData.deck);
    }
  }, [remoteData]);
  
  const resolver = remoteData?.resolvedCards || {};
  const sensors = useSensors(useSensor(PointerSensor));

  // Calculate stats
  const analytics = useMemo(() => {
    if (!deck) return null;
    return computeAnalyticsData(deck, resolver);
  }, [deck, resolver]);

  const power = useMemo(() => {
    if (!deck) return null;
    return estimatePowerLevel(deck, resolver);
  }, [deck, resolver]);

  // Group by Category
  const categorizedCards = useMemo(() => {
    if (!deck) return {};
    const groups: Record<string, DeckbuilderCardEntry[]> = {};
    
    // Initialize all possible categories to ensure order and droppability
    ['Commander', 'Land', 'Ramp', 'Draw', 'Removal', 'Board Wipe', 'Tutor', 'Utility'].forEach(cat => groups[cat] = []);

    if (deck.boards.commander) {
      deck.boards.commander.forEach(c => groups['Commander'].push(c));
    }
    
    deck.boards.mainboard.forEach(entry => {
      const tag = getAutoTagForEntry(entry, resolver);
      if (!groups[tag]) groups[tag] = [];
      groups[tag].push(entry);
    });

    return groups;
  }, [deck, resolver]);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || !deck) return;

    const activeId = active.id as string;
    const overId = over.id as string;

    if (activeId === overId) return;

    // Find the card and its old category
    let oldCategory: string | null = null;
    let cardEntry: DeckbuilderCardEntry | null = null;
    
    Object.entries(categorizedCards).forEach(([cat, cards]) => {
      const found = cards.find(c => c.name === activeId);
      if (found) {
        oldCategory = cat;
        cardEntry = found;
      }
    });

    // Find new category (overId might be a category ID or a card name)
    let newCategory: string | null = null;
    
    // Check if overId is a category
    if (categorizedCards[overId]) {
      newCategory = overId;
    } else {
      // Check if overId is a card within a category
      Object.entries(categorizedCards).forEach(([cat, cards]) => {
        if (cards.some(c => c.name === overId)) {
          newCategory = cat;
        }
      });
    }

    if (!oldCategory || !newCategory || !cardEntry || oldCategory === newCategory) return;
    
    // Update state locally for immediate feedback
    const newDeck = JSON.parse(JSON.stringify(deck)); // Deep copy
    
    // Remove from old
    if (oldCategory === 'Commander') {
        newDeck.boards.commander = newDeck.boards.commander.filter((c: DeckbuilderCardEntry) => c.name !== activeId);
    } else {
        newDeck.boards.mainboard = newDeck.boards.mainboard.filter((c: DeckbuilderCardEntry) => c.name !== activeId);
    }

    // Add to new
    if (newCategory === 'Commander') {
        newDeck.boards.commander.push(cardEntry);
    } else {
        // In a real implementation, we might want to update the card's tag/category metadata here
        newDeck.boards.mainboard.push(cardEntry);
    }
    
    setDeck(newDeck);
    
    // TODO: Persistence call to backend (likely an API update for card board/section)
  }

  if (isLoading) return <div className="p-12 text-center">Loading deck...</div>;
  if (error || !deck || !analytics || !power) return <div className="p-12 text-center text-red-500">Error loading deck: {error?.message}</div>;

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <div className="flex h-screen bg-background overflow-hidden">
        <div className="flex-1 flex flex-col min-w-0">
          {/* Header */}
          <header className="border-b bg-card flex-shrink-0">
              <div className="container py-4 flex items-center justify-between">
              <div className="flex items-center gap-4">
                  <Link href="/">
                      <Button variant="ghost" size="icon">
                          <ChevronLeft className="h-5 w-5" />
                      </Button>
                  </Link>
                  <div>
                      <h1 className="text-xl font-bold">{deck.name}</h1>
                      <p className="text-xs text-muted-foreground">Commander / {analytics.colors.W > 0 && 'W'}{analytics.colors.U > 0 && 'U'}{analytics.colors.B > 0 && 'B'}{analytics.colors.R > 0 && 'R'}{analytics.colors.G > 0 && 'G'}</p>
                  </div>
              </div>
              <div className="flex gap-2">
                  <Button onClick={() => setIsSearchOpen(!isSearchOpen)} variant={isSearchOpen ? "secondary" : "default"}>
                      <Plus className="h-4 w-4 mr-2" /> Add Cards
                  </Button>
                  <Button variant="ghost" size="icon"><MoreHorizontal /></Button>
              </div>
              </div>
          </header>

          {/* Content Scroll Area */}
          <div className="flex-1 overflow-y-auto">
              <div className="container py-6 grid lg:grid-cols-3 gap-6 pb-20">
              
              {/* Main Content: Deck List */}
              <div className="lg:col-span-2 space-y-6">
                  {Object.entries(categorizedCards).map(([category, cards]) => (
                      (category === 'Commander' ? cards.length > 0 : true) && (
                      <div key={category} id={category}>
                          <h3 className="font-semibold text-sm text-muted-foreground mb-2 flex justify-between items-end border-b pb-1">
                              <span>{category}</span>
                              <span className="text-xs">{cards.reduce((sum, c) => sum + c.qty, 0)}</span>
                          </h3>
                          <SortableContext items={cards.map(c => c.name)} strategy={verticalListSortingStrategy}>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {cards.map(entry => (
                                  <SortableCardItem key={entry.name} entry={entry} />
                                ))}
                                {cards.length === 0 && (
                                  <div className="h-10 border-2 border-dashed rounded-lg flex items-center justify-center text-xs text-muted-foreground col-span-full">
                                    Drop cards here
                                  </div>
                                )}
                            </div>
                          </SortableContext>
                      </div>
                      )
                  ))}
                  
                  {deck.boards.mainboard.length === 0 && deck.boards.commander.length === 0 && (
                      <div className="text-center py-20 text-muted-foreground border-2 border-dashed rounded-lg">
                          <p>This deck is empty.</p>
                          <Button variant="link" onClick={() => setIsSearchOpen(true)}>Start adding cards</Button>
                      </div>
                  )}
              </div>

              {/* Sidebar: Analytics */}
              <div className="space-y-6">
                  <PowerLevelBadge 
                      level={power.power} 
                      bracket={power.bracket} 
                      label={`${power.dominant} • ${power.saltLabel}`} 
                      factors={power.factors} 
                  />
                  
                  <ManaCurveChart curve={analytics.curve} />
                  
                  <Card>
                      <CardContent className="p-4 pt-6">
                          <div className="grid grid-cols-2 gap-4 text-center">
                              <div>
                                  <div className="text-2xl font-bold">{analytics.landCount}</div>
                                  <div className="text-xs text-muted-foreground">Lands</div>
                              </div>
                              <div>
                                  <div className="text-2xl font-bold">{power.avgCmc.toFixed(2)}</div>
                                  <div className="text-xs text-muted-foreground">Avg CMC</div>
                              </div>
                          </div>
                      </CardContent>
                  </Card>
              </div>

              </div>
          </div>
        </div>

        {/* Search Sidebar */}
        <div className={cn(
            "w-80 border-l bg-background transition-all duration-300 ease-in-out absolute right-0 top-0 bottom-0 z-20 shadow-2xl lg:relative lg:shadow-none",
            isSearchOpen ? "translate-x-0" : "translate-x-full lg:hidden lg:w-0"
        )}>
          {isSearchOpen && <DeckSearchSidebar deckId={params.id} onClose={() => setIsSearchOpen(false)} />}
        </div>
      </div>
    </DndContext>
  );
}

