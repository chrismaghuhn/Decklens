import type { DeckbuilderDeck } from "@/lib/deck-logic/types";
import type { AnalyzerCardView } from "@/lib/deck-logic/types";

export const MOCK_DECK: DeckbuilderDeck = {
  id: "1",
  name: "Atraxa Superfriends",
  description: "A comprehensive planeswalker control deck",
  visibility: "public",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  boards: {
    commander: [{ name: "Atraxa, Praetors' Voice", qty: 1, tags: [] }],
    mainboard: [
      { name: "Sol Ring", qty: 1, tags: [] },
      { name: "Arcane Signet", qty: 1, tags: [] },
      { name: "Doubling Season", qty: 1, tags: [] },
      { name: "Teferi, Time Raveler", qty: 1, tags: [] },
      { name: "Narset, Parter of Veils", qty: 1, tags: [] },
      { name: "Tamiyo, Field Researcher", qty: 1, tags: [] },
      { name: "Wrath of God", qty: 1, tags: [] },
      { name: "Swords to Plowshares", qty: 1, tags: [] },
      { name: "Cyclonic Rift", qty: 1, tags: [] },
      { name: "Demonic Tutor", qty: 1, tags: [] },
      { name: "Forest", qty: 4, tags: [] },
      { name: "Island", qty: 4, tags: [] },
      { name: "Swamp", qty: 4, tags: [] },
      { name: "Plains", qty: 4, tags: [] },
      { name: "Command Tower", qty: 1, tags: [] },
      { name: "Mana Crypt", qty: 1, tags: [] },
      { name: "Rhystic Study", qty: 1, tags: [] },
      { name: "Smothering Tithe", qty: 1, tags: [] },
    ],
    sideboard: [],
    maybeboard: [],
  },
};

export const MOCK_RESOLVER: Record<string, AnalyzerCardView> = {
  "atraxa, praetors' voice": { 
    name: "Atraxa, Praetors' Voice", cmc: 4, type_line: "Legendary Creature — Angel Horror", oracle_text: "Flying, vigilance, deathtouch, lifelink...", color_identity: ["W","U","B","G"] 
  },
  "sol ring": { name: "Sol Ring", cmc: 1, type_line: "Artifact", oracle_text: "Add {C}{C}.", color_identity: [] },
  "arcane signet": { name: "Arcane Signet", cmc: 2, type_line: "Artifact", oracle_text: "Add one mana of any color...", color_identity: [] },
  "doubling season": { name: "Doubling Season", cmc: 5, type_line: "Enchantment", oracle_text: "If an effect would create one or more tokens...", color_identity: ["G"] },
  "teferi, time raveler": { name: "Teferi, Time Raveler", cmc: 3, type_line: "Legendary Planeswalker — Teferi", oracle_text: "Each opponent can cast spells only...", color_identity: ["W","U"] },
  "narset, parter of veils": { name: "Narset, Parter of Veils", cmc: 3, type_line: "Legendary Planeswalker — Narset", oracle_text: "Each opponent can't draw more than...", color_identity: ["U"] },
  "tamiyo, field researcher": { name: "Tamiyo, Field Researcher", cmc: 4, type_line: "Legendary Planeswalker — Tamiyo", oracle_text: "+1: Choose up to two target creatures...", color_identity: ["W","U","G"] },
  "wrath of god": { name: "Wrath of God", cmc: 4, type_line: "Sorcery", oracle_text: "Destroy all creatures.", color_identity: ["W"] },
  "swords to plowshares": { name: "Swords to Plowshares", cmc: 1, type_line: "Instant", oracle_text: "Exile target creature.", color_identity: ["W"] },
  "cyclonic rift": { name: "Cyclonic Rift", cmc: 2, type_line: "Instant", oracle_text: "Return target nonland permanent...", color_identity: ["U"] },
  "demonic tutor": { name: "Demonic Tutor", cmc: 2, type_line: "Sorcery", oracle_text: "Search your library for a card...", color_identity: ["B"] },
  "forest": { name: "Forest", cmc: 0, type_line: "Basic Land — Forest", oracle_text: "{T}: Add {G}.", color_identity: ["G"] },
  "island": { name: "Island", cmc: 0, type_line: "Basic Land — Island", oracle_text: "{T}: Add {U}.", color_identity: ["U"] },
  "swamp": { name: "Swamp", cmc: 0, type_line: "Basic Land — Swamp", oracle_text: "{T}: Add {B}.", color_identity: ["B"] },
  "plains": { name: "Plains", cmc: 0, type_line: "Basic Land — Plains", oracle_text: "{T}: Add {W}.", color_identity: ["W"] },
  "command tower": { name: "Command Tower", cmc: 0, type_line: "Land", oracle_text: "{T}: Add one mana of any color...", color_identity: [] },
  "mana crypt": { name: "Mana Crypt", cmc: 0, type_line: "Artifact", oracle_text: "Add {C}{C}...", color_identity: [] },
  "rhystic study": { name: "Rhystic Study", cmc: 3, type_line: "Enchantment", oracle_text: "Whenever an opponent casts a spell...", color_identity: ["U"] },
  "smothering tithe": { name: "Smothering Tithe", cmc: 4, type_line: "Enchantment", oracle_text: "Whenever an opponent draws a card...", color_identity: ["W"] },
};
