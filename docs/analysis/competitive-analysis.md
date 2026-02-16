# Competitive Analysis: Moxfield vs Archidekt

*Compiled February 2026 for DeckLens competitive positioning.*

> **Note**: This analysis is based on knowledge through mid-2025. Both platforms update frequently; verify specific pricing and feature availability against their current sites.

---

## 1. MOXFIELD

### 1.1 Platform(s)
- **Web**: Primary platform (moxfield.com) - fully responsive SPA
- **iOS**: Native app launched ~2023, continuously updated
- **Android**: Native app launched ~2023, continuously updated
- **PWA**: The web app is installable as a Progressive Web App on mobile

### 1.2 Target Audience
- **Primary**: Commander/EDH players (the dominant user segment)
- **Secondary**: Competitive constructed players (Standard, Modern, Pioneer, Legacy)
- **Tertiary**: Casual players, collectors managing inventories
- Commander is the platform's gravitational center -- the UI defaults, community discovery, and recommendation tools all skew heavily toward EDH.

### 1.3 Core Value Proposition
Moxfield is the fastest, most polished MTG deckbuilder with deep Scryfall-powered search, instant card previews, and community-driven deck discovery -- positioned as the modern successor to TappedOut.

### 1.4 Maturity: Modern (Mature)
- **Reasoning**: Founded ~2019, rapid growth to become the dominant deckbuilder by 2023-2024. Professional-grade engineering (React SPA, performant APIs), regular feature releases, established revenue model via Moxfield Premium. Has largely displaced TappedOut and competes directly with Archidekt. The platform feels polished and production-grade, not a hobby project.

---

### 1.5 Deckbuilding Features

#### Card Search
- **Autocomplete**: Real-time autocomplete as you type in the "Add Card" search bar (top of the deck editor). Results appear in a dropdown with card images and names. Extremely fast -- typically sub-200ms.
- **Scryfall Syntax**: Supports a subset of Scryfall search syntax for advanced queries. Users can search by oracle text, type line, color identity, CMC, power/toughness, etc. The search bar in the editor sidebar accepts queries like `t:creature c:urg cmc<=3`.
- **Oracle Text Search**: Yes -- users can search within oracle text (rules text) directly. Available both in the quick-add bar and in the advanced search/browse modal.
- **DFC Handling (Double-Faced Cards)**: MDFCs and transform cards display both faces. Hovering shows the front face; clicking or a secondary interaction reveals the back face. In the deck list, the front face name is used. The card detail modal shows both faces side by side.
- **Commander Identity Filtering**: When a commander is designated in an EDH deck, the search automatically filters results to cards within the commander's color identity. This is on by default and can be toggled. Found in the editor sidebar search settings.

#### Filters
- **Color**: Filter by color identity (W/U/B/R/G), colorless, multicolor. Supports exact, at-most, and includes modes.
- **Type**: Filter by card type (creature, instant, sorcery, enchantment, artifact, planeswalker, land, battle).
- **Set**: Filter by specific set/expansion. Dropdown with set symbols.
- **Rarity**: Common, uncommon, rare, mythic rare.
- **Mana Value (CMC)**: Numeric filter with equals, less-than, greater-than operators.
- **Format Legality**: Filter to cards legal in a specific format (Standard, Modern, Pioneer, Legacy, Vintage, Commander, Pauper, etc.). Integrated into the editor when a format is selected for the deck.
- **Budget**: No native "budget filter" in the search panel, but price is displayed on each card and the deck total price is shown. Users can sort by price. There is no "show cards under $X" filter natively.
- **Additional**: Keywords, artist, flavor text, power/toughness ranges.

#### Import/Export
- **Import**:
  - Text list (paste a card list with quantities)
  - MTG Arena format (copy-paste from Arena)
  - MTGO format (.dek files)
  - URL import from other deckbuilding sites (limited support)
  - Clipboard paste directly into the editor
- **Export**:
  - Text list (plain text)
  - MTG Arena export (clipboard copy, formatted for Arena import)
  - MTGO export (.dek file download)
  - CSV export (for spreadsheet analysis)
  - Image export (visual deck image, useful for social sharing) -- **Premium feature**
  - PDF export -- **Premium feature**
  - No direct tournament-format export (e.g., WER/Companion app format), though text export is compatible.

#### Deck Validation
- **Format Legality**: Real-time legality checking. When a format is set for the deck, illegal cards are flagged with a warning icon and explanation (e.g., "banned in Modern"). Found in the deck editor sidebar and the deck overview panel.
- **Commander Rules**: Validates commander color identity restrictions, singleton rule, 100-card minimum. Flags partner/companion violations. The commander zone is a dedicated section in the editor.
- **Sideboard Rules**: Validates sideboard size (15 cards for constructed, companion restrictions). Sideboard is a distinct zone in the editor.
- **Card Count**: Warns if over/under the required deck size for the format.

#### Versioning
- **Changelog**: Moxfield tracks a change history for decks. Each save creates an entry showing cards added/removed with timestamps. Found under the "History" or "Changelog" tab in the deck view.
- **Snapshots**: Users can save named snapshots of a deck state. Useful for tracking deck evolution over time. This is a **Premium feature** as of late 2024.
- **Branching**: No Git-style branching. Users who want to explore alternatives must clone/copy the deck.

#### Playtest
- **Goldfish / Sample Hand**: Click "Playtest" to draw a sample opening hand. Supports drawing additional cards, reshuffling.
- **Mulligan Rules**: Supports London Mulligan (draw 7, put back N for each mulligan). The playtest interface includes a "Mulligan" button that follows current MTG rules.
- **Full Goldfish Mode**: Can play out turns -- draw for turn, tap lands, cast spells (simplified, no rules engine). Cards can be moved between hand, battlefield, graveyard, exile.
- **Probability Tools**: Hypergeometric probability calculator is available (either built-in or as a linked tool). Shows the probability of drawing specific cards in opening hand or by turn N. Found in the deck statistics/analysis panel.

---

### 1.6 Collection Management
- **Card Scanning**: Mobile app supports camera-based card scanning for adding cards to collection. Uses image recognition to identify cards.
- **Conditions**: Users can mark card condition (NM, LP, MP, HP, Damaged) when adding to collection.
- **Ownership Tracking**: Collection tracks which cards you own. In the deck editor, cards you own are visually distinguished (e.g., a checkmark or highlight). This helps identify cards you need to acquire.
- **Sync**: Collection syncs across devices via Moxfield account. No integration with external collection tools (e.g., Deckbox, Delver Lens) via direct sync.
- **Price Tracking**: Displays TCGPlayer market prices (USD) by default. Shows price per card and total deck price. Price source can be toggled (TCGPlayer, Cardmarket for EU users). Price history/trending is not a native feature.
- **Trade Binder**: Users can mark cards as "for trade" in their collection, creating a public trade list.

### 1.7 Analysis Tools
- **Mana Curve**: Visual bar chart showing card count by CMC. Displayed prominently in the deck editor sidebar and deck overview. Color-coded by card color.
- **Type Distribution**: Pie chart or bar chart showing distribution across card types (creatures, instants, sorceries, etc.).
- **Color Distribution**: Shows the color breakdown of cards and mana symbols in the deck.
- **Mana Source Analysis**: Breaks down land and mana-producing cards by color produced. Helps identify mana base issues.
- **Synergy Tags**: Moxfield uses EDHRec synergy data to show synergy scores for cards relative to the commander. Cards are tagged with synergy percentages in the search/browse view when building EDH decks.
- **Probability**: Hypergeometric calculator for draw probability.
- **Meta Tools**: No built-in metagame analysis. Relies on external tools (MTG Goldfish, MTGTop8). However, popular/trending decks on Moxfield serve as informal meta indicators.
- **Salt Score**: Integrates EDHRec salt scores to show how "salty" (annoying to opponents) cards are.

### 1.8 Social & Community
- **Sharing**: Every deck has a unique URL. Decks can be public, unlisted, or private. Public decks appear in search results and user profiles.
- **Discovery**: Browse popular decks, search by commander, filter by format. "Popular" and "Recent" deck feeds on the homepage. Commander-specific pages show top decks for each commander.
- **Collaboration**: No real-time collaborative editing. Users can fork/clone decks. Comments can be left on public decks.
- **Profiles**: User profiles with avatar, deck list, collection stats, followers/following.
- **Content Creator Tools**: Deck image export (for thumbnails), embed codes for websites, shareable links. Content creators (e.g., YouTube MTG channels) frequently use Moxfield for deck techs -- the clean UI makes it screenshot-friendly.
- **Upvotes/Likes**: Users can "like" decks, contributing to popularity rankings.
- **Comments**: Threaded comments on deck pages.

### 1.9 Monetization
- **Model**: Freemium with optional "Moxfield Premium" subscription.
- **Free Tier**: Full deckbuilding, unlimited public decks, collection management, playtest, search, export (text/Arena/MTGO). Ads are displayed (banner ads, typically non-intrusive).
- **Premium** (~$5/month or ~$48/year as of 2024-2025):
  - Ad-free experience
  - Deck image/PDF export
  - Deck snapshots/versioning
  - Custom deck art/backgrounds
  - Priority support
  - Extended collection features
  - Some advanced analytics
- **Affiliate Links**: Card prices link to TCGPlayer (affiliate). Moxfield earns a commission on purchases made through these links. This is a significant revenue stream.
- **No In-App Purchases**: Beyond the subscription, no microtransactions.
- **No Paywall on Core Features**: Deckbuilding, search, and basic analytics are fully free. The paywall targets convenience and power-user features.

### 1.10 UX/UI
- **Desktop Focus**: The web app is clearly designed desktop-first. The editor uses a multi-panel layout: card search sidebar (left), deck list (center), card preview (right). Keyboard-heavy workflows are supported.
- **Mobile**: The mobile apps and responsive web provide a functional but condensed experience. Card search and deck editing work but feel more constrained. Scrolling through large deck lists on mobile is smooth.
- **Speed**: Extremely fast. Page loads, search results, and card previews are near-instant. The SPA architecture avoids full page reloads. Search autocomplete is notably snappy.
- **Keyboard Workflows**:
  - Type card name in the search bar and press Enter to add
  - Quantity adjustments with +/- or keyboard shortcuts
  - Tab navigation between sections
  - No comprehensive keyboard shortcut overlay/cheatsheet
- **Visual Deck Layout**:
  - List view (default): Cards listed by category (creatures, instants, lands, etc.) with small card images
  - Visual/Grid view: Cards displayed as full images in a grid
  - Pile view: Cards arranged in columns by CMC (like a physical desk layout)
  - Card grouping is customizable (by type, CMC, color, custom categories)
- **Dark Mode**: Yes, dark mode is available and is the default theme. Light mode is also available. Toggle in user settings (top-right menu).
- **Onboarding**: Minimal explicit onboarding. The interface is intuitive enough that most users figure it out. No tutorial wizard. A help/FAQ page exists but is not prominently featured. The "create a deck" flow is straightforward: click "New Deck," name it, select format, start adding cards.
- **Design Language**: Clean, modern, card-focused. Neutral dark grays with accent colors. Card images are the visual centerpiece. The UI avoids clutter -- information density is high but well-organized.

---
---

## 2. ARCHIDEKT

### 2.1 Platform(s)
- **Web**: Primary platform (archidekt.com) - fully responsive SPA
- **iOS**: Native mobile app available
- **Android**: Native mobile app available
- Mobile apps launched somewhat later than Moxfield's and have historically received mixed reviews for performance.

### 2.2 Target Audience
- **Primary**: Commander/EDH players (like Moxfield, EDH dominates usage)
- **Secondary**: Casual brewers who enjoy visual deckbuilding and theming
- **Tertiary**: Competitive players, though less tool-heavy for competitive meta analysis than Moxfield
- Archidekt has a reputation for appealing to players who value customization, visual presentation, and a slightly more "playful" aesthetic compared to Moxfield's utilitarian approach.

### 2.3 Core Value Proposition
Archidekt is a highly visual, customizable MTG deckbuilder with strong organizational tools, package-based deckbuilding, and a focus on making the brewing experience enjoyable and expressive.

### 2.4 Maturity: Modern (Growing)
- **Reasoning**: Founded ~2018, steady growth with a loyal user base. Professional development (small team, but consistent updates). The platform is mature in core functionality but sometimes lags Moxfield in polish and speed. Regular feature additions (packages, improved playtest, collection tools). Revenue model via Archidekt Plus subscription. A strong #2 in the deckbuilder market.

---

### 2.5 Deckbuilding Features

#### Card Search
- **Autocomplete**: Real-time autocomplete in the deck editor's "Add Card" input. Results show card names with small images. Speed is good but historically slightly slower than Moxfield's autocomplete.
- **Scryfall Syntax**: Archidekt supports Scryfall-style search syntax, including filtering by oracle text, color, type, CMC, power/toughness, and more. The advanced search modal provides a form-based interface as an alternative to typing syntax.
- **Oracle Text Search**: Yes, oracle text is searchable both via syntax and via the advanced search form fields.
- **DFC Handling**: Double-faced cards show the front face by default. Users can flip to see the back face via a click or hover interaction. Both faces' data (mana cost, types) are indexed.
- **Commander Identity Filtering**: When building an EDH deck with a designated commander, search results are automatically filtered to the commander's color identity. This behavior is consistent with Moxfield.

#### Filters
- **Color**: Color identity filtering with the same modes (exact, at-most, includes).
- **Type**: Card type filters available.
- **Set**: Set/expansion filter with dropdown.
- **Rarity**: Standard rarity filters.
- **Mana Value**: CMC filtering with comparison operators.
- **Format Legality**: Format selector that constrains search results to format-legal cards.
- **Budget**: Archidekt has a "budget" filter in some views, allowing users to sort/filter by card price. More budget-conscious tooling than Moxfield (e.g., showing budget alternatives).
- **Additional**: Keyword filtering, artist, etc.
- **Packages Feature**: Archidekt has a distinctive "Packages" system -- users can define groups of cards (e.g., "Ramp Package," "Removal Package") and save them as reusable templates. This is a unique differentiator. Found in the deck editor under custom categories.

#### Import/Export
- **Import**:
  - Text list (paste card names with quantities)
  - MTG Arena format
  - MTGO format
  - CSV import
  - URL import from select other sites
- **Export**:
  - Text list
  - MTG Arena format
  - MTGO format (.dek)
  - CSV
  - Image export (deck screenshot/visual export)
  - PDF export
  - TTS (Tabletop Simulator) export -- a notable unique feature for online play groups
  - Cockatrice export
- Image and some export options may be gated behind Archidekt Plus.

#### Deck Validation
- **Format Legality**: Real-time validation when a format is selected. Illegal cards are flagged with warnings and explanations.
- **Commander Rules**: Full commander validation (color identity, singleton, deck size, partner rules, companion rules).
- **Sideboard Rules**: Sideboard validation for constructed formats.
- **Wish Board / Companion**: Supports companion designation and validation.

#### Versioning
- **Changelog**: Archidekt maintains a deck edit history. Users can view changes over time (cards added/removed with dates).
- **Snapshots**: Deck snapshots can be saved. Users can revert to previous states.
- **Branching**: No formal branching. Users can clone decks to create variants.
- Versioning features are less prominently marketed compared to Moxfield.

#### Playtest
- **Goldfish / Sample Hand**: "Playtest" mode draws a sample opening hand. Users can draw cards, mulligan, and play out turns in a simplified goldfish environment.
- **Mulligan Rules**: Supports London Mulligan.
- **Full Goldfish Mode**: More developed than a simple hand viewer -- users can move cards between zones (hand, battlefield, graveyard, exile, library). Includes tap/untap functionality. The playtest UI is visual, showing card images on a virtual battlefield.
- **Probability Tools**: Basic probability tools exist (chance of drawing a card type by turn N). Less prominently featured than Moxfield's hypergeometric calculator but functional.

---

### 2.6 Collection Management
- **Card Scanning**: Mobile app includes card scanning via camera. Quality has improved over time but was historically less reliable than dedicated scanning apps.
- **Conditions**: Cards can be tagged with conditions when added to collection.
- **Ownership Tracking**: Collection integration with deck editor. Cards you own are visually marked in the deck list (e.g., highlighted or badged). "Missing cards" view shows what you need to buy.
- **Sync**: Syncs across devices via account. No direct import/export from other collection managers natively (though CSV import can serve this purpose).
- **Price Tracking**: Displays prices from TCGPlayer (US) and Cardmarket (EU). Total deck price displayed. Individual card prices shown inline.
- **Trade Features**: Less developed trade-list features compared to Moxfield. Users can mark cards for trade in collection but the trade discovery ecosystem is smaller.

### 2.7 Analysis Tools
- **Mana Curve**: Visual mana curve chart in the deck editor and deck overview. Color-coded bars by card color identity.
- **Type Distribution**: Chart/breakdown showing card type distribution.
- **Color Distribution**: Mana pip distribution and color weight analysis.
- **Mana Base Analysis**: Shows color production from lands vs. color requirements of spells. Helps identify mana base gaps.
- **Synergy Tags**: Less integrated with EDHRec than Moxfield. No native synergy scoring, though EDHRec data may be referenced.
- **Probability**: Basic draw probability tools available.
- **Meta Tools**: No built-in metagame analysis.
- **Unique -- Deck Statistics Panel**: Archidekt provides a comprehensive statistics panel with card type breakdown, average CMC, color devotion, and more. The stats panel is visually detailed with multiple charts.

### 2.8 Social & Community
- **Sharing**: Unique URLs for each deck. Public/private/unlisted privacy settings.
- **Discovery**: Browse and search public decks. Filter by format, commander, colors, popularity. "Featured" and "Popular" feeds on the homepage.
- **Collaboration**: No real-time collaborative editing. Users can fork decks.
- **Profiles**: User profiles with deck lists, collection stats, and activity.
- **Content Creator Tools**: Image export, shareable URLs, embeddable deck views. Some MTG content creators use Archidekt, though Moxfield has become more dominant in this space.
- **Deck Folders**: Users can organize decks into folders -- a useful organizational feature for users with many decks. This is a notable UX advantage for prolific brewers.
- **Comments**: Comments on public decks.
- **Community Engagement**: Archidekt has an active Discord community where feature requests and bug reports are discussed. The dev team is known for being responsive to community feedback.

### 2.9 Monetization
- **Model**: Freemium with "Archidekt Plus" subscription.
- **Free Tier**: Full deckbuilding, unlimited decks, collection management, playtest, search, basic export. Ads are displayed.
- **Archidekt Plus** (~$3-5/month or ~$30-48/year, pricing has varied):
  - Ad-free experience
  - Custom deck themes and backgrounds
  - Advanced export options (image, PDF)
  - Deck folders (organizing many decks)
  - Priority features/early access
  - Enhanced collection tools
  - Custom card art/tokens
- **Affiliate Links**: Card prices link to TCGPlayer/Cardmarket (affiliate revenue).
- **No In-App Purchases** beyond subscription.
- **Competitive Pricing**: Archidekt Plus is generally priced the same as or slightly below Moxfield Premium, positioning it as a value alternative.

### 2.10 UX/UI
- **Desktop Focus**: Desktop-first design with a multi-panel deck editor. The editor has a sidebar for search/filters, center panel for the deck list, and right panel for card details/stats.
- **Mobile**: Mobile apps exist but have historically been less polished than Moxfield's. Performance on mobile web can be slower with large decks. The mobile experience has improved with updates through 2024-2025.
- **Speed**: Generally good but not as consistently fast as Moxfield. Large decks (300+ card cubes) can cause some lag in the editor. Search autocomplete is fast but card preview rendering can have slight delays.
- **Keyboard Workflows**:
  - Card name typing with Enter to add
  - Quantity adjustments via keyboard
  - Less documented keyboard shortcut system than ideal
- **Visual Deck Layout**:
  - List view: Traditional list with card names, types, and prices by category
  - Visual/Grid view: Cards displayed as images in a grid
  - Stack view: Cards visually stacked by category (similar to Moxfield's pile view)
  - **Unique -- Visual Spoiler**: A visual-only mode showing just card images without text data, good for visual browsing
  - Custom categories (user-defined groupings) are prominently supported
- **Dark Mode**: Yes, dark mode available. Archidekt offers multiple theme options beyond simple dark/light, including custom color schemes for Archidekt Plus subscribers.
- **Onboarding**: Minimal onboarding wizard. A help section and documentation exist. The UI is slightly busier than Moxfield's, which can make initial learning curve marginally steeper for new users.
- **Design Language**: Slightly more colorful and "branded" than Moxfield. Uses a purple/blue primary color scheme. More decorative elements. The aesthetic is modern but with a touch more personality/playfulness than Moxfield's restrained neutrality.

---
---

## 3. HEAD-TO-HEAD COMPARISON MATRIX

| Dimension | Moxfield | Archidekt |
|---|---|---|
| **Platforms** | Web, iOS, Android | Web, iOS, Android |
| **Primary Audience** | Commander + Competitive | Commander + Casual Brewers |
| **Speed** | Industry-leading | Good, slightly behind |
| **Card Search** | Excellent (Scryfall syntax) | Very Good (Scryfall syntax) |
| **Commander ID Filter** | Auto-filter on | Auto-filter on |
| **Import Sources** | Arena, MTGO, Text, URL | Arena, MTGO, Text, CSV, URL |
| **Export Formats** | Arena, MTGO, Text, CSV, Image*, PDF* | Arena, MTGO, Text, CSV, Image, PDF, TTS, Cockatrice |
| **Playtest Quality** | Strong goldfish mode | Strong goldfish mode (slightly more visual) |
| **Collection Scanning** | Mobile camera scan | Mobile camera scan |
| **Mana Curve Visualization** | Yes, color-coded | Yes, color-coded |
| **Synergy Data** | EDHRec integrated | Less EDHRec integration |
| **Deck Organization** | Flat list | Folders (Plus feature) |
| **Packages/Templates** | No | Yes (unique feature) |
| **Versioning** | Changelog + Snapshots* | Changelog + Snapshots |
| **Collaboration** | Fork/Clone only | Fork/Clone only |
| **Custom Themes** | Limited (Premium) | Extensive (Plus) |
| **Dark Mode** | Yes (default) | Yes + custom themes |
| **Pricing** | ~$5/mo | ~$3-5/mo |
| **Ad Model** | Banner ads (free tier) | Banner ads (free tier) |
| **Affiliate Revenue** | TCGPlayer links | TCGPlayer/Cardmarket links |
| **Community Size** | Larger (market leader) | Smaller but loyal |
| **Content Creator Adoption** | Very High | Moderate |
| **Mobile App Quality** | Good | Fair to Good |
| **TTS Export** | No | Yes |

*Asterisk = Premium/Plus feature*

---

## 4. COMPETITIVE INSIGHTS FOR DECKLENS

### Where Moxfield Wins
1. **Speed and polish** -- the gold standard for perceived performance
2. **Network effects** -- largest user base means more shared decks, more content creator usage, more discovery
3. **EDHRec integration** -- synergy scores directly in the editor are a killer feature for commander players
4. **Brand recognition** -- "Moxfield" has become synonymous with MTG deckbuilding (similar to how "Goldfish" = price data)

### Where Archidekt Wins
1. **Packages** -- reusable card packages are a unique and beloved feature for EDH brewers
2. **Export breadth** -- TTS and Cockatrice export serve online play groups that Moxfield ignores
3. **Customization** -- theming and visual customization appeal to players who want personality in their decks
4. **Deck folders** -- simple organizational feature that power users love
5. **Price positioning** -- slightly cheaper Premium tier

### Gaps Both Leave Open (DeckLens Opportunities)
1. **Real-time collaboration** -- neither platform offers live co-editing (DeckLens's planned Durable Objects feature)
2. **Advanced budget optimization** -- neither has a true "optimize for budget" tool that suggests cheaper alternatives automatically
3. **Bracket calculator** -- neither has a built-in Rules Committee bracket calculator
4. **What-if swap analysis** -- neither shows the analytical impact of swapping cards before committing
5. **Deck primer/writeup tools** -- both support descriptions but neither offers rich-text primer authoring with card-link previews
6. **Legality fix suggestions** -- neither automatically suggests replacements for banned cards
7. **Offline-first architecture** -- both require connectivity; a Cloudflare Workers edge-deployed solution could offer superior latency
8. **Community moderation tooling** -- neither has visible community moderation infrastructure for user-generated content at the level DeckLens's Arcane Sanctum provides

### Defensive Moats to Monitor
- **Moxfield's network effect** is the strongest moat -- creators share Moxfield links, which drives more users, which drives more creators
- **Archidekt's package system** creates switching costs for users who have built up template libraries
- Both platforms' **collection management** features create lock-in (users won't easily move a catalogued collection)
- **Mobile app presence** on both iOS and Android app stores gives them discoverability advantages

---

## 5. USER SENTIMENT SUMMARY (from Reddit/community discussions through mid-2025)

### Moxfield Sentiment
- Overwhelmingly positive: praised for speed, clean UI, and "it just works" reliability
- Premium pricing is considered fair by most users
- Complaints center on: limited customization, no deck folders in free tier, occasional API rate limiting
- Content creators almost universally recommend Moxfield
- Some users express concern about over-reliance on a single platform (single point of failure for the community)

### Archidekt Sentiment
- Positive but with caveats: praised for packages, customization, and the dev team's responsiveness
- Mobile app performance is a recurring complaint (lag, crashes reported on older devices)
- Users who switch from Archidekt to Moxfield cite speed as the primary reason
- Users who stay on Archidekt cite packages and folders as the reason they don't switch
- The smaller community means less deck discovery but also a more "cozy" feel
- Pricing is considered good value

### Common Complaints About Both
- No real-time collaboration (frequently requested feature)
- Collection management is "good enough" but not comparable to dedicated tools like Deckbox or Dragon Shield app
- Neither platform handles cube management as well as CubeCobra (a niche competitor)
- Both struggle with very large lists (1000+ card cubes, full collection views)
