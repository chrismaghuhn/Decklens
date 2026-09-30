# Was sich MTG-Spieler von einem Deckbuilder wuenschen

*Recherche vom 30.09.2026 fuer DeckLens. Vier parallele Web-Recherchen (Community-Feedback-Boards, App-Store-Reviews, Feature-Vergleich der Konkurrenz, Commander- und Playtest-Themen), rund 200 gelesene Seiten. Abgleich mit dem DeckLens-Stand (Playmat, backend-frei) in Abschnitt 8.*

> **Einschraenkung:** Reddit war fuer den Crawler und den Browser komplett gesperrt. Die Community-Stimmen kommen aus dem Moxfield-Feedback-Board (mit Upvote-Zahlen), dem Archidekt-Forum, TappedOut, MTGSalvation, Moxfield-GitHub, Steam-Diskussionen, App-Store-Reviews, YouTube-Kommentaren und Vergleichsartikeln (Draftsim, GrimDeck, ManaForge, Tap&Sac). Moxfield.com selbst liefert 403; dortige Angaben stammen aus dem oeffentlichen GitHub-Wiki und Reviews.

---

## 1. Kurzfassung: die zehn meistgewuenschten Dinge

Reihenfolge nach Gewicht der Belege (Upvotes, Haeufigkeit ueber Quellen, Nachdruck der Kommentare).

| # | Wunsch | Belege (Auswahl) |
|---|--------|------------------|
| 1 | **"Wo liegt diese Karte physisch?"** Sammlung mit Deck-Zuordnung: welches Deck haelt die Karte, wie viele Kopien sind frei, Cubes/Precons nicht als "besessen" zaehlen | Moxfield #776 "Strict Assignment to Collections", 618 Votes, Platz 1, seit Jahren "In Progress"; Archidekt-Threads; ManaBox-Reviews |
| 2 | **Versionierung von Decks**: Snapshots, Diff zwischen Versionen, Rollback, Forks (Budget vs. Upgrade), "geplante Aenderungen" | Moxfield #795, 584 Votes, Platz 2; GitHub #42/#48; Archidekt-Forum "sorely needed" |
| 3 | **Suche schliesst Karten aus, die schon im Deck sind**; Scryfall-Syntax aufs eigene Deck anwenden; Suche auf Commander-Farbidentitaet begrenzen | Moxfield 305 Votes, Platz 3; Archidekt-Thread seit 5 Jahren offen |
| 4 | **Bulk-Editing und leichteres Tagging**: Multi-Select, Massen-Verschieben/Taggen, Auto-Tagging beim Hinzufuegen, Sub-Kategorien, einklappbare Sektionen | Moxfield 253 / 135 / 110 / 91 / 82 / 80 Votes; Archidekt "[Builder] Subcategories" 240 Votes |
| 5 | **Sammlungsbewusstes Bauen**: "Was kann ich mit dem bauen, was ich habe?", EDHREC-Empfehlungen nur aus der Sammlung, Buylist der fehlenden Karten, Deckpreis minus Besitz | Moxfield 178 / 102 / 67 Votes; Archidekt-Dev: "nicht machbar"; ganze Produkte (GrimDeck, Spellweave, ManaForge, BinderBrew) entstehen genau auf dieser Luecke |
| 6 | **Preis- und Budget-Werkzeuge**: guenstigster Deckpreis unabhaengig vom Druck, Karten vom Preis ausnehmen, Decks nach Budget suchen, EUR/Cardmarket | Moxfield 161 / 142 / 113 / 114 Votes |
| 7 | **Besserer Playtester**: London-Mulligan, garantierte Karte in der Starthand, Gegner-Lebenspunkte und Commander-Schaden, Tokens per Rechtsklick von der Quellkarte, Undo, Tastatur-Zugschleife | Moxfield #1502/#1617/#2277/#1634/#1945; Archidekt Playtester-2.0-Thread; Draftsim |
| 8 | **Mobile**: native App oder wenigstens PWA mit Offline, Scan in die Sammlung, Geraete-Sync | Moxfield #1078 138 Votes; Archidekt "keine Plaene, ein Vollzeit-Dev" |
| 9 | **Ordner teilen / viele Decks organisieren**: Ordner-Links, Spalten in der Deckliste (MV, Farben, Preis, 287 Votes) | Draftsim und GrimDeck nennen "kann keine Ordner teilen" als Moxfields Haupt-Contra |
| 10 | **Commander-Intelligenz**: Commander-Spellbook-Combos im Deck (205 Votes), Bracket/Game-Changer-Zaehlung mit Erklaerung und manueller Korrektur, EDHREC-Cuts | Moxfield-Board; Archidekt Bracket-Threads; TopDecked |

Danach (weniger Gewicht, aber wiederkehrend): druckerfreundliche Deckliste (164 Votes), Custom-/Alter-Art-Karten (196), Proxys als eigene Klasse (nicht als Druck), Kollaboration in Echtzeit, Notizen pro Karte, "Core / nicht cutten / Cut-Kandidat"-Markierung (67), interaktive Statistiken (Balken klicken markiert Karten), umbelegbare Hotkeys.

---

## 2. Die groessten Schmerzpunkte mit bestehenden Tools

1. **Datenverlust und Sync-Konflikte.** Archidekt: "SO MANY TIMES my deck changes are not saved." TopDecked: Konfliktfehler, die Decklisten zuruecksetzen; 200 Karten weg. Dragon Shield: Ordnerinhalte verschwinden. Deckstats: Builder durch Werbung kaputt. Das ist ueber alle Plattformen die Beschwerde Nummer eins.
2. **UI entweder ueberladen oder zu starr.** Archidekt: "a cluttered mess", Draftsim gibt 1/5 fuer Intuitivitaet; Playtester 2.0: "it feels claustrophobic. Most zones are now hidden." MTGGoldfish: "an eyesore", mehrere Seitenladungen pro Edit. TappedOut: "acts like it's the mid-'00s", kein Autocomplete.
3. **Sammlung passt nicht zur physischen Realitaet.** Karten in mehreren Decks, Proxys nicht unterscheidbar ("I can't tell if a card is a proxy or not"), Reprints muellen die Sammlung zu, Scanner erkennen den falschen Druck.
4. **Features existieren, aber niemand findet sie.** Token-Liste unter der Werbung, Snapshots, Popout, Tag-Loeschung. Wiederkehrendes Muster: "Oh wow I didn't realize."
5. **Tagging ist Fleissarbeit.** "The most time consuming thing for me in mox is tagging all my cards." Gegenposition existiert: "i love moxfield because i hate using tags." Fazit: Auto-Kategorisierung ja, aber optional und einfach.
6. **Paywalls, Abos, Werbung.** TopDecked 5 USD/Monat blockiert Kernfunktionen (Draftsim: 1/5 fuer Bezahlmodell, "players expect free deck storage as standard"); ManaBox zeigt Werbung trotz Pro; Dragon Shield 100-Karten-Limit ("I hit that limit in about twenty minutes"); Moxfield-Werbung verdeckt die Hand im Playtester.
7. **Playtester-Grenzen.** Ueberall nur Goldfish; Moxfield ohne Mulligan; Archidekt mit Drag-Offset, fehlenden Tokens, Library-Scroll "80% failure rate" auf Mobile.
8. **Import/Export-Reibung.** Feld-Mismatch Moxfield/Archidekt, Umlaute brechen Imports, Maybeboards und Tokens landen in Proxy-Exporten ("76-card vibe deck"), Moxfield blockt Drittanbieter per Cloudflare.
9. **Performance bei Groesse.** Archidekt langsam ab 150 Karten, Export-Timeouts bei grossen Sammlungen; Cube/Grossdeck-Support ist Archidekts meistgewaehltes Feature (507 Votes).
10. **"Not feasible" von den Devs.** Archidekt lehnte ab: Sammlungs-limitiertes Bauen, Empfehlungen aus der Sammlung, Reprints zusammenfassen, Notizen pro Karte, KI-Gegner, Proxy-Druck. Jede Ablehnung hat echte Nachfrage dahinter.

---

## 3. Commander-spezifisch

Commander ist das dominierende Format; die Wuensche haben ein eigenes Profil.

- **Brackets und Game Changers sind seit Feb 2025 Pflicht.** Moxfield, Archidekt und TopDecked lieferten binnen Tagen. Was Nutzer danach forderten: Anzahl und Markierung der Game Changers, *Erklaerung* der Einstufung, manuelle Korrektur oder Abschalten, Sideboard/Considering aus der Rechnung raus, Sortierung nach Bracket, abschaltbares Icon. Kernkritik: "The bracket system measures intentions as much as it does the cards" (Archidekt-Dev). Regeln: B1/B2 null GC, B3 bis drei; B1–B3 keine Massen-Land-Zerstoerung; B1/B2 keine Zwei-Karten-Infinite-Combos; Update Okt 2025 mit Zug-Ankern (B3 ab Zug 6, B4 ab Zug 4). EDHREC: 40 % der Decks spielen null Game Changers, 80 % drei oder weniger.
- **Rollen-Zaehlung gegen eine Vorlage** ist die konsistenteste Bau-Praxis ueber alle Guides: Command-Zone-Template (38 Laender, 10 Ramp, 12 Card Advantage, 12 gezielte Disruption, 6 Massen-Disruption, ~22 Plan-Karten), 8x8, 7x9. Wichtig: eine Karte darf in mehreren Kategorien zaehlen. "A template lets you go from idea to playtesting quickly while making sure you're not missing any of the basics."
- **Combo-Erkennung ueber Commander Spellbook**, inklusive Voraussetzungen und "eine Karte entfernt". Archidekts Integration verschluckt Prerequisites ("this is NOT a 2 card combo"); Drei-Karten-Combos sind fuer die Bracket-Rechnung unsichtbar.
- **EDHREC im Builder**, filterbar nach Kategorie und Sammlung, plus EDHRECs "Cuts". Gegenstroemung: "If you only use EDHREC, you end up building the same deck as everyone else." DeckCheck wirbt mit Empfehlungen, die nur das eigene Deck ansehen.
- **"Was cutten?"-Helfer**: Staging-Stapel zwischen Considering und Main (Moxfield #1472), Cut-Heuristiken (7+ MV zuerst, Laender nie).
- **Laender-Mathematik** nach Karsten mit MDFC-Behandlung (MDFC als Land zaehlen: Moxfield #1344/#1560).
- **Partner / Background / Companion** ohne Validierungs-Rauschen. Archidekt-Companion-Thread seit 4+ Jahren offen; Backgrounds nur per undokumentiertem Workaround.
- **Salt Score** ist gewuenscht, aber als Spass-Metrik, nie als Gate. Basics erhoehen ihn absurderweise (Island 0.72 vs. Underground Sea 0.64).
- **Precon-Upgrade-Pfade**: meist-hinzugefuegt / meist-gecuttet gegen die Precon-Liste.
- **Budget**: Basics nicht in den Deckpreis, Suche nach Deckpreis, Gesamtpreis aller Decks.

---

## 4. Playtesting und virtuelle Playmat

Der Playtester ist ein echtes Retention-Feature: Moxfields meistgelobtes Feature, Archidekts meistkritisiertes, und der Grund, warum Leute Listen kopieren ("I find myself having to c&p to another site to playtest").

Rangfolge der Wuensche:

1. **Sofortige Starthaende mit London-Mulligan und Hand-Statistiken** (Keep-7/Mull-6/Mull-5-Raten ueber viele Simulationen, Laender und MV pro Hand, "each deal is one click"). Empfohlener Workflow: 10 Haende, bis Zug 5 spielen, Ramp bis Zug 3, Draw bis Zug 5, Commander im Zeitplan.
2. **Tokens und Counter billig erzeugen**: Rechtsklick auf die Quellkarte statt Token-Menue, Counter auf alle Kreaturen, Hotkeys fuer Counter, Lieblings-Token-Art.
3. **Tastatur fuer die ganze Zugschleife**: Untap+Draw in einer Taste, Library-Suche, Bottom, "X Karten tief legen", Cascade-Exile.
4. **Undo** (Untap.in hat ein volles Rewind).
5. **Etwas, das zurueckschlaegt**: Archidekts "Interaction Simulator" (Sept 2026: zufaelliges Removal, Counter, Angriffe, Wipes mit Archetyp-Presets, noch mit Unsinns-Zuegen), Playgroup.gg "Sparring" ("Most playtesters just goldfish. This one fights back."), "Fauxponent" (Moxfield #1617: Zug 2 spawnt ein 2/2). Volle KI lehnen alle Devs ab.
6. **Multiplayer-Tracker**: Gegner-Leben, Commander-Schaden pro Gegner, Poison/Energy/Experience/Monarch.
7. **Library-Manipulation**: Suche, Scry/Top N, Reveal, Bottom, zufaelliger Discard, Hand sortieren.
8. **Board-Lesbarkeit**: Kartengroesse, Handgroesse, sichtbare Zonen, Snap/Gruppierung, Multi-Select mit P/T-Summe. Archidekt 2.0 wurde fuer versteckte Zonen und riesige Hand abgestraft ("hand covers 3/5ths of the screen").
9. **Mobile**: Zonen kollidieren mit Android-Navbar, Library-Scroll kaputt, 30-Karten-Hand unsichtbar.
10. **Teilen / Popout / Action-Log** fuer SpellTable und Webcam.
11. **Save State, Replays, Seed teilen** (Moxfield GitHub #145).
12. **Persistente Kosmetik** (Sleeves, Playmat-Farbe), keine Werbung im Tester.

Regel-Enforcement will niemand im Deckbuilder; Freeform-Tisch ist akzeptiert.

---

## 5. Mobile und Sammlung (App-Reviews)

- **Scanner-Fehlerkennung** (Set, Druck, Foil) ist Beschwerde Nummer eins bei allen Scan-Apps (ManaBox, Dragon Shield, Delver, TCGplayer, CardCastle): "at least 1 card that scans wrong" pro Session, schwarze Karten und Borderless sind Problemfaelle.
- **Sammlung nicht mit dem Builder verdrahtet** (Dragon Shield: zweimal scannen; Moxfield: 15 Nolt-Threads zu "nur Besitz zeigen/ausschliessen/gruppieren"; Archidekt: "Prioritize card versions in your collection" 367 Votes).
- **"Was fehlt mir?"** mit Anzahl (nicht nur Preis), Buylist-Export nur der fehlenden Karten, Wishlist ohne bereits besessene Karten (Moxfield #1275, #2226, GitHub #58).
- **Mehrfachkopien ueber Decks**: "the collection feature does not help very much" wenn die Karte in mehreren Decks ist; Proxy-pro-Deck; Deckstats-Nutzer fuehrt Excel fuer "wo liegt das Original".
- **Besitz-Metadaten**: Proxy-Flag ohne Wert-Verzerrung, Foil, Sprache, Kaufpreis vs. Marktwert, Sealed-Produkte.
- **Offline und PWA** als Differenzierer neuer Apps (Decksmith: "The whole app works offline, with no account").

---

## 6. Wohin der Markt geht (2024–2026)

1. Commander-Brackets wurden binnen Wochen Standard; Rechner-Nischenprodukte (Farseek, EDHcheck, Scrollvault) gehen ueber Game Changers hinaus (MLD, Extra Turns, Fast Mana, Tutoren, 2-Karten-Combos, Monte-Carlo-Win-Turn).
2. Combo-/Synergie-Bewusstsein wandert in den Builder (Archidekt + Spellbook; Spellweave; EDHcheck).
3. **Sammlungsbewusstes Bauen ist der neue Differenzierer** (GrimDeck, Spellweave, ManaForge "stock mode", MTGGoldfish SuperBrew, Deckbox). Reviews ziehen Moxfield hier regelmaessig ab.
4. KI-Einsteiger vermehren sich (ManaForge, Spellweave, MTG Deck Tools, ManaTap); die Platzhirsche bauen stattdessen Mensch-Hilfe-Schleifen (Archidekt Deck Help, Jul 2026).
5. Klügeres Playtesting (Archidekt Interaction Simulator, Batch-Goldfish-Simulationen).
6. Rollen ueber Scryfall-Oracle-Tags (Archidekt Jul 2026, Cube Cobra).
7. Proxys und Custom Cards werden Mainstream (Archidekt Custom Cards Nov 2025, ManaBox Proxy-Flag und -Export Sept 2026).
8. Mobile-first-Apps draengen auf Desktop, Web-first-Seiten fixen Mobile.
9. Interop wird enger (ManaBox importiert 8 Seiten-URLs), Gegentrend: Moxfield sperrt Drittanbieter aus, EDHcheck baut deshalb einen eigenen Editor.
10. Vendor-Preis-Transparenz (Archidekt Preis pro Vendor und Kategorie, TopDecked/Dragon-Shield-Trends).

---

## 7. Feature-Matrix der Konkurrenz (Auszug)

Y = ja, P = teilweise, N = nein, ? = nicht verifiziert.

| Feature | Moxfield | Archidekt | TappedOut | Deckstats | MTGGoldfish | ManaBox | TopDecked |
|---|---|---|---|---|---|---|---|
| Visuelle Stapel-Ansicht | Y | Y | ? | P | Y | Y | Y |
| Drag and Drop | Y | Y | N | ? | N | N | ? |
| Kategorien/Tags | Y | Y (auto, Sub-Kat.) | P | ? | ? | P | Y |
| Preis-Vendoren | TCG/CM/CH | TCG/CK/CM/CH | ? | Y | CK/TCG/CH | TCG/CM/CK/CH | Trends |
| Sammlung im Builder | P | Y | ? | Y | Y (Premium) | Y | Y |
| Versionierung | Y (History, kein Revert) | P (Undo) | P | ? | ? | N | ? |
| Playtest | Y | Y (2.0 + Simulator) | Y | P | ? | Y (Pro) | Y (4 Decks) |
| London-Mulligan | N | Y | N | P | ? | ? | ? |
| Bracket/Game Changers | Y | Y (+ Override) | P | N | N | N | Y |
| Spellbook-Combos | N | Y | N | N | N | N | N |
| EDHREC | Y | Y (+ Cuts) | N | Y | N | P | P |
| Offline | N | N | N | N | N | Y | ? |
| Proxy-Druck | ? | P | ? | ? | ? | Y | ? |
| Kollaboration | N | Y | N | N | N | N | N |
| Kosten | frei, Patreon | frei, Patreon | frei | frei | 5.99 USD/M | 2.49 USD/M | ~5 USD/M |

Reputation in einem Satz: Moxfield = schnellster, sauberster Editor und bester Playtester, aber Sammlung "secondary" und keine Ordner-Freigabe. Archidekt = beste Rollen-Organisation, Bracket, Kollaboration, aber "overwhelming" und Mobile lange vernachlaessigt. TappedOut = Community, aber UI aus den 2000ern. Deckstats = beste Wahrscheinlichkeitsrechnung, sonst karg. MTGGoldfish = Meta-Daten, Editor "wie Dial-up". ManaBox = bester Scanner, mobil-only. TopDecked = guter Simulator, Abo-Zwang.

---

## 8. Abgleich mit DeckLens

### Was DeckLens heute schon abdeckt

- Playmat mit sechs Sortiermodi (Typ/Mana/Farbe/Rolle/Tags/frei), Snap-to-Grid, Pile-Header-Drag, Dichte/Collapse, Mengen-Buttons, Format-Picker. Das trifft Wunsch 4 (visuelle Organisation) und den Kritikpunkt "cluttered vs. rigid" direkt.
- Rollen-Klassifikator (11 Rollen) und Health Score mit Empfehlungen, Synergy Map, Draw Probability (hypergeometrisch), EDH-Regeln mit Ersatzvorschlaegen fuer gebannte Karten, Live-Validierung (Singleton, Farbidentitaet, Deckgroesse, Bans).
- Goldfish-Playtester mit Undo (Z/Ctrl+Z), Draw (D), Untap (U), Tokens (T), Library-Suche (S), Top-N/Scry (L), Graveyard/Exile-Zonen, Phasen (Space), Leben/Poison, Counter, Mulligan.
- Export in Text/Arena/MTGO/CSV/JSON/Moxfield, Share-URL (komprimiert, ohne Backend), Proxy-Druck-HTML, Deck-Bild, Preise EUR/USD ueber Scryfall, CSV-Sammlungsimport (Modul vorhanden, nicht in die Playmat verdrahtet).
- Backend-frei, lokal, keine Accounts, keine Werbung, kein Abo. Das adressiert Schmerzpunkt 6 (Paywalls) und teilweise 1 (kein Sync-Konflikt, weil kein Sync).

### Luecken, sortiert nach Hebel fuer DeckLens

Kriterien: Nachfrage in der Recherche, Passung zur backend-freien Architektur, Aufwand.

1. **Deck-Versionierung lokal** (Wunsch 2, 584 Votes, bei Moxfield seit Jahren offen). Snapshots in localStorage/IndexedDB, Diff-Ansicht "was muss ich im Papierdeck tauschen", Rollback, Fork. Ein lokales Tool kann das ohne Server-Kosten sofort liefern; der Undo-Stack existiert bereits als Basis.
2. **Rollen-Zaehlung gegen Vorlage** (Abschnitt 3). Der Rollen-Klassifikator und der Health Score sind da; es fehlt eine sichtbare Soll/Ist-Leiste (Command Zone / 8x8 / 7x9, editierbare Ziele), Mehrfach-Rollen pro Karte und ein Klick von der Luecke in die Suche. Geringer Aufwand, hoher Nutzen fuer Commander.
3. **Bracket und Game Changers** (Abschnitt 3, seit Feb 2025 Tabellen-Standard). Scryfall liefert das Game-Changer-Flag pro Karte (pruefen: Feld `game_changer`). Anforderungen aus den Beschwerden: Zaehlung plus Markierung, Erklaerung *warum*, manueller Override, Sideboard raus, MLD/Extra-Turn-Heuristiken. Der einzige Bracket-Treffer im Code ist heute ein Kommentar.
4. **Suche: Karten im Deck ausblenden, Scryfall-Syntax aufs Deck, Commander-Farbidentitaet als Filter** (Wunsch 3, 305 Votes). Die Scryfall-Suche ist direkt angebunden; Farbidentitaet ist in der Validierung schon bekannt.
5. **Sammlung in die Playmat verdrahten** (Wunsch 1 und 5, die beiden groessten Luecken des Markts). Lokal ist "physische Realitaet" sogar leichter: Besitz-Anzahl pro Karte in der Playmat, "in welchem Deck liegt die Karte", freie Kopien, Proxy-Flag, Buylist-Export nur der fehlenden Karten, Deckpreis minus Besitz. Das CSV-Import-Modul existiert bereits.
6. **Playtester-Ausbau** (Abschnitt 4). Vorhanden ist viel; fehlend laut Recherche: Hand-Statistiken ueber N Simulationen (Keep-Raten, Laender pro Hand), garantierte Karte in der Starthand, Tokens per Rechtsklick von der Quellkarte, Counter-Hotkeys, Gegner-Leben/Commander-Schaden-Widget, Untap+Draw in einer Taste, Save State. Spaeter: ein einfacher "Fauxponent" (Removal/Wipe auf Zufall), der nach Archidekts Erfahrung mit Presets und einem "ergibt keinen Sinn"-Reroll kommen sollte.
7. **Multi-Select auf der Playmat** (Wunsch 4, 253 Votes): Rubber-Band-Auswahl im freien Modus, dann verschieben/taggen/Rolle setzen. Passt natuerlich zur Playmat-Metapher.
8. **Commander Spellbook** (205 Votes): oeffentliche API, clientseitig nutzbar; "Combos im Deck" und "eine Karte entfernt", mit Prerequisites (Archidekts Fehler vermeiden). Die Synergy Map koennte darauf aufsetzen.
9. **Auto-Tagging beim Hinzufuegen aus der Suche** (80 Votes) und Tag-Hierarchien. Der Tags-Sortiermodus existiert.
10. **PWA mit Offline-Cache** (Wunsch 8). Ohne Backend ist DeckLens ein natuerlicher Kandidat; Scryfall-Bilder muessten gecacht werden. Native App ist fuer die Konkurrenz unerreichbar ("ein Vollzeit-Dev"), fuer DeckLens ebenso, aber PWA ist billig.
11. **Druckerfreundliche Deckliste** (164 Votes) zusaetzlich zum Proxy-Druck: sortiert nach Kategorie und Druck, "zum Zusammenbauen".
12. **Discoverability**: Die Recherche zeigt, dass Features in Drawers und unter Ads verschwinden. Fuer die Playmat heisst das: Hotkey-Hilfe (im Goldfish mit `?` vorhanden), Onboarding-Hinweise fuer Sortiermodi und Drawers.

### Was DeckLens bewusst nicht kann

Community, Kommentare, oeffentliche Deck-Suche, Echtzeit-Kollaboration, Ordner-Freigabe, Cloud-Sync. Die Recherche zeigt, dass der Social Layer Retention bringt (TappedOut ueberlebt nur deshalb), aber auch, dass Moxfields Kernwert Geschwindigkeit und Sauberkeit ist und die groessten offenen Wuensche (Versionierung, Sammlung, Suche) gerade *nicht* am Backend haengen. Der Trade-off ist vertretbar, solange Share-URL und Export lossless bleiben.

### Offene Punkte

- `storage.normalizeDeck` verwirft laut Memory `format`/`notes`. Fuer Versionierung und Primer muss das vorher gefixt werden.
- Playmat-UI ist Deutsch, Rest der Seite Englisch. Die Recherche ist komplett englischsprachig; Zielgruppe entscheiden.

---

## 9. Quellen (Auswahl der tragenden Belege)

Moxfield Feedback-Board (Upvotes Stand Sept 2026): https://moxfield.nolt.io/top, /776, /795, /1078, /1502, /1617, /2277, /1634, /1945, /1275, /2226, /2240, /2284, /1289, /1288, /1680, /1421, /849, /1853, /1850, /1846, /1472, /1344

Moxfield GitHub: https://github.com/moxfield/moxfield-public/issues (Nr. 42, 48, 50, 58, 123, 145), Wiki "Features"

Archidekt: https://archidekt.com/features (Votes), /news/11356226 (Brackets), /news/3417345 (Playtester 2.0), /news/26104256 (Interaction Simulator), /news/22633051 (Mobile), /news/24799503 (Deck Help), /forum/thread/5878032, /8562906, /2341715, /44222, /468408, /14607808, /19572447, /12475080, /5077056, /6733261, /7059508, /17214, /3298946, /2377696

TappedOut: /mtg-forum/general/tappedout-vs-moxfield/, /mtg-forum/tappedout/is-tappedout-dying/, /mtg-forum/site-updates/find-decks-from-your-inventor/, /mtg-forum/commander/power-level-ratings-tool/

Vergleiche: https://draftsim.com/best-mtg-deck-builder/, https://draftsim.com/mtg-edh-deck-builder/, https://draftsim.com/mtg-deck-tester/, https://grimdeck.com/blog/best-mtg-deck-builder-sites, https://grimdeck.com/blog/best-commander-deck-building-tools, https://manaforge.tools/en/blog/manaforge-vs-moxfield-vs-archidekt, https://tapandsac.com/what-is-the-best-mtg-deck-builder-website

Commander: https://magic.wizards.com/en/news/announcements/introducing-commander-brackets-beta, https://edhrec.com/articles/wizards-of-the-coast-commander-brackets-update-for-october-2025, https://edhrec.com/articles/wotc-introduces-new-bracket-system-for-edh, https://edhrec.com/guides/edhrec-guide-to-upgrading-your-commander-deck, https://edhrec.com/guides/how-to-use-commander-spellbook-the-combo-search-engine, https://commanderspellbook.com/find-my-combos/, https://commanderdeckmaker.com/learn/deckbuilding/command-zone-template, https://witchphd.substack.com/p/7x9-every-time, https://scrollvault.net/tools/commander-bracket/, https://scrollvault.net/guides/how-many-lands.html, https://playgroup.gg/commander/how-many-lands

Playtesting: https://playgroup.gg/playtest, https://edhcheck.com/deck-tester/, https://scrollvault.net/tools/hand-simulator/, https://blog.edhlab.gg/anatomy-of-a-playtest-game/, https://untap.in/updates, https://grimdeck.com/blog/how-to-playtest-a-commander-deck-before-game-night, https://github.com/Card-Forge/forge/wiki/ai

App-Reviews: https://apps.apple.com/us/app/manabox-mtg/id1460407674?see-all=reviews, https://apps.apple.com/us/app/topdecked-mtg/id1173388234?see-all=reviews, https://apps.apple.com/us/app/mtg-scanner-dragon-shield/id1460657155?see-all=reviews, https://www.scanyourmtg.com/review/dragon-shield/, https://justuseapp.com/en/app/1460407674/manabox/reviews

YouTube-Kommentare: https://www.youtube.com/watch?v=-YyxY3KYIQA (Moxfield vs Archidekt), https://www.youtube.com/watch?v=OIzzeltdOCc (Switched to Moxfield after 3 years on Archidekt)

Neue Anbieter: https://spellweave.app/, https://manaforge.tools/en, https://deckcheck.co/, https://www.deckflow.gg/sync, https://github.com/sbdev64/99Overlap, https://apps.apple.com/us/app/decksmith/id6756268708, https://binderbrew.com/moxfield-deck-builder
