"use client";

import { useCallback, useRef, useState } from "react";
import Webcam from "react-webcam";
import { Button } from "@/components/ui/button";
import { Card, useCardSearch } from "@/hooks/use-card-search";
import { SearchBar } from "@/components/search/search-bar";
import { toast } from "sonner";

export default function ScannerPage() {
  const webcamRef = useRef<Webcam>(null);
  const [matches, setMatches] = useState<Card[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [debugText, setDebugText] = useState("");
  const [manualQuery, setManualQuery] = useState("");
  
  // Hook for manual search
  const { data: searchResults, isLoading: isSearching } = useCardSearch(manualQuery);

  const capture = useCallback(() => {
    if (webcamRef.current) {
      const imageSrc = webcamRef.current.getScreenshot();
      if (imageSrc) {
        handleIdentify(imageSrc);
      }
    }
  }, [webcamRef]);

  const handleIdentify = async (base64Image: string) => {
    setIsScanning(true);
    setMatches([]);
    setDebugText("");
    setManualQuery(""); // Clear manual search on scan
    
    try {
      const res = await fetch('http://localhost:3001/scan/identify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: base64Image }),
      });
      const data = await res.json();
      
      if (data.card) {
          setMatches([data.card]);
          toast.success(`Found: ${data.card.name}`);
      } else if (data.candidates && data.candidates.length > 0) {
          setMatches(data.candidates);
          toast.info(`Found ${data.candidates.length} candidates`);
      } else {
          toast.warning("No card identified. Try manual search.");
      }
      
      if (data.rawText) {
          setDebugText(`OCR: "${data.rawText}"`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Error identifying card");
    } finally {
      setIsScanning(false);
    }
  };

  const handleAddToCollection = async (card: Card) => {
      const userId = '11111111-1111-1111-1111-111111111111';
      try {
        await fetch('http://localhost:3001/collection/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId, cardId: card.id, quantity: 1 }),
        });
        toast.success(`Added ${card.name} to collection`);
      } catch (e) {
        toast.error("Failed to add to collection");
      }
  };

  // Determine which cards to show
  const displayCards = manualQuery ? (searchResults?.data || []) : matches;
  const isLoading = isScanning || isSearching;

  return (
    <div className="flex min-h-screen flex-col items-center p-4 bg-background text-foreground pb-20">
      <h1 className="text-2xl font-bold mb-4">Card Scanner</h1>
      
      <div className="relative w-full max-w-md aspect-[3/4] bg-black rounded-lg overflow-hidden mb-4 shadow-lg border">
        <Webcam
          audio={false}
          ref={webcamRef}
          screenshotFormat="image/jpeg"
          videoConstraints={{ facingMode: "environment" }}
          className="absolute inset-0 w-full h-full object-cover"
        />
        <div className="absolute inset-0 border-4 border-white/20 pointer-events-none">
            <div className="absolute top-[10%] left-1/2 -translate-x-1/2 w-3/4 h-[15%] border-2 border-primary/80 rounded bg-primary/10"></div>
            <p className="absolute top-[5%] w-full text-center text-white text-xs font-bold drop-shadow-md">Align Name Here</p>
        </div>
      </div>

      <div className="flex flex-col gap-4 w-full max-w-md mb-6">
        <Button onClick={capture} disabled={isScanning} size="lg" className="w-full">
          {isScanning ? "Scanning..." : "Capture Card"}
        </Button>
        
        <div className="relative">
            <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or search manually</span>
            </div>
        </div>

        <SearchBar onSearch={setManualQuery} placeholder="Type card name..." />
      </div>
      
      {debugText && <p className="text-xs text-muted-foreground mb-4 font-mono bg-muted p-2 rounded">{debugText}</p>}

      <div className="w-full max-w-md">
        {(displayCards.length > 0 || isLoading) && (
            <>
                <h2 className="text-xl font-bold mb-2">
                    {manualQuery ? "Search Results" : "Scan Matches"}
                </h2>
                {isLoading ? (
                     <div className="space-y-2 animate-pulse">
                        {[1,2,3].map(i => <div key={i} className="h-16 bg-muted rounded"></div>)}
                     </div>
                ) : (
                    <div className="space-y-2">
                        {displayCards.map((card: Card) => (
                            <div key={card.id} className="flex items-center gap-3 border p-2 rounded hover:bg-accent transition-colors">
                                {card.imageUris?.small && <img src={card.imageUris.small} alt={card.name} className="w-12 h-16 rounded object-cover"/>}
                                <div className="flex-1 min-w-0">
                                    <p className="font-bold text-sm truncate">{card.name}</p>
                                    <p className="text-xs text-muted-foreground">{card.set.toUpperCase()} • {card.rarity}</p>
                                </div>
                                <Button size="sm" variant="secondary" onClick={() => handleAddToCollection(card)}>Add</Button>
                            </div>
                        ))}
                    </div>
                )}
            </>
        )}
      </div>
    </div>
  );
}
