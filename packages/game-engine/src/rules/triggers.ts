import type { GameState } from '../types/game-state.ts';
import type { PlayerState } from '../types/player.ts';
import type { Permanent } from '../types/permanent.ts';
import type { Card } from '../types/card.ts';
import type { StackObject } from '../types/action.ts';

/**
 * Triggered Abilities System for the Rules Engine.
 *
 * Handles three main trigger types:
 * 1. ETB (Enter the Battlefield) — "When ~ enters the battlefield, ..."
 * 2. Death Triggers — "When ~ dies, ..." / "Whenever a creature dies, ..."
 * 3. Upkeep Triggers — "At the beginning of your upkeep, ..."
 *
 * Triggered abilities are queued onto the stack when their condition is met.
 * They resolve like any other stack object.
 */

// ─── Trigger Types ───

export interface TriggerEvent {
  type: 'etb' | 'death' | 'upkeep' | 'draw' | 'damage' | 'cast' | 'attack' | 'leaves' | 'endstep' | 'lifegain' | 'sacrifice' | 'blocked' | 'discard' | 'cycle' | 'monarch' | 'gain-energy' | 'token-created' | 'noncombat-damage' | 'begin-combat' | 'mana' | 'gain-counter';
  /** The permanent/card that triggered the event */
  source?: Permanent | Card;
  /** Which player controls the source */
  controller?: 0 | 1;
  /** Additional context (e.g., spell type for cast triggers, damage amount for damage triggers) */
  meta?: Record<string, any>;
}

interface TriggerPattern {
  name: string;
  /** Regex to match oracle text for this trigger type */
  match: RegExp;
  /** Which event type activates this trigger */
  eventType: TriggerEvent['type'];
  /** Whether the trigger refers to "self" (~) or other permanents */
  selfOnly: boolean;
  /** Whether the trigger only fires for the controller's own events (not opponents') */
  controllerOnly?: boolean;
}

// ─── Trigger Patterns ───

const TRIGGER_PATTERNS: TriggerPattern[] = [
  // ETB - self
  {
    name: 'etb-self',
    match: /when\s+~\s+enters\s+the\s+battlefield/i,
    eventType: 'etb',
    selfOnly: true,
  },
  // ETB - any creature
  {
    name: 'etb-creature',
    match: /whenever\s+a\s+creature\s+enters\s+the\s+battlefield/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // ETB - creature you control
  {
    name: 'etb-creature-you-control',
    match: /whenever\s+a\s+creature\s+enters\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // Death - self
  {
    name: 'death-self',
    match: /when\s+~\s+dies/i,
    eventType: 'death',
    selfOnly: true,
  },
  // Death - any creature
  {
    name: 'death-creature',
    match: /whenever\s+a\s+creature\s+(you\s+control\s+)?dies/i,
    eventType: 'death',
    selfOnly: false,
  },
  // Upkeep - your
  {
    name: 'upkeep-your',
    match: /at\s+the\s+beginning\s+of\s+your\s+upkeep/i,
    eventType: 'upkeep',
    selfOnly: true,
  },
  // Upkeep - each
  {
    name: 'upkeep-each',
    match: /at\s+the\s+beginning\s+of\s+each\s+(?:player's\s+)?upkeep/i,
    eventType: 'upkeep',
    selfOnly: false,
  },
  // Cast — whenever you cast a spell
  {
    name: 'cast-any-spell',
    match: /whenever\s+you\s+cast\s+a\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Cast — whenever you cast a creature spell
  {
    name: 'cast-creature-spell',
    match: /whenever\s+you\s+cast\s+a\s+creature\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Cast — whenever you cast an instant or sorcery spell
  {
    name: 'cast-noncreature-spell',
    match: /whenever\s+you\s+cast\s+an?\s+(?:instant|sorcery|noncreature|instant\s+or\s+sorcery)\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Prowess — whenever you cast a noncreature spell, this creature gets +1/+1 until EOT (CR 702.107)
  {
    name: 'prowess',
    match: /\bprowess\b/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Extort — whenever you cast a spell, you may drain 1 life from each opponent (CR 702.100)
  {
    name: 'extort',
    match: /\bextort\b/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Attack — whenever ~ attacks
  {
    name: 'attack-self',
    match: /whenever\s+~\s+attacks/i,
    eventType: 'attack',
    selfOnly: true,
  },
  // Attack — whenever a creature you control attacks
  {
    name: 'attack-creature-you-control',
    match: /whenever\s+a\s+creature\s+you\s+control\s+attacks/i,
    eventType: 'attack',
    selfOnly: false,
  },
  // Leaves battlefield — when ~ leaves the battlefield
  {
    name: 'leaves-battlefield-self',
    match: /when\s+~\s+leaves\s+the\s+battlefield/i,
    eventType: 'leaves',
    selfOnly: true,
  },
  // ETB — whenever another creature enters the battlefield under your control
  {
    name: 'etb-another-creature-you-control',
    match: /whenever\s+another\s+creature\s+enters\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // ETB — whenever a nontoken creature enters the battlefield
  {
    name: 'etb-nontoken-creature',
    match: /whenever\s+a\s+nontoken\s+creature\s+enters\s+the\s+battlefield/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // Death — whenever another creature you control dies
  {
    name: 'death-another-creature-you-control',
    match: /whenever\s+another\s+creature\s+you\s+control\s+dies/i,
    eventType: 'death',
    selfOnly: false,
  },
  // Death — whenever a creature an opponent controls dies
  {
    name: 'death-opponent-creature',
    match: /whenever\s+a\s+creature\s+an?\s+opponent\s+controls?\s+dies/i,
    eventType: 'death',
    selfOnly: false,
  },
  // Damage — whenever ~ deals damage
  {
    name: 'deals-damage-self',
    match: /whenever\s+~\s+deals?\s+(?:combat\s+)?damage/i,
    eventType: 'damage',
    selfOnly: true,
  },
  // Damage — whenever a creature you control deals combat damage to a player
  {
    name: 'deals-combat-damage-player',
    match: /whenever\s+(?:~|a\s+creature\s+you\s+control)\s+deals?\s+combat\s+damage\s+to\s+(?:a\s+)?player/i,
    eventType: 'damage',
    selfOnly: false,
  },
  // Draw — whenever you draw a card
  {
    name: 'draw-trigger',
    match: /whenever\s+you\s+draw\s+a\s+card/i,
    eventType: 'draw',
    selfOnly: false,
  },
  // Landfall — whenever a land enters the battlefield under your control
  {
    name: 'landfall',
    match: /whenever\s+a\s+land\s+enters\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // Landfall — specific land type: whenever a Forest/Mountain/etc enters
  {
    name: 'landfall-basic',
    match: /whenever\s+a\s+(?:forest|mountain|island|swamp|plains)\s+enters\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // End Step — at the beginning of your end step
  {
    name: 'endstep-your',
    match: /at\s+the\s+beginning\s+of\s+your\s+end\s+step/i,
    eventType: 'endstep',
    selfOnly: true,
  },
  // End Step — at the beginning of each player's end step
  {
    name: 'endstep-each',
    match: /at\s+the\s+beginning\s+of\s+each\s+(?:player's\s+)?end\s+step/i,
    eventType: 'endstep',
    selfOnly: false,
  },
  // Lifegain — whenever you gain life
  {
    name: 'lifegain-you',
    match: /whenever\s+you\s+gain\s+life/i,
    eventType: 'lifegain',
    selfOnly: false,
  },
  // Lifegain — whenever a player gains life
  {
    name: 'lifegain-any',
    match: /whenever\s+(?:a\s+)?player\s+gains?\s+life/i,
    eventType: 'lifegain',
    selfOnly: false,
  },
  // Sacrifice — when you sacrifice ~
  {
    name: 'sacrifice-self',
    match: /when\s+you\s+sacrifice\s+~/i,
    eventType: 'sacrifice',
    selfOnly: true,
  },
  // Sacrifice — whenever you sacrifice a creature
  {
    name: 'sacrifice-creature',
    match: /whenever\s+you\s+sacrifice\s+a\s+creature/i,
    eventType: 'sacrifice',
    selfOnly: false,
  },
  // Sacrifice — whenever a player/anyone sacrifices a permanent/creature/artifact
  {
    name: 'sacrifice-any',
    match: /whenever\s+(?:a\s+)?(?:player\s+)?sacrifices?\s+a\s+(?:permanent|creature|artifact)/i,
    eventType: 'sacrifice',
    selfOnly: false,
  },
  // Block — whenever ~ becomes blocked
  {
    name: 'blocked-self',
    match: /whenever\s+~\s+becomes?\s+blocked/i,
    eventType: 'blocked',
    selfOnly: true,
  },
  // Block — whenever ~ blocks
  {
    name: 'blocks-self',
    match: /whenever\s+~\s+blocks/i,
    eventType: 'blocked',
    selfOnly: true,
  },
  // Discard — whenever you discard a card
  {
    name: 'discard-you',
    match: /whenever\s+you\s+discard\s+a\s+card/i,
    eventType: 'discard',
    selfOnly: false,
  },
  // Discard — whenever an opponent discards a card
  {
    name: 'discard-opponent',
    match: /whenever\s+an\s+opponent\s+discards?\s+a\s+card/i,
    eventType: 'discard',
    selfOnly: false,
  },

  // ─── Phase 2: Extended Trigger Patterns ───

  // LTB — whenever a creature you control leaves the battlefield
  {
    name: 'ltb-creature-you-control',
    match: /whenever\s+a\s+creature\s+you\s+control\s+leaves\s+the\s+battlefield/i,
    eventType: 'leaves',
    selfOnly: false,
  },
  // Artifact ETB — whenever an artifact enters the battlefield under your control
  {
    name: 'artifact-etb',
    match: /whenever\s+an?\s+artifact\s+enters?\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // Enchantment ETB — whenever an enchantment enters the battlefield under your control
  {
    name: 'enchantment-etb',
    match: /whenever\s+an?\s+enchantment\s+enters?\s+the\s+battlefield\s+under\s+your\s+control/i,
    eventType: 'etb',
    selfOnly: false,
  },
  // Cast artifact spell
  {
    name: 'cast-artifact-spell',
    match: /whenever\s+you\s+cast\s+an?\s+artifact\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Cast enchantment spell
  {
    name: 'cast-enchantment-spell',
    match: /whenever\s+you\s+cast\s+an?\s+enchantment\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Any player casts a spell
  {
    name: 'any-player-casts',
    match: /whenever\s+a\s+player\s+casts?\s+a\s+spell/i,
    eventType: 'cast',
    selfOnly: false,
  },
  // Whenever you lose life
  {
    name: 'lose-life-you',
    match: /whenever\s+you\s+lose\s+life/i,
    eventType: 'damage',
    selfOnly: false,
  },
  // Whenever a counter is placed on ~
  {
    name: 'gain-counter-self',
    match: /whenever\s+(?:a|one\s+or\s+more)\s+(?:\+1\/\+1\s+)?counters?\s+(?:is|are)\s+(?:put|placed)\s+on\s+~/i,
    eventType: 'etb',
    selfOnly: true,
  },
  // Whenever a creature attacks you
  {
    name: 'creature-attacks-you',
    match: /whenever\s+a\s+creature\s+attacks\s+you/i,
    eventType: 'attack',
    selfOnly: false,
  },
  // Whenever an opponent draws a card
  {
    name: 'opponent-draws',
    match: /whenever\s+an\s+opponent\s+draws?\s+a\s+card/i,
    eventType: 'draw',
    selfOnly: false,
  },

  // ─── Phase 3 Trigger Patterns ───

  // Cycling: "Whenever you cycle a card" / "When you cycle ~"
  { name: 'cycling-self', match: /when(?:ever)?\s+(?:you\s+cycle\s+~|~\s+is\s+cycled)/i, eventType: 'cycle', selfOnly: true },
  { name: 'cycling-any', match: /whenever\s+(?:you|a\s+player)\s+cycles?\s+a\s+card/i, eventType: 'cycle', selfOnly: false },

  // Monarch: "Whenever you become the monarch"
  { name: 'become-monarch-trigger', match: /whenever\s+you\s+become\s+the\s+monarch/i, eventType: 'monarch', selfOnly: false },

  // Exalted: keyword that triggers when a creature you control attacks alone
  { name: 'exalted', match: /\bexalted\b/i, eventType: 'attack', selfOnly: false },

  // Energy: "Whenever you get one or more {E}"
  { name: 'gain-energy-trigger', match: /whenever\s+you\s+(?:get|gain)\s+(?:one\s+or\s+more\s+)?\{E\}/i, eventType: 'gain-energy', selfOnly: false },

  // Token creation: "Whenever you create a token" / "Whenever a token enters"
  { name: 'token-created', match: /whenever\s+(?:you\s+create|a\s+token\s+(?:enters|is\s+created))/i, eventType: 'token-created', selfOnly: false },

  // Planeswalker ETB: "Whenever a planeswalker enters the battlefield under your control"
  { name: 'planeswalker-etb', match: /whenever\s+a\s+planeswalker\s+enters\s+the\s+battlefield\s+under\s+your\s+control/i, eventType: 'etb', selfOnly: false },

  // Noncombat damage: "Whenever a source deals noncombat damage"
  { name: 'noncombat-damage', match: /whenever\s+(?:a\s+source|~)\s+deals?\s+noncombat\s+damage/i, eventType: 'noncombat-damage', selfOnly: false },

  // Counter removed: "Whenever a counter is removed from ~"
  { name: 'counter-removed', match: /whenever\s+(?:a|one\s+or\s+more)\s+counters?\s+(?:is|are)\s+removed\s+from\s+~/i, eventType: 'etb', selfOnly: true },

  // Begin combat - your turn
  { name: 'begin-combat-your', match: /at\s+the\s+beginning\s+of\s+combat\s+on\s+your\s+turn/i, eventType: 'begin-combat', selfOnly: true },
  // Begin combat - each player
  { name: 'begin-combat-each', match: /(?:at\s+the\s+beginning\s+of\s+combat|whenever\s+you\s+attack)/i, eventType: 'begin-combat', selfOnly: false },

  // Conditional ETB - from graveyard (Kroxa, Murktide Regent)
  { name: 'etb-from-graveyard', match: /when\s+~\s+enters\s+(?:the\s+battlefield\s+)?from\s+(?:a\s+)?graveyard/i, eventType: 'etb', selfOnly: true },
  // Conditional ETB - from exile (Flicker returns)
  { name: 'etb-from-exile', match: /when\s+~\s+enters\s+(?:the\s+battlefield\s+)?from\s+exile/i, eventType: 'etb', selfOnly: true },
  // Conditional ETB - if you control N or more (threshold ETB)
  { name: 'etb-if-you-control', match: /when\s+~\s+enters\s+(?:the\s+battlefield)?.*if\s+you\s+control\s+(\d+)\s+or\s+more/i, eventType: 'etb', selfOnly: true },

  // ── Additional Trigger Patterns (Card Playability Upgrade) ──

  // Opponent casts noncreature spell (Mystic Remora)
  {
    name: 'opponent-casts-noncreature',
    match: /whenever an opponent casts a noncreature spell/i,
    eventType: 'cast',
    selfOnly: false,
  },

  // Tap a land for mana (Mirari's Wake)
  {
    name: 'tap-land-for-mana',
    match: /whenever you tap a land for mana/i,
    eventType: 'mana',
    selfOnly: false,
  },

  // At the beginning of each end step
  {
    name: 'each-end-step',
    match: /at the beginning of each (?:player's )?end step/i,
    eventType: 'endstep',
    selfOnly: false,
  },

  // Equipped creature dies (Skullclamp)
  {
    name: 'equipped-creature-dies',
    match: /when(?:ever)? equipped creature dies/i,
    eventType: 'death',
    selfOnly: false,
  },

  // Enchanted creature dies
  {
    name: 'enchanted-creature-dies',
    match: /when(?:ever)? enchanted creature dies/i,
    eventType: 'death',
    selfOnly: false,
  },

  // A creature you control deals combat damage to a player
  {
    name: 'your-creature-combat-damage-player',
    match: /whenever (?:a|another) creature you control deals combat damage to a player/i,
    eventType: 'damage',
    selfOnly: false,
    controllerOnly: true,
  },

  // At the beginning of your end step
  {
    name: 'your-end-step',
    match: /at the beginning of your end step/i,
    eventType: 'endstep',
    selfOnly: false,
    controllerOnly: true,
  },

  // Whenever you create a token
  {
    name: 'you-create-token',
    match: /whenever you create (?:a|one or more) tokens?/i,
    eventType: 'token-created',
    selfOnly: false,
    controllerOnly: true,
  },

  // Whenever +1/+1 counters are placed
  {
    name: 'counter-placed-on-creature',
    match: /whenever (?:a|one or more) \+1\/\+1 counters? (?:is|are) (?:placed|put) on/i,
    eventType: 'gain-counter',
    selfOnly: false,
  },

  // Whenever an opponent loses life (Aristocrats)
  {
    name: 'opponent-loses-life',
    match: /whenever an opponent loses life/i,
    eventType: 'damage',
    selfOnly: false,
  },

  // Whenever a permanent you control dies
  {
    name: 'your-permanent-dies',
    match: /whenever (?:a|another) permanent you control (?:dies|is put into a graveyard)/i,
    eventType: 'death',
    selfOnly: false,
    controllerOnly: true,
  },

  // Whenever a land enters under an opponent's control
  {
    name: 'opponent-landfall',
    match: /whenever a land enters the battlefield under an opponent's control/i,
    eventType: 'etb',
    selfOnly: false,
  },

  // Whenever you cycle a card
  {
    name: 'you-cycle-card',
    match: /whenever you cycle (?:a|an?) card/i,
    eventType: 'cycle',
    selfOnly: false,
    controllerOnly: true,
  },

  // Whenever a creature enters from graveyard
  {
    name: 'creature-enters-from-gy',
    match: /whenever a creature enters the battlefield from (?:a|your) graveyard/i,
    eventType: 'etb',
    selfOnly: false,
  },

  // At the beginning of each combat
  {
    name: 'each-combat-begin',
    match: /at the beginning of (?:each|every) combat/i,
    eventType: 'begin-combat',
    selfOnly: false,
  },

  // ─── Niche Keyword Trigger Patterns ───

  // Undying — when this creature dies, if it had no +1/+1 counters, return it with a +1/+1 counter (CR 702.93)
  {
    name: 'undying',
    match: /\bundying\b/i,
    eventType: 'death',
    selfOnly: true,
  },

  // Persist — when this creature dies, if it had no -1/-1 counters, return it with a -1/-1 counter (CR 702.78)
  {
    name: 'persist',
    match: /\bpersist\b/i,
    eventType: 'death',
    selfOnly: true,
  },

  // Afflict N — whenever this creature becomes blocked, defending player loses N life (CR 702.129)
  {
    name: 'afflict',
    match: /\bafflict\s+(\d+)/i,
    eventType: 'blocked',
    selfOnly: true,
  },

  // Whenever a nontoken creature dies
  {
    name: 'nontoken-creature-dies',
    match: /whenever a nontoken creature (?:dies|is put into a graveyard)/i,
    eventType: 'death',
    selfOnly: false,
  },

];

// ─── Stack ID counter ───

let _triggerStackId = 10000;
function nextTriggerId(): string {
  return `trigger_${_triggerStackId++}`;
}
export function resetTriggerIdCounter(): void {
  _triggerStackId = 10000;
}

// ─── Core Functions ───

/**
 * Check all permanents on the battlefield for triggered abilities
 * that match the given event, and add them to the stack.
 */
export function checkTriggers(
  state: GameState,
  event: TriggerEvent,
): GameState {
  const triggeredAbilities: StackObject[] = [];

  for (let playerIdx = 0; playerIdx < 2; playerIdx++) {
    const player = state.players[playerIdx as 0 | 1];

    for (const perm of player.battlefield) {
      // Normalize oracle text: replace card's own name with ~ so patterns can match uniformly
      // Scryfall uses full card name, our patterns use ~
      const rawText = perm.oracleText || '';
      const oracleText = rawText.replace(new RegExp(escapeRegExp(perm.name), 'gi'), '~');
      const triggers = findMatchingTriggers(oracleText, event, perm, playerIdx as 0 | 1);

      for (const trigger of triggers) {
        // Extract the effect text after the trigger condition
        const effectText = extractEffectText(oracleText, trigger);

        triggeredAbilities.push({
          id: nextTriggerId(),
          type: 'ability',
          text: `${perm.name}: ${effectText || trigger.name}`,
          controller: playerIdx as 0 | 1,
          card: permanentToCard(perm),
          targets: [],
          // Use the extracted effect text for pattern matching, not the full oracle text
          oracleText: effectText || perm.oracleText || '',
        });
      }
    }
  }

  // If the event is a death trigger from a dying creature, also check the dying creature itself
  if (event.type === 'death' && event.source && event.controller !== undefined) {
    const source = event.source;
    const rawText = source.oracleText || '';
    const oracleText = rawText.replace(new RegExp(escapeRegExp(source.name), 'gi'), '~');
    const selfTriggers = TRIGGER_PATTERNS.filter(
      (tp) => tp.eventType === 'death' && tp.selfOnly && tp.match.test(oracleText)
    );

    for (const trigger of selfTriggers) {
      const effectText = extractEffectText(oracleText, trigger);
      triggeredAbilities.push({
        id: nextTriggerId(),
        type: 'ability',
        text: `${source.name}: ${effectText || trigger.name}`,
        controller: event.controller,
        card: 'id' in source ? source as Card : permanentToCard(source as Permanent),
        targets: [],
        // Use the extracted effect text for pattern matching
        oracleText: effectText || source.oracleText || '',
      });
    }
  }

  // If the event is a sacrifice trigger, also check the sacrificed permanent itself
  // (it's no longer on the battlefield, similar to death triggers)
  if (event.type === 'sacrifice' && event.source && event.controller !== undefined) {
    const source = event.source;
    const rawText = source.oracleText || '';
    const oracleText = rawText.replace(new RegExp(escapeRegExp(source.name), 'gi'), '~');
    const selfTriggers = TRIGGER_PATTERNS.filter(
      (tp) => tp.eventType === 'sacrifice' && tp.selfOnly && tp.match.test(oracleText)
    );

    for (const trigger of selfTriggers) {
      const effectText = extractEffectText(oracleText, trigger);
      triggeredAbilities.push({
        id: nextTriggerId(),
        type: 'ability',
        text: `${source.name}: ${effectText || trigger.name}`,
        controller: event.controller,
        card: 'id' in source ? source as Card : permanentToCard(source as Permanent),
        targets: [],
        oracleText: effectText || source.oracleText || '',
      });
    }
  }

  if (triggeredAbilities.length === 0) return state;

  // APNAP ordering (CR 603.3b): Active Player's triggers go on the stack first (bottom),
  // then Non-Active Player's triggers on top. Since the stack is LIFO, NAP's triggers
  // resolve first, which is the correct MTG behavior.
  const activePlayer = state.activePlayer;
  const apTriggers = triggeredAbilities.filter(a => a.controller === activePlayer);
  const napTriggers = triggeredAbilities.filter(a => a.controller !== activePlayer);
  const orderedAbilities = [...apTriggers, ...napTriggers];

  // Add all triggered abilities to the stack in APNAP order
  const logs = orderedAbilities.map((ability) => ({
    timestamp: Date.now(),
    turn: state.turn,
    phase: state.phase,
    step: state.step,
    player: ability.controller,
    message: `Triggered: ${ability.text}`,
  }));

  return {
    ...state,
    stack: [...state.stack, ...orderedAbilities],
    log: [...state.log, ...logs],
  };
}

/**
 * Check for ETB triggers when a permanent enters the battlefield.
 */
export function checkETBTriggers(state: GameState, permanent: Permanent, meta?: Record<string, any>): GameState {
  return checkTriggers(state, {
    type: 'etb',
    source: permanent,
    controller: permanent.controller,
    meta,
  });
}

/**
 * Check for death triggers when creatures die (moved to graveyard from battlefield).
 */
export function checkDeathTriggers(state: GameState, dying: Permanent[], controller: 0 | 1): GameState {
  let current = state;
  for (const perm of dying) {
    current = checkTriggers(current, {
      type: 'death',
      source: perm,
      controller,
    });
  }
  return current;
}

/**
 * Check for upkeep triggers at the beginning of upkeep.
 */
export function checkUpkeepTriggers(state: GameState): GameState {
  return checkTriggers(state, {
    type: 'upkeep',
    controller: state.activePlayer,
  });
}

/**
 * Check for cast triggers when a player casts a spell.
 */
export function checkCastTriggers(state: GameState, card: Card, caster: 0 | 1): GameState {
  return checkTriggers(state, {
    type: 'cast',
    source: card as any,
    controller: caster,
    meta: { spellType: card.typeLine },
  });
}

/**
 * Check for attack triggers when a creature attacks.
 */
export function checkAttackTriggers(state: GameState, attackers: Permanent[], controller: 0 | 1): GameState {
  let current = state;
  const loneAttacker = attackers.length === 1;
  for (const attacker of attackers) {
    current = checkTriggers(current, {
      type: 'attack',
      source: attacker,
      controller,
      meta: { loneAttacker },
    });
  }
  return current;
}

/**
 * Check for leaves-the-battlefield triggers when a permanent leaves.
 */
export function checkLeavesBattlefieldTriggers(state: GameState, permanent: Permanent): GameState {
  return checkTriggers(state, {
    type: 'leaves',
    source: permanent,
    controller: permanent.controller,
  });
}

/**
 * Check for damage triggers when a permanent deals damage.
 */
export function checkDamageTriggers(state: GameState, source: Permanent, controller: 0 | 1): GameState {
  return checkTriggers(state, {
    type: 'damage',
    source,
    controller,
  });
}

/**
 * Check for draw triggers when a player draws a card.
 */
export function checkDrawTriggers(state: GameState, controller: 0 | 1): GameState {
  return checkTriggers(state, {
    type: 'draw',
    controller,
  });
}

/**
 * Check end-step triggers for the active player's end step.
 */
export function checkEndStepTriggers(state: GameState): GameState {
  return checkTriggers(state, { type: 'endstep', controller: state.activePlayer });
}

/**
 * Check lifegain triggers when a player gains life.
 */
export function checkLifegainTriggers(state: GameState, player: 0 | 1, amount: number): GameState {
  return checkTriggers(state, { type: 'lifegain', controller: player, meta: { amount } });
}

/**
 * Check sacrifice triggers when a permanent is sacrificed.
 */
export function checkSacrificeTriggers(state: GameState, sacrificedPerm: Permanent): GameState {
  return checkTriggers(state, {
    type: 'sacrifice',
    source: sacrificedPerm,
    controller: sacrificedPerm.controller,
  });
}

/**
 * Check begin-combat triggers at the beginning of combat (CR 507.1).
 */
export function checkBeginCombatTriggers(state: GameState): GameState {
  return checkTriggers(state, { type: 'begin-combat', controller: state.activePlayer });
}

// ─── Helpers ───

/** Escape special regex characters in a string for use in new RegExp() */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findMatchingTriggers(
  oracleText: string,
  event: TriggerEvent,
  perm: Permanent,
  controller: 0 | 1,
): TriggerPattern[] {
  return TRIGGER_PATTERNS.filter((tp) => {
    if (tp.eventType !== event.type) return false;
    if (!tp.match.test(oracleText)) return false;

    // Self-only triggers: source must match this permanent
    if (tp.selfOnly) {
      if (event.type === 'etb') {
        // For ETB self-triggers, the entering permanent must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
        // Conditional ETB: check fromZone requirement
        if (tp.name === 'etb-from-graveyard' && event.meta?.fromZone !== 'graveyard') return false;
        if (tp.name === 'etb-from-exile' && event.meta?.fromZone !== 'exile') return false;
      }
      if (event.type === 'attack') {
        // For attack self-triggers, the attacking creature must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
      }
      if (event.type === 'damage') {
        // For damage self-triggers, the damage dealer must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
      }
      if (event.type === 'leaves') {
        // For leaves-battlefield self-triggers, the leaving permanent must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
      }
      if (event.type === 'blocked') {
        // For blocked/blocks self-triggers, the permanent must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
      }
      if (event.type === 'sacrifice') {
        // For sacrifice-self triggers, the sacrificed permanent must be this permanent
        if (event.source && (event.source as Permanent).id !== perm.id) return false;
      }
    }

    // Upkeep triggers: "your upkeep" only triggers for the active player
    if (tp.eventType === 'upkeep' && tp.selfOnly) {
      if (controller !== event.controller) return false;
    }

    // End step triggers: "your end step" only triggers for the active player's controller
    if (tp.eventType === 'endstep' && tp.selfOnly) {
      if (controller !== event.controller) return false;
    }

    // Lifegain triggers: "whenever you gain life" only triggers for the gaining player's permanents
    if (tp.eventType === 'lifegain') {
      if (tp.name === 'lifegain-you') {
        // "whenever you gain life" — the gaining player must be this permanent's controller
        if (event.controller !== controller) return false;
      }
      // 'lifegain-any' triggers for any player gaining life, no controller check needed
    }

    // Sacrifice triggers: check type constraints on the sacrificed permanent
    if (tp.eventType === 'sacrifice' && !tp.selfOnly) {
      if (tp.name === 'sacrifice-creature') {
        // "whenever you sacrifice a creature" — must be controller's sacrifice, and source must be a creature
        if (event.controller !== controller) return false;
        if (event.source) {
          const sourceType = (event.source as any).typeLine?.toLowerCase() || '';
          if (!sourceType.includes('creature')) return false;
        }
      }
      if (tp.name === 'sacrifice-any') {
        // "whenever a player sacrifices a permanent/creature/artifact" — check type match
        if (event.source) {
          const sourceType = (event.source as any).typeLine?.toLowerCase() || '';
          // Extract which type the pattern requires from oracle text
          const typeMatch = oracleText.match(/sacrifices?\s+a\s+(permanent|creature|artifact)/i);
          if (typeMatch) {
            const requiredType = typeMatch[1].toLowerCase();
            if (requiredType !== 'permanent' && !sourceType.includes(requiredType)) return false;
          }
        }
      }
    }

    // Discard triggers: controller checks
    if (tp.eventType === 'discard') {
      if (tp.name === 'discard-you') {
        // "whenever you discard" — the discarding player must be this permanent's controller
        if (event.controller !== controller) return false;
      }
      if (tp.name === 'discard-opponent') {
        // "whenever an opponent discards" — the discarding player must NOT be this permanent's controller
        if (event.controller === controller) return false;
      }
    }

    // Cast triggers: "whenever you cast" only triggers for the controller
    if (tp.eventType === 'cast') {
      // 'any-player-casts' triggers for any player, no controller check
      // 'opponent-casts-noncreature' triggers for opponent casts only
      if (tp.name === 'opponent-casts-noncreature') {
        // Must be an opponent's spell
        if (event.controller === controller) return false;
        // Must be a noncreature spell
        if (event.meta?.spellType) {
          const spellType = event.meta.spellType.toLowerCase();
          if (spellType.includes('creature') && !spellType.includes('instant') && !spellType.includes('sorcery')) return false;
        }
      } else if (tp.name !== 'any-player-casts') {
        if (controller !== event.controller) return false;
      }

      // Check spell type constraints from meta data
      if (event.meta?.spellType) {
        const spellType = event.meta.spellType.toLowerCase();
        if (tp.name === 'cast-creature-spell' && !spellType.includes('creature')) return false;
        if (tp.name === 'cast-noncreature-spell' &&
            (spellType.includes('creature') && !spellType.includes('instant') && !spellType.includes('sorcery'))) return false;
        // Prowess: only triggers on noncreature spells (CR 702.107)
        if (tp.name === 'prowess' && spellType.includes('creature') &&
            !spellType.includes('instant') && !spellType.includes('sorcery')) return false;
        // Artifact/Enchantment cast triggers
        if (tp.name === 'cast-artifact-spell' && !spellType.includes('artifact')) return false;
        if (tp.name === 'cast-enchantment-spell' && !spellType.includes('enchantment')) return false;
      }
    }

    // "another creature" triggers: the entering/dying permanent must NOT be this permanent
    if (tp.name.includes('another')) {
      if (event.source && (event.source as Permanent).id === perm.id) return false;
    }

    // "creature you control" triggers for ETB: only trigger if the controller matches
    if (tp.name.includes('you-control') && event.type === 'etb') {
      if (event.controller !== controller) return false;
    }

    // "opponent controls" death triggers: only trigger if the dying creature was controlled by opponent
    if (tp.name === 'death-opponent-creature') {
      if (event.controller === controller) return false; // Must be opponent's creature
    }

    // "creature you control" death triggers: only if we control the dying creature
    if (tp.name === 'death-creature' && tp.match.source.includes('you\\s+control')) {
      if (event.controller !== controller) return false;
    }

    // Artifact/Enchantment ETB triggers: only fire for matching types
    if (tp.name === 'artifact-etb') {
      if (!event.source) return false;
      if (event.controller !== controller) return false;
      if (!(event.source as any).typeLine?.toLowerCase().includes('artifact')) return false;
    }
    if (tp.name === 'enchantment-etb') {
      if (!event.source) return false;
      if (event.controller !== controller) return false;
      if (!(event.source as any).typeLine?.toLowerCase().includes('enchantment')) return false;
    }

    // LTB creature you control: only fire for your creatures
    if (tp.name === 'ltb-creature-you-control') {
      if (event.controller !== controller) return false;
      if (!event.source) return false;
      if (!(event.source as any).typeLine?.toLowerCase().includes('creature')) return false;
    }

    // Opponent draws trigger
    if (tp.name === 'opponent-draws') {
      if (event.controller === controller) return false; // must be opponent's draw
    }

    // Exalted: only fires when exactly 1 creature attacks alone (CR 702.83)
    if (tp.name === 'exalted') {
      if (event.type !== 'attack') return false;
      // Must be controller's creature attacking
      if (event.controller !== controller) return false;
      // Exalted fires from ANY permanent the controller controls, not just the attacker
      // Check is done in checkAttackTriggers: only call if attackers.length === 1
      // (handled by the meta.loneAttacker flag)
      if (!event.meta?.loneAttacker) return false;
    }

    // Cycling triggers
    if (tp.name === 'cycling-any' && tp.eventType === 'cycle') {
      if (event.controller !== controller) return false;
    }

    // Monarch triggers
    if (tp.name === 'become-monarch-trigger') {
      if (event.controller !== controller) return false;
    }

    // Energy triggers
    if (tp.name === 'gain-energy-trigger') {
      if (event.controller !== controller) return false;
    }

    // Token creation triggers
    if (tp.name === 'token-created') {
      if (event.controller !== controller) return false;
    }

    // Planeswalker ETB: check type
    if (tp.name === 'planeswalker-etb') {
      if (!event.source) return false;
      if (event.controller !== controller) return false;
      if (!(event.source as any).typeLine?.toLowerCase().includes('planeswalker')) return false;
    }

    // Generic controllerOnly check: trigger only fires when the event's controller matches the permanent's controller
    if (tp.controllerOnly && event.controller !== controller) return false;

    // Opponent landfall: land entering under an opponent's control (NOT the trigger controller's)
    if (tp.name === 'opponent-landfall') {
      if (!event.source) return false;
      const sourceTypeLine = (event.source as any).typeLine?.toLowerCase() || '';
      if (!sourceTypeLine.includes('land')) return false;
      // The entering land must be under an OPPONENT's control (event.controller !== trigger controller)
      if (event.controller === controller) return false;
    }

    // Opponent loses life: the losing player must be an opponent
    if (tp.name === 'opponent-loses-life') {
      if (event.controller === controller) return false; // must be opponent's life loss
    }

    // Creature enters from graveyard: check fromZone meta
    if (tp.name === 'creature-enters-from-gy') {
      if (!event.source) return false;
      const sourceTypeLine = (event.source as any).typeLine?.toLowerCase() || '';
      if (!sourceTypeLine.includes('creature')) return false;
      if (event.meta?.fromZone !== 'graveyard') return false;
    }

    // Your permanent dies: must be a permanent the controller owns
    if (tp.name === 'your-permanent-dies') {
      if (event.controller !== controller) return false;
    }

    // Landfall triggers: only fire for land permanents entering
    if (tp.name === 'landfall' || tp.name === 'landfall-basic') {
      if (!event.source) return false;
      const sourceTypeLine = (event.source as any).typeLine?.toLowerCase() || '';
      if (!sourceTypeLine.includes('land')) return false;
      // "under your control" — the entering land must be controlled by the trigger's controller
      if (event.controller !== controller) return false;

      // For basic land variant, check the specific land type
      if (tp.name === 'landfall-basic') {
        // Extract the specific land type from the pattern match
        const landTypeMatch = oracleText.match(/whenever\s+a\s+(forest|mountain|island|swamp|plains)\s+enters/i);
        if (landTypeMatch) {
          const requiredType = landTypeMatch[1].toLowerCase();
          if (!sourceTypeLine.includes(requiredType)) return false;
        }
      }
    }

    return true;
  });
}

/**
 * Extract the effect text from a triggered ability.
 * E.g., "When ~ enters the battlefield, draw a card" → "draw a card"
 */
function extractEffectText(oracleText: string, trigger: TriggerPattern): string {
  const match = oracleText.match(trigger.match);
  if (!match) return '';

  // Get text after the trigger condition
  const afterTrigger = oracleText.substring(match.index! + match[0].length);
  // Clean up: remove leading comma/spaces
  const cleaned = afterTrigger.replace(/^[,\s]+/, '').split('.')[0];
  return cleaned || '';
}

/** Convert a Permanent back to a Card for stack objects */
function permanentToCard(perm: Permanent): Card {
  return {
    id: perm.id,
    oracleId: perm.oracleId,
    name: perm.name,
    manaCost: perm.manaCost,
    cmc: perm.cmc,
    typeLine: perm.typeLine,
    oracleText: perm.oracleText,
    power: perm.power,
    toughness: perm.toughness,
    loyalty: perm.loyalty,
    colors: perm.colors,
    colorIdentity: perm.colorIdentity,
    rarity: perm.rarity,
    tags: perm.tags,
    imageUrl: perm.imageUrl,
    owner: perm.owner,
  };
}
