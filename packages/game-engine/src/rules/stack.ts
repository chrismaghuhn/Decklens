import type { GameState } from '../types/game-state.ts';
import type { StackObject, Target } from '../types/action.ts';
import type { Card } from '../types/card.ts';
import type { Permanent } from '../types/permanent.ts';
import type { ManaPayment } from '../types/mana.ts';
import type { PlayerState } from '../types/player.ts';
import { giveActivePlayerPriority } from './priority.ts';
import { resolveEffect } from './effects.ts';
import { parseAbilities } from './abilities.ts';
import { checkETBTriggers } from './triggers.ts';
import { isAura, getAuraBonuses } from './equipment.ts';
import { parseTargetFilter, validateTarget } from './targeting.ts';
import { parseModalSpell, resolveModalChoices } from './modal.ts';

let nextStackId = 0;

/** Reset stack ID counter (for tests) */
export function resetStackIdCounter(): void {
  nextStackId = 0;
}

/** Generate a unique stack object ID */
function generateStackId(): string {
  return `stack_${++nextStackId}_${Date.now().toString(36)}`;
}

/**
 * Add a spell to the stack.
 * The card is removed from hand and tracked in the StackObject.
 */
export function addSpellToStack(
  state: GameState,
  cardId: string,
  player: number,
  targets: Target[],
  _manaPayment: ManaPayment,
  xValue?: number,
  opts?: { isFlashback?: boolean; isKicked?: boolean; isAdventure?: boolean; isFaceDown?: boolean; isEvoked?: boolean; isDashed?: boolean; isBlitzed?: boolean; isOverloaded?: boolean; isBuyback?: boolean; isEscape?: boolean; isJumpStart?: boolean; isForetold?: boolean; isMutate?: boolean; mutateTargetId?: string; mutateOnTop?: boolean; isBestow?: boolean; oracleTextOverride?: string; replicateCount?: number; isRetrace?: boolean; isEntwined?: boolean; }
): GameState {
  const playerState = state.players[player];

  // Flashback/Escape/Jump-start: card comes from graveyard instead of hand
  let card: Card | undefined;
  let updatedPlayer: PlayerState;

  if (opts?.isFlashback || opts?.isEscape || opts?.isJumpStart || opts?.isRetrace) {
    // Card from graveyard
    const gyIndex = playerState.graveyard.findIndex((c) => c.id === cardId);
    if (gyIndex === -1) return state;
    card = playerState.graveyard[gyIndex];
    updatedPlayer = {
      ...playerState,
      graveyard: [
        ...playerState.graveyard.slice(0, gyIndex),
        ...playerState.graveyard.slice(gyIndex + 1),
      ],
    };
  } else {
    // Try hand first
    const cardIndex = playerState.hand.findIndex((c) => c.id === cardId);
    if (cardIndex !== -1) {
      card = playerState.hand[cardIndex];
      updatedPlayer = {
        ...playerState,
        hand: [
          ...playerState.hand.slice(0, cardIndex),
          ...playerState.hand.slice(cardIndex + 1),
        ],
      };
    } else {
      // Try exile (adventure creatures returning from exile, CR 715.4)
      const exileIndex = playerState.exile.findIndex((c) => c.id === cardId);
      if (exileIndex === -1) return state;
      card = { ...playerState.exile[exileIndex], onAdventure: undefined };
      updatedPlayer = {
        ...playerState,
        exile: [
          ...playerState.exile.slice(0, exileIndex),
          ...playerState.exile.slice(exileIndex + 1),
        ],
      };
    }
  }

  // Detect "can't be countered" from oracle text (CR 702.61 adjacent)
  const cardOracleText = card.oracleText || '';
  const isUncounterable = /\bcan't be countered\b/i.test(cardOracleText);
  // Detect split second from oracle text (CR 702.61)
  const hasSplitSecond = /\bsplit second\b/i.test(cardOracleText);

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'spell',
    card,
    controller: player,
    targets,
    text: card.name,
    xValue,
    oracleText: opts?.oracleTextOverride,
    isFlashback: opts?.isFlashback,
    isKicked: opts?.isKicked,
    isAdventure: opts?.isAdventure,
    isFaceDown: opts?.isFaceDown,
    isEvoked: opts?.isEvoked,
    isDashed: opts?.isDashed,
    isBlitzed: opts?.isBlitzed,
    isOverloaded: opts?.isOverloaded,
    isBuyback: opts?.isBuyback,
    isEscape: opts?.isEscape,
    isJumpStart: opts?.isJumpStart,
    isForetold: opts?.isForetold,
    isMutate: opts?.isMutate,
    mutateTargetId: opts?.mutateTargetId,
    mutateOnTop: opts?.mutateOnTop,
    isBestow: opts?.isBestow,
    uncounterable: isUncounterable || undefined,
    splitSecond: hasSplitSecond || undefined,
    replicateCount: opts?.replicateCount,
    isRetrace: opts?.isRetrace,
    isEntwined: opts?.isEntwined,
  };

  const players = [...state.players];
  players[player] = updatedPlayer;

  let castMessage = `${playerState.name} casts ${card.name}`;
  if (opts?.isFlashback) castMessage += ' (flashback)';
  if (opts?.isKicked) castMessage += ' (kicked)';
  if (opts?.isAdventure) castMessage += ` (adventure: ${card.adventureName || card.name})`;
  if (opts?.isEvoked) castMessage += ' (evoked)';
  if (opts?.isDashed) castMessage += ' (dashed)';
  if (opts?.isBlitzed) castMessage += ' (blitz)';
  if (opts?.isOverloaded) castMessage += ' (overloaded)';
  if (opts?.isBuyback) castMessage += ' (buyback)';
  if (opts?.isEscape) castMessage += ' (escape)';
  if (opts?.isJumpStart) castMessage += ' (jump-start)';
  if (opts?.isForetold) castMessage += ' (foretold)';
  if (opts?.isMutate) castMessage += ' (mutate)';
  if (opts?.isBestow) castMessage += ' (bestow)';
  if (opts?.isRetrace) castMessage += ' (retrace)';
  if (opts?.isEntwined) castMessage += ' (entwined)';
  if (opts?.replicateCount && opts.replicateCount > 0) castMessage += ` (replicate x${opts.replicateCount})`;
  if (xValue !== undefined && xValue > 0) castMessage += ` (X=${xValue})`;
  castMessage += '.';

  // Build the stack with the original spell + replicate copies (CR 702.56)
  // Copies go on top of the original (above it in the stack array means resolved last)
  const replicateCopies: StackObject[] = [];
  if (opts?.replicateCount && opts.replicateCount > 0) {
    for (let i = 0; i < opts.replicateCount; i++) {
      replicateCopies.push(copyStackObject(stackObject, player));
    }
  }

  return {
    ...state,
    players,
    stack: [...state.stack, stackObject, ...replicateCopies],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: castMessage,
        cardName: card.name,
        actionType: 'cast-spell',
      },
    ],
  };
}

/**
 * Add an activated ability to the stack.
 */
export function addAbilityToStack(
  state: GameState,
  sourceId: string,
  abilityIndex: number,
  player: number,
  targets: Target[]
): GameState {
  const playerState = state.players[player];
  const source = playerState.battlefield.find((p) => p.id === sourceId);
  if (!source) return state;

  const ability = source.abilities[abilityIndex];
  if (!ability) return state;

  // Extract effect text from ability text (format: "cost: effect")
  // For activated abilities, strip the cost prefix to get just the effect
  let effectText = ability.text;
  if (ability.type === 'activated' && ability.cost) {
    // The text format is "{cost}: {effect}" — extract just the effect part
    const colonIdx = effectText.indexOf(':');
    if (colonIdx !== -1) {
      effectText = effectText.substring(colonIdx + 1).trim();
    }
  }

  const stackObject: StackObject = {
    id: generateStackId(),
    type: 'ability',
    source,
    controller: player,
    targets,
    text: `${source.name}: ${ability.text}`,
    oracleText: effectText,  // Set effect text for pattern matching
  };

  return {
    ...state,
    stack: [...state.stack, stackObject],
    log: [
      ...state.log,
      {
        timestamp: Date.now(),
        turn: state.turn,
        phase: state.phase,
        step: state.step,
        player,
        message: `${playerState.name} activates ${source.name}'s ability.`,
        cardName: source.name,
        actionType: 'activate-ability',
      },
    ],
  };
}

/**
 * Resolve the top object on the stack (LIFO).
 *
 * Spells: permanent types go to battlefield, instants/sorceries go to graveyard.
 * Abilities: effect is logged (actual effect execution is future work).
 *
 * After resolution, active player gets priority.
 */
/** Find a permanent by ID for mutate targeting (CR 702.139) */
function findPermanentForMutate(state: GameState, id: string): { perm: Permanent; playerIdx: number; permIdx: number } | null {
  for (let pi = 0; pi < 2; pi++) {
    const player = state.players[pi];
    const idx = player.battlefield.findIndex(p => p.id === id);
    if (idx !== -1) return { perm: player.battlefield[idx], playerIdx: pi, permIdx: idx };
  }
  return null;
}

export function resolveTopOfStack(state: GameState): GameState {
  if (state.stack.length === 0) return state;

  const stackCopy = [...state.stack];
  const resolving = stackCopy.pop()!;
  let newState: GameState = { ...state, stack: stackCopy };

  // ─── Fizzle Check ───
  // If the spell/ability has targets and ALL targets are now illegal,
  // the spell is countered by game rules (fizzles).
  if (checkSpellFizzle(newState, resolving)) {
    const fizzleName = resolving.card?.name ?? resolving.source?.name ?? resolving.text;

    if (resolving.type === 'spell' && resolving.card && !isPermanentType(resolving.card)) {
      // Instant/Sorcery spell fizzles → move card to graveyard without resolving effects
      const controller = resolving.controller;
      const players = [...newState.players];
      players[controller] = {
        ...players[controller],
        graveyard: [...players[controller].graveyard, resolving.card],
      };
      newState = { ...newState, players };
    }
    // For abilities (or permanent spells that somehow fizzle), just skip resolution.
    // Permanent spells with targets are unusual — they still enter the battlefield
    // per MTG rules, but we handle the rare edge case by not fizzling permanents.

    newState = {
      ...newState,
      log: [
        ...newState.log,
        {
          timestamp: Date.now(),
          turn: newState.turn,
          phase: newState.phase,
          step: newState.step,
          player: resolving.controller,
          message: `${fizzleName} fizzles (all targets became illegal).`,
          cardName: resolving.card?.name ?? resolving.source?.name,
        },
      ],
    };

    return giveActivePlayerPriority(newState);
  }

  // ─── Modal Spell Check ───
  // If the spell/ability is modal, we need mode choices before resolving.
  const resolvingOracleText = resolving.oracleText || resolving.card?.oracleText || '';
  const modalInfo = parseModalSpell(resolvingOracleText);
  if (modalInfo && modalInfo.modes.length > 0) {
    // Entwine (CR 702.39): if entwine cost was paid, choose ALL modes
    if (resolving.isEntwined) {
      const allModeChoices = modalInfo.modes.map(m => m.index);
      newState = resolveModalChoices(newState, resolving, allModeChoices);

      // Move instant/sorcery to destination zone after entwine resolution
      if (resolving.type === 'spell' && resolving.card && !isPermanentType(resolving.card)) {
        const ctrl = resolving.controller;
        const players = [...newState.players];
        players[ctrl] = { ...players[ctrl], graveyard: [...players[ctrl].graveyard, resolving.card] };
        newState = { ...newState, players };
      }

      newState = {
        ...newState,
        log: [
          ...newState.log,
          {
            timestamp: Date.now(),
            turn: newState.turn,
            phase: newState.phase,
            step: newState.step,
            player: resolving.controller,
            message: `${resolving.card?.name ?? resolving.text} resolves (entwined — all modes: ${allModeChoices.map(i => modalInfo.modes[i]?.text ?? i).join(', ')}).`,
            cardName: resolving.card?.name ?? resolving.source?.name,
            actionType: 'effect',
          },
        ],
      };
      return giveActivePlayerPriority(newState);
    }

    if (resolving.controller === 0 && !newState.pendingModalChoice) {
      // Human player — pause resolution and ask for mode choices via UI
      // Put the resolving object back on the stack so it can be resolved later
      newState = {
        ...newState,
        stack: [...newState.stack, resolving],
        pendingModalChoice: {
          stackObjectId: resolving.id,
          controller: 0,
          modes: modalInfo.modes.map(m => ({ index: m.index, text: m.text, oracleText: m.oracleText })),
          minChoices: resolving.isEntwined ? modalInfo.modes.length : modalInfo.minChoices,
          maxChoices: resolving.isEntwined ? modalInfo.modes.length : modalInfo.maxChoices,
          cardName: resolving.card?.name ?? resolving.source?.name ?? resolving.text,
        },
      };
      return newState; // Wait for player choice — don't resolve yet
    } else if (resolving.controller === 1) {
      // Bot player — auto-choose the first N modes (simple heuristic)
      const autoChoices: number[] = [];
      for (let i = 0; i < modalInfo.minChoices && i < modalInfo.modes.length; i++) {
        autoChoices.push(modalInfo.modes[i].index);
      }
      newState = resolveModalChoices(newState, resolving, autoChoices);

      // Move instant/sorcery to destination zone after modal resolution
      if (resolving.type === 'spell' && resolving.card && !isPermanentType(resolving.card)) {
        const ctrl = resolving.controller;
        const players = [...newState.players];
        if (resolving.isBuyback) {
          players[ctrl] = { ...players[ctrl], hand: [...players[ctrl].hand, resolving.card] };
        } else if (resolving.isFlashback || resolving.isEscape || resolving.isJumpStart || resolving.isRetrace) {
          players[ctrl] = { ...players[ctrl], exile: [...players[ctrl].exile, resolving.card] };
        } else {
          players[ctrl] = { ...players[ctrl], graveyard: [...players[ctrl].graveyard, resolving.card] };
        }
        newState = { ...newState, players };
      }

      newState = {
        ...newState,
        log: [
          ...newState.log,
          {
            timestamp: Date.now(),
            turn: newState.turn,
            phase: newState.phase,
            step: newState.step,
            player: resolving.controller,
            message: `${resolving.card?.name ?? resolving.text} resolves (bot chose modes: ${autoChoices.map(i => modalInfo.modes[i]?.text ?? i).join(', ')}).`,
            cardName: resolving.card?.name ?? resolving.source?.name,
            actionType: 'effect',
          },
        ],
      };
      return giveActivePlayerPriority(newState);
    }
    // If human player already made their choice (pendingModalChoice is set but controller matches),
    // fall through to normal resolution — the game-loop will call resolveModalChoices directly.
  }

  if (resolving.type === 'spell' && resolving.card) {
    const card = resolving.card;
    const controller = resolving.controller;

    if (isPermanentType(card)) {
      // Permanent spell → battlefield
      let permanent = createPermanentFromCard(card, controller, newState.turn);
      // Morph: if cast face-down, enter as 2/2 colorless creature (CR 702.36)
      if (resolving.isFaceDown) {
        permanent = {
          ...permanent,
          faceDown: true,
          basePower: 2,
          baseToughness: 2,
          currentPower: 2,
          currentToughness: 2,
          abilities: [],
        };
      }
      // Evoke: mark for immediate sacrifice after ETB (CR 702.73)
      if (resolving.isEvoked) {
        permanent = { ...permanent, sacrificeOnETB: true };
      }
      // Dash: gains haste, returns to hand at end step (CR 702.108)
      if (resolving.isDashed) {
        permanent = {
          ...permanent,
          dashedThisTurn: true,
          temporaryKeywords: [...(permanent.temporaryKeywords || []), { keyword: 'haste', until: 'end-of-turn' }],
        };
      }
      // Blitz: gains haste, sacrifice at end step, draw on death (CR 702.152)
      if (resolving.isBlitzed) {
        permanent = {
          ...permanent,
          blitzed: true,
          temporaryKeywords: [...(permanent.temporaryKeywords || []), { keyword: 'haste', until: 'end-of-turn' }],
        };
      }
      // ─── Mutate: merge with target creature instead of entering separately (CR 702.139) ───
      if (resolving.isMutate && resolving.mutateTargetId) {
        const targetIdx = findPermanentForMutate(newState, resolving.mutateTargetId);
        if (targetIdx && !targetIdx.perm.typeLine?.toLowerCase().includes('human')) {
          const players = [...newState.players];
          const tgtPlayer = { ...players[targetIdx.playerIdx] };
          const updatedBf = [...tgtPlayer.battlefield];

          const existingStack = targetIdx.perm.mutateStack || [];
          const newStackEntry = {
            id: permanent.id,
            name: permanent.name,
            oracleText: permanent.oracleText || '',
            power: permanent.power,
            toughness: permanent.toughness,
          };

          const onTop = resolving.mutateOnTop !== false; // default: on top

          if (onTop) {
            // Source on top: name, P/T, types come from source
            updatedBf[targetIdx.permIdx] = {
              ...targetIdx.perm,
              name: permanent.name,
              oracleText: (permanent.oracleText || '') + '\n' + (targetIdx.perm.oracleText || ''),
              currentPower: permanent.currentPower ?? targetIdx.perm.currentPower,
              currentToughness: permanent.currentToughness ?? targetIdx.perm.currentToughness,
              basePower: permanent.basePower ?? targetIdx.perm.basePower,
              baseToughness: permanent.baseToughness ?? targetIdx.perm.baseToughness,
              mutateStack: [...existingStack, newStackEntry],
            };
          } else {
            // Source under: target keeps its characteristics, gains source's abilities
            updatedBf[targetIdx.permIdx] = {
              ...targetIdx.perm,
              oracleText: (targetIdx.perm.oracleText || '') + '\n' + (permanent.oracleText || ''),
              mutateStack: [...existingStack, newStackEntry],
            };
          }

          tgtPlayer.battlefield = updatedBf;
          players[targetIdx.playerIdx] = tgtPlayer;
          newState = { ...newState, players };

          // "Whenever this creature mutates" triggers fire (use ETB trigger system)
          const mergedPerm = updatedBf[targetIdx.permIdx];
          newState = checkETBTriggers(newState, mergedPerm, { fromZone: 'hand' });

          newState = {
            ...newState,
            log: [...newState.log, {
              timestamp: Date.now(), turn: newState.turn, phase: newState.phase,
              step: newState.step, player: controller,
              message: `${permanent.name} mutates ${onTop ? 'on top of' : 'under'} ${targetIdx.perm.name}.`,
              cardName: permanent.name, actionType: 'effect',
            }],
          };

          return giveActivePlayerPriority(newState);
        }
        // If target is invalid, fall through to enter the battlefield normally
      }

      // ─── Bestow: enters as an Aura enchanting the target creature (CR 702.102) ───
      if (resolving.isBestow && resolving.targets.length > 0) {
        const bestowTarget = resolving.targets[0];
        if (bestowTarget.type === 'permanent') {
          // Find target creature on any battlefield
          let targetFound = false;
          for (let pi = 0; pi < 2; pi++) {
            const pIdx = pi;
            const targetIdx = newState.players[pIdx].battlefield.findIndex(p => p.id === bestowTarget.id);
            if (targetIdx !== -1 && newState.players[pIdx].battlefield[targetIdx].currentPower !== undefined) {
              targetFound = true;
              const bestowPower = permanent.basePower ?? 0;
              const bestowToughness = permanent.baseToughness ?? 0;

              // Make the bestow creature into an Aura attached to target
              const bestowAura: Permanent = {
                ...permanent,
                attachedTo: bestowTarget.id,
                bestowed: true,
                // Clear creature stats while acting as Aura
                currentPower: undefined,
                currentToughness: undefined,
              };

              const bestowPlayers = [...newState.players];
              bestowPlayers[controller] = {
                ...bestowPlayers[controller],
                battlefield: [...bestowPlayers[controller].battlefield, bestowAura],
              };

              // Update target creature: add attachment and P/T bonus
              const targetBf = [...bestowPlayers[pIdx].battlefield];
              const tgtCreature = targetBf[targetIdx];
              targetBf[targetIdx] = {
                ...tgtCreature,
                attachments: [...tgtCreature.attachments, permanent.id],
                currentPower: (tgtCreature.currentPower ?? 0) + bestowPower,
                currentToughness: (tgtCreature.currentToughness ?? 0) + bestowToughness,
              };
              bestowPlayers[pIdx] = { ...bestowPlayers[pIdx], battlefield: targetBf };

              newState = { ...newState, players: bestowPlayers };
              newState = {
                ...newState,
                log: [...newState.log, {
                  timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
                  player: controller,
                  message: `${card.name} enchants ${tgtCreature.name} via bestow (+${bestowPower}/+${bestowToughness}).`,
                  cardName: card.name, actionType: 'effect',
                }],
              };

              return giveActivePlayerPriority(newState);
            }
          }
          // If target is gone, bestow enters as a creature (CR 702.102c)
          // Fall through to normal permanent entry
        }
      }

      // Check if permanent enters the battlefield tapped (e.g., tap-lands, "enters tapped" creatures)
      if ((card.oracleText || '').match(/enters the battlefield tapped/i)) {
        permanent = { ...permanent, tapped: true };
      }
      const players = [...newState.players];
      players[controller] = {
        ...players[controller],
        battlefield: [...players[controller].battlefield, permanent],
      };
      newState = { ...newState, players };

      // Determine the zone the spell was cast from for conditional ETB triggers
      const fromZone = resolving.isFlashback ? 'graveyard' : resolving.isAdventure ? 'exile' : 'hand';
      // Check for ETB triggered abilities and queue them on the stack
      newState = checkETBTriggers(newState, permanent, { fromZone });

      // ─── Aura Auto-Attachment (CR 303.4a) ───
      // When an Aura spell resolves, it must attach to a valid target.
      // If no valid target exists, the aura goes to the graveyard (CR 303.4g).
      if (isAura(card)) {
        const auraAttachResult = attachAuraOnResolution(newState, permanent, resolving, controller);
        newState = auraAttachResult.state;

        if (!auraAttachResult.attached) {
          // CR 303.4g: Aura with no legal target goes to graveyard
          // Remove the aura from the battlefield and put it in the graveyard
          const playersGy = [...newState.players];
          const bfWithoutAura = playersGy[controller].battlefield.filter(p => p.id !== permanent.id);
          const auraAsCard: Card = {
            id: permanent.id, oracleId: permanent.oracleId, name: permanent.name,
            manaCost: permanent.manaCost, cmc: permanent.cmc, typeLine: permanent.typeLine,
            oracleText: permanent.oracleText, power: permanent.power, toughness: permanent.toughness,
            loyalty: permanent.loyalty, colors: permanent.colors, colorIdentity: permanent.colorIdentity,
            rarity: permanent.rarity, tags: permanent.tags, imageUrl: permanent.imageUrl, owner: permanent.owner,
          };
          playersGy[controller] = {
            ...playersGy[controller],
            battlefield: bfWithoutAura,
            graveyard: [...playersGy[controller].graveyard, auraAsCard],
          };
          newState = {
            ...newState,
            players: playersGy,
            log: [...newState.log, {
              timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
              player: controller,
              message: `${card.name} has no valid target and goes to graveyard.`,
              cardName: card.name,
            }],
          };

          return giveActivePlayerPriority(newState);
        }
      }

      // Try to resolve ETB effects from oracle text (e.g., "When ~ enters the battlefield, draw a card")
      // Direct effect resolution for simple patterns
      const effectResult = resolveEffect(newState, resolving);
      newState = effectResult.state;
      if (effectResult.resolved && effectResult.description) {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves → ${effectResult.description}.`,
            cardName: card.name, actionType: 'effect',
          }],
        };
      } else {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves.`,
            cardName: card.name,
          }],
        };
      }
    } else {
      // Instant/Sorcery → try to auto-resolve effects BEFORE moving to destination zone
      const effectResult = resolveEffect(newState, resolving);
      newState = effectResult.state;

      // Determine destination zone after resolution:
      // - Buyback: return to hand (CR 702.26)
      // - Flashback/Escape/Jump-start: exile (CR 702.34a, 702.137, 702.132)
      // - Adventure: exile with onAdventure flag (CR 715.4)
      // - Rebound: exile with reboundExile flag (CR 702.87)
      // - Normal: graveyard
      const players = [...newState.players];
      if (resolving.isBuyback) {
        // Buyback: return to hand instead of graveyard (CR 702.26)
        players[controller] = {
          ...players[controller],
          hand: [...players[controller].hand, card],
        };
      } else if (resolving.isFlashback || resolving.isEscape || resolving.isJumpStart || resolving.isRetrace) {
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, card],
        };
      } else if (resolving.isAdventure) {
        const adventureCard = { ...card, onAdventure: true };
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, adventureCard],
        };
      } else if (card.oracleText?.toLowerCase().includes('rebound')) {
        // Rebound (CR 702.87): exile instead of graveyard, cast again next upkeep
        const reboundCard = { ...card, reboundExile: true };
        players[controller] = {
          ...players[controller],
          exile: [...players[controller].exile, reboundCard],
        };
      } else {
        players[controller] = {
          ...players[controller],
          graveyard: [...players[controller].graveyard, card],
        };
      }
      newState = { ...newState, players };

      if (effectResult.resolved && effectResult.description) {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: `${card.name} resolves → ${effectResult.description}.`,
            cardName: card.name, actionType: 'effect',
          }],
          // Track whether manual resolution is needed
          needsManualResolution: false,
        };
      } else {
        newState = {
          ...newState,
          log: [...newState.log, {
            timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
            player: controller,
            message: effectResult.description
              ? `${card.name} resolves (manual: ${effectResult.description}).`
              : `${card.name} resolves.`,
            cardName: card.name,
          }],
          needsManualResolution: !effectResult.resolved,
          manualResolutionCard: !effectResult.resolved ? card : undefined,
          manualResolutionController: !effectResult.resolved ? controller : undefined,
        };
      }
    }
  } else if (resolving.type === 'ability') {
    // Try to auto-resolve ability effects
    const effectResult = resolveEffect(newState, resolving);
    newState = effectResult.state;

    if (effectResult.resolved && effectResult.description) {
      newState = {
        ...newState,
        log: [...newState.log, {
          timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
          player: resolving.controller,
          message: `Ability resolves → ${effectResult.description}.`,
          actionType: 'effect',
        }],
      };
    } else {
      newState = {
        ...newState,
        log: [...newState.log, {
          timestamp: Date.now(), turn: newState.turn, phase: newState.phase, step: newState.step,
          player: resolving.controller,
          message: effectResult.description
            ? `Ability resolves (manual: ${effectResult.description}).`
            : `Ability resolves: ${resolving.text}`,
        }],
        needsManualResolution: !effectResult.resolved,
        manualResolutionCard: !effectResult.resolved ? (resolving.source || resolving.card) : undefined,
        manualResolutionController: !effectResult.resolved ? resolving.controller : undefined,
      };
    }
  }

  return giveActivePlayerPriority(newState);
}

/**
 * Attach an Aura to its target when it resolves from the stack.
 *
 * Priority for finding a target:
 * 1. Use the explicit target from stackObject.targets (if it's a permanent target)
 * 2. Auto-select: for beneficial auras (+P/+T), enchant own strongest creature;
 *    for harmful auras (-P/+T or -T), enchant opponent's strongest creature
 *
 * Sets `attachedTo` on the aura permanent and adds the aura's ID to the
 * target creature's `attachments` array. Also applies P/T bonuses immediately.
 *
 * Returns { state, attached } — attached is false if no valid target was found.
 *
 * MTG Rules:
 * - CR 303.4a: An Aura spell targets the object/player it will enchant
 * - CR 303.4f: If the target is illegal on resolution, the Aura doesn't resolve
 * - CR 303.4g: An Aura that's on the battlefield without being attached goes to graveyard
 */
function attachAuraOnResolution(
  state: GameState,
  auraPermanent: Permanent,
  resolving: StackObject,
  controller: number
): { state: GameState; attached: boolean } {
  let targetId: string | null = null;

  // 1. Use the explicit target from the stack object
  if (resolving.targets && resolving.targets.length > 0) {
    const target = resolving.targets[0];
    if (target.type === 'permanent') {
      // Verify target still exists on the battlefield
      for (let pi = 0; pi < 2; pi++) {
        if (state.players[pi].battlefield.some(p => p.id === target.id)) {
          targetId = target.id;
          break;
        }
      }
    }
  }

  // 2. Auto-select if no explicit target
  if (!targetId) {
    const bonuses = getAuraBonuses(auraPermanent);
    const isPositive = bonuses.power >= 0 && bonuses.toughness >= 0;

    if (isPositive) {
      // Beneficial aura → enchant own strongest creature
      const ownCreatures = state.players[controller].battlefield
        .filter(p => p.currentPower !== undefined && p.id !== auraPermanent.id);
      if (ownCreatures.length > 0) {
        const sorted = [...ownCreatures].sort((a, b) => (b.currentPower ?? 0) - (a.currentPower ?? 0));
        targetId = sorted[0].id;
      }
    } else {
      // Harmful aura → enchant opponent's strongest creature
      const opp = (controller === 0 ? 1 : 0);
      const oppCreatures = state.players[opp].battlefield
        .filter(p => p.currentPower !== undefined);
      if (oppCreatures.length > 0) {
        const sorted = [...oppCreatures].sort((a, b) => (b.currentPower ?? 0) - (a.currentPower ?? 0));
        targetId = sorted[0].id;
      }
    }
  }

  // No valid target found — aura cannot attach
  if (!targetId) {
    return { state, attached: false };
  }

  // Find which player controls the target creature and attach the aura
  for (let pi = 0; pi < 2; pi++) {
    const playerIdx = pi;
    const player = state.players[playerIdx];
    const targetIdx = player.battlefield.findIndex(p => p.id === targetId);

    if (targetIdx !== -1) {
      const targetCreature = player.battlefield[targetIdx];
      const bonuses = getAuraBonuses(auraPermanent);

      // Build updated battlefield for the controller (where the aura is)
      const players = [...state.players];

      // Update the aura: set attachedTo
      const controllerBf = [...players[controller].battlefield];
      const auraIdx = controllerBf.findIndex(p => p.id === auraPermanent.id);
      if (auraIdx !== -1) {
        controllerBf[auraIdx] = {
          ...controllerBf[auraIdx],
          attachedTo: targetId,
        };
        players[controller] = {
          ...players[controller],
          battlefield: controllerBf,
        };
      }

      // Update the target creature: add aura to attachments, apply P/T bonuses
      const targetBf = playerIdx === controller ? [...players[controller].battlefield] : [...players[playerIdx].battlefield];
      const targetIdxInBf = targetBf.findIndex(p => p.id === targetId);
      if (targetIdxInBf !== -1) {
        const updatedCreature = {
          ...targetBf[targetIdxInBf],
          attachments: [...targetBf[targetIdxInBf].attachments, auraPermanent.id],
          currentPower: targetBf[targetIdxInBf].currentPower !== undefined
            ? targetBf[targetIdxInBf].currentPower! + bonuses.power
            : undefined,
          currentToughness: targetBf[targetIdxInBf].currentToughness !== undefined
            ? targetBf[targetIdxInBf].currentToughness! + bonuses.toughness
            : undefined,
        };
        targetBf[targetIdxInBf] = updatedCreature;
        players[playerIdx] = {
          ...players[playerIdx],
          battlefield: targetBf,
        };
      }

      const targetName = targetCreature.name;
      return {
        state: {
          ...state,
          players,
          log: [...state.log, {
            timestamp: Date.now(),
            turn: state.turn,
            phase: state.phase,
            step: state.step,
            player: controller,
            message: `${auraPermanent.name} enchants ${targetName}.`,
            cardName: auraPermanent.name,
            actionType: 'effect',
          }],
        },
        attached: true,
      };
    }
  }

  // Target not found on any battlefield (shouldn't happen if fizzle check passed)
  return { state, attached: false };
}

/**
 * Check if a spell or ability should fizzle (be countered by game rules).
 *
 * A spell/ability fizzles if it has targets AND none of those targets are
 * still legal at resolution time:
 *  - 'permanent' target: the permanent must still exist on some player's battlefield
 *  - 'player' target: the player must still be alive (life > 0 and game not over for them)
 *  - 'card-in-zone' target: the card must still exist in the specified zone
 *
 * If the spell has no targets, it never fizzles.
 * If at least one target is still legal, the spell does NOT fizzle.
 */
export function checkSpellFizzle(state: GameState, stackObj: StackObject): boolean {
  // No targets → never fizzles
  if (!stackObj.targets || stackObj.targets.length === 0) {
    return false;
  }

  // Try to parse a structured target filter from the spell's oracle text.
  // If available, use filter-aware validation (checks type, power, etc. — not just existence).
  const oracleText = stackObj.oracleText || stackObj.card?.oracleText || '';
  const targetFilter = oracleText ? parseTargetFilter(oracleText) : null;

  // Check each target for legality — if ANY target is still legal, no fizzle
  for (const target of stackObj.targets) {
    if (targetFilter) {
      // Filter-aware validation: checks existence AND that the target still
      // meets the spell's targeting criteria (type, power, color, etc.)
      const sourceId = stackObj.source?.id;
      if (validateTarget(state, target, targetFilter, sourceId)) {
        return false;
      }
    } else {
      // Fallback: basic existence check
      if (isTargetLegal(state, target)) {
        return false;
      }
    }
  }

  // All targets are illegal → fizzle
  return true;
}

/** Check if a single target is still legal given the current game state */
function isTargetLegal(state: GameState, target: Target): boolean {
  switch (target.type) {
    case 'permanent': {
      // The permanent must exist on some player's battlefield
      for (const player of state.players) {
        if (player.battlefield.some((p) => p.id === target.id)) {
          return true;
        }
      }
      return false;
    }

    case 'player': {
      // The player must still be alive
      const playerIndex = parseInt(target.id, 10);
      if (playerIndex !== 0 && playerIndex !== 1) return false;
      const playerState = state.players[playerIndex];
      // A player is alive if life > 0 and the game isn't over
      // (or the game is over but they aren't the loser)
      if (state.gameOver) return false;
      return playerState.life > 0;
    }

    case 'card-in-zone': {
      if (!target.zone) return false;
      // The card must still exist in the specified zone for some player
      for (const player of state.players) {
        const zoneCards = getZoneCards(player, target.zone);
        if (zoneCards && zoneCards.some((c) => c.id === target.id)) {
          return true;
        }
      }
      return false;
    }

    default:
      return false;
  }
}

/** Get the card array for a given zone from a player's state */
function getZoneCards(player: PlayerState, zone: string): Card[] | null {
  switch (zone) {
    case 'library': return player.library;
    case 'hand': return player.hand;
    case 'graveyard': return player.graveyard;
    case 'exile': return player.exile;
    case 'commandZone': return player.commandZone;
    default: return null;
  }
}

/** Check if a card type represents a permanent */
function isPermanentType(card: Card): boolean {
  const tl = card.typeLine.toLowerCase();
  return (
    tl.includes('creature') ||
    tl.includes('artifact') ||
    tl.includes('enchantment') ||
    tl.includes('planeswalker') ||
    tl.includes('battle')
  );
}

/** Create a Permanent from a Card (inline to avoid circular import with permanent.ts) */
function createPermanentFromCard(
  card: Card,
  controller: number,
  turn: number
): Permanent {
  const basePower = card.power ? parseInt(card.power, 10) || 0 : undefined;
  const baseToughness = card.toughness ? parseInt(card.toughness, 10) || 0 : undefined;

  return {
    ...card,
    controller,
    tapped: false,
    flipped: false,
    faceDown: false,
    currentPower: basePower,
    currentToughness: baseToughness,
    basePower,
    baseToughness,
    temporaryPtMods: [],
    damage: 0,
    currentLoyalty: card.loyalty ? parseInt(card.loyalty, 10) || 0 : undefined,
    counters: {},
    summoningSick: true,
    attacking: false,
    blocking: null,
    abilities: parseAbilities(card),
    x: 0,
    y: 0,
    enteredBattlefieldTurn: turn,
    attachments: [],
  };
}

/** Get the number of objects on the stack */
export function getStackSize(state: GameState): number {
  return state.stack.length;
}

/** Check if the stack is empty */
export function isStackEmpty(state: GameState): boolean {
  return state.stack.length === 0;
}

/** Peek at the top of the stack without removing */
export function peekStack(state: GameState): StackObject | null {
  if (state.stack.length === 0) return null;
  return state.stack[state.stack.length - 1];
}

/**
 * Copy a stack object (for Fork, Twincast, etc.).
 * Creates a new StackObject with the same properties but a new ID and controller.
 */
export function copyStackObject(
  original: StackObject,
  newController: number,
  newTargets?: Target[]
): StackObject {
  return {
    ...original,
    id: `copy_${original.id}_${Date.now().toString(36)}`,
    controller: newController,
    targets: newTargets || [...original.targets],
    text: `Copy of ${original.text}`,
  };
}
