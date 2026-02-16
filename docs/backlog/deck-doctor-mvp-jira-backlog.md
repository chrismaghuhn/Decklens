# Deck Doctor MVP (4 Wochen) - Jira Backlog

Dieses Dokument ist fuer die direkte Uebernahme in Jira gedacht (Epics -> Stories -> Tasks).

## Planungsrahmen

- Scope: MVP in 4 Wochen
- Aufwand: 68 SP (P0 Must-Have) + 5 SP (P1 Optional)
- Zieltempo: ca. 17 SP/Woche
- Reihenfolge: Woche 1 Fundament, Woche 2 Engine, Woche 3 Meta/Apply, Woche 4 Hardening/Beta

## Epics

| Epic-ID | Titel | Ziel |
|---|---|---|
| DD-EP1 | Import & Data Foundation | Deck + Collection sauber ingestieren, Flow lauffaehig machen |
| DD-EP2 | Deck Doctor Engine | Top-5 Empfehlungen inkl. 3 Cuts/3 Adds mit Explainability |
| DD-EP3 | Meta & Matchup Intelligence | Meta-Mode + Matchup/Sideboard/Gameplan ausgeben |
| DD-EP4 | Apply, Export & Beta Launch | One-click Apply, Export, Performance, Beta-Steuerung |

## Stories (anlegbar)

| Story-ID | Epic | Prio | SP | Sprint/Woche | Story | Akzeptanzkriterien |
|---|---|---|---:|---|---|---|
| DD-101 | DD-EP1 | P0 | 5 | Woche 1 | Deck-Import Parser + Validierung | 95% Fixture-Decks parsebar; fehlerhafte Zeilen mit klarer Meldung |
| DD-102 | DD-EP1 | P0 | 2 | Woche 1 | Import-Flow UI (Import -> Analyse -> Export) | End-to-end Flow ohne Sackgasse auf Desktop + Mobile |
| DD-103 | DD-EP1 | P0 | 8 | Woche 1 | Collection-CSV Import + Card-Normalisierung | >=90% Zeilen automatisch gemappt; Rest manuell aufloesbar |
| DD-104 | DD-EP1 | P0 | 2 | Woche 1 | Core Event Tracking | Funnel-Events von `deck_imported` bis `export_clicked` sichtbar |
| DD-201 | DD-EP2 | P0 | 8 | Woche 2 | Recommendation Engine v1 (Top 5 inkl. 3 Cuts/3 Adds) | Ausgabe enthaelt min. 3 belastbare Cut/Add-Paare |
| DD-202 | DD-EP2 | P0 | 5 | Woche 2 | Explainability + Confidence | Jede Empfehlung hat Grundtext, Confidence (0-1), Logik-Tags |
| DD-203 | DD-EP2 | P0 | 5 | Woche 2 | Collection-first + Gap-Hinweis | Adds standardmaessig nur aus Sammlung; sonst "fehlen noch X Karten" |
| DD-204 | DD-EP2 | P0 | 3 | Woche 2 | Preis + Power-Impact Anreicherung | Jede Empfehlung zeigt Preis + Power-Impact |
| DD-301 | DD-EP3 | P0 | 2 | Woche 3 | Meta-Mode Selector (Local/FNM/Commander-Pod) | Auswahl ist persistent und analyserelevant |
| DD-302 | DD-EP3 | P0 | 8 | Woche 3 | Matchup Guide Generator | Mindestens 3 Matchup-Plaene je Analyse |
| DD-303 | DD-EP3 | P0 | 5 | Woche 3 | Sideboard-/Gameplan-Block je Matchup | Pro Matchup klare In/Out- oder Plan-Instruction |
| DD-401 | DD-EP4 | P0 | 5 | Woche 3 | One-click Apply fuer Empfehlungen | Uebernahme aktualisiert Deck atomar; Undo vorhanden |
| DD-402 | DD-EP4 | P0 | 3 | Woche 4 | Export aktualisierte Deckliste | Export entspricht 1:1 dem aktuellen Deck-State |
| DD-403 | DD-EP4 | P0 | 5 | Woche 4 | Performance + Reliability Hardening | p95 Analysezeit <=60s; Erfolgsrate >=98% |
| DD-404 | DD-EP4 | P0 | 2 | Woche 4 | Beta Dashboard + Feedback Loop | Funnel-KPIs, Feedback-Kanal und Triage-Rhythmus aktiv |
| DD-405 | DD-EP4 | P1 | 5 | Woche 4 | Shareable Report Card v1 (optional) | Teilbarer Link; keine privaten Collection-Daten |

## Tasks (Sub-Tasks pro Story)

### DD-101 - Deck-Import Parser + Validierung
- DD-101-T1: Parser-Service fuer Decklisten-Formate
- DD-101-T2: Validierungsmodell + Fehlertexte
- DD-101-T3: Fixture-Tests + Parser-Edgecases

### DD-102 - Import-Flow UI
- DD-102-T1: Stepper/UI-State fuer 3-Schritt-Flow
- DD-102-T2: Loading/Error/Retry States
- DD-102-T3: Responsive QA (mobile-first)

### DD-103 - Collection-CSV Import + Normalisierung
- DD-103-T1: CSV-Mapping (Spaltenzuordnung)
- DD-103-T2: Card-ID-Normalisierung + Dedupe
- DD-103-T3: Unresolved-Row UI + Tests

### DD-104 - Core Event Tracking
- DD-104-T1: Event-Schema definieren
- DD-104-T2: Client/Server Instrumentierung
- DD-104-T3: Analytics-Validierung im Staging

### DD-201 - Recommendation Engine v1
- DD-201-T1: Heuristiken (Synergie/Curve/Mana) implementieren
- DD-201-T2: Ranking + Top-5 Selection
- DD-201-T3: Analyse-API + Contract Tests

### DD-202 - Explainability + Confidence
- DD-202-T1: Reason-Template Engine
- DD-202-T2: Confidence Scoring
- DD-202-T3: Explainability UI (Tags + Confidence Anzeige)

### DD-203 - Collection-first + Gap-Hinweis
- DD-203-T1: Owned-only Filter als Default
- DD-203-T2: Missing-X Berechnung
- DD-203-T3: Toggle "include missing cards" + CTA

### DD-204 - Preis + Power-Impact
- DD-204-T1: Preisdaten-Adapter
- DD-204-T2: Power-Impact Heuristik
- DD-204-T3: Preis/Impact Anzeige inkl. Gesamtdelta

### DD-301 - Meta-Mode Selector
- DD-301-T1: Meta-Mode UI-Komponente
- DD-301-T2: Persistenz (User/Session)
- DD-301-T3: Meta-Context im Analyse-Request

### DD-302 - Matchup Guide Generator
- DD-302-T1: Matchup-Template-Set pro Mode
- DD-302-T2: Generator fuer Top-3 Matchups
- DD-302-T3: Matchup-Card Rendering

### DD-303 - Sideboard-/Gameplan-Block je Matchup
- DD-303-T1: Sideboard-In/Out Logik
- DD-303-T2: Pre-/Post-Board Gameplan Text
- DD-303-T3: Fallback ohne Sideboard

### DD-401 - One-click Apply
- DD-401-T1: Apply-Mutations atomar
- DD-401-T2: Undo/Redo letzter Apply
- DD-401-T3: Event `recommendation_applied`

### DD-402 - Export aktualisierte Deckliste
- DD-402-T1: Export-Serializer (Text/Copy)
- DD-402-T2: Export-UI Action
- DD-402-T3: Export-Integritaetstests

### DD-403 - Performance + Reliability Hardening
- DD-403-T1: Caching/Precompute fuer Card-Metriken
- DD-403-T2: Retry/Timeout/Graceful Failure
- DD-403-T3: Lasttest + Tuning auf <=60s p95

### DD-404 - Beta Dashboard + Feedback Loop
- DD-404-T1: KPI-Dashboard (Import -> Analyse -> Apply -> Export)
- DD-404-T2: In-App Feedback Capture
- DD-404-T3: Woechentliche Triage-Checkliste

### DD-405 - Shareable Report Card v1 (optional)
- DD-405-T1: Report Card UI
- DD-405-T2: Share-Link Endpoint
- DD-405-T3: Public View Privacy Guard

## Sprint-Zuschnitt (Empfehlung)

- Woche 1: DD-101 bis DD-104
- Woche 2: DD-201 bis DD-204
- Woche 3: DD-301 bis DD-303 plus DD-401
- Woche 4: DD-402 bis DD-404 (DD-405 bei Puffer)

## Go/No-Go fuer Beta

- p95 Analysezeit <= 60s
- >=35% `recommendation_applied` pro abgeschlossener Analyse
- >=80% Add-Empfehlungen aus Sammlung oder mit Gap-Hinweis
- Kritische Bugs in Import/Apply/Export = 0
