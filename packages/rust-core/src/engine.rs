use crate::state::{Attacker, CombatState, GameAction, GameLogEntry, GameState};
use rand::seq::SliceRandom;
use rand::thread_rng;
use std::time::{SystemTime, UNIX_EPOCH};

pub fn apply_action(state: &mut GameState, action: &GameAction) {
    if state.game_over {
        return;
    }

    match action.type_.as_str() {
        "pass" => handle_pass_action(state, action.player),
        "play-land" => handle_play_land(state, action),
        "cast-spell" => handle_cast_spell(state, action),
        "declare-attackers" => handle_declare_attackers(state, action),
        "declare-blockers" => handle_declare_blockers(state, action),
        "concede" => {
            state.game_over = true;
            state.winner = Some(1 - action.player);
            log(state, format!("Player {} conceded.", action.player));
        }
        "mulligan" => handle_mulligan_action(state, action),
        _ => log(state, format!("Unknown action: {}", action.type_)),
    }
}

// --- Action Handlers ---

fn handle_pass_action(state: &mut GameState, player: u32) {
    if state.priority_player != player {
        return;
    }

    if state.mulligan_phase {
        keep_hand(state, player);
        return;
    }

    if state.both_players_passed {
        resolve_or_advance(state);
    } else {
        state.priority_player = 1 - player;
        state.both_players_passed = true;
        log(state, format!("Player {} passes priority.", player));
    }
}

fn handle_play_land(state: &mut GameState, action: &GameAction) {
    state.both_players_passed = false;
    if let Some(card_id) = &action.card_id {
        let player_idx = action.player as usize;
        let card = find_and_remove_from_hand(state, player_idx, card_id);
        if let Some(card) = card {
            let perm = crate::state::Permanent {
                id: format!("perm_{}", card.id),
                card_id: card.id.clone(),
                controller: action.player,
                owner: card.owner,
                name: card.name.clone(),
                type_line: card.type_line.clone(),
                oracle_text: card.oracle_text.clone(),
                tapped: false,
                flipped: false,
                face_down: false,
                summoning_sick: false,
                damage_marked: 0,
                current_power: None,
                current_toughness: None,
                cmc: card.cmc,
            };
            state.players[player_idx].battlefield.push(perm);
            state.players[player_idx].land_played_this_turn = true;
            state.players[player_idx].lands_played_this_turn += 1;
            log(
                state,
                format!("Player {} played land {}", action.player, card.name),
            );
        }
    }
}

fn handle_cast_spell(state: &mut GameState, action: &GameAction) {
    state.both_players_passed = false;
    if let Some(card_id) = &action.card_id {
        let player_idx = action.player as usize;
        let card = find_and_remove_from_hand(state, player_idx, card_id);
        if let Some(card) = card {
            let stack_obj = crate::state::StackObject {
                id: format!("stack_{}", card.id),
                type_: "spell".to_string(),
                card: Some(card.clone()),
                source: None,
                controller: action.player,
                text: format!("Cast {}", card.name),
            };
            state.stack.push(stack_obj);
            log(
                state,
                format!("Player {} casts {}", action.player, card.name),
            );
            state.priority_player = action.player;
        }
    }
}

fn handle_declare_attackers(state: &mut GameState, action: &GameAction) {
    if state.step != "declare-attackers" || state.active_player != action.player {
        return;
    }
    state.both_players_passed = false;

    if state.combat.is_none() {
        state.combat = Some(CombatState {
            attackers: vec![],
            blockers: vec![],
            step: "declare-attackers".to_string(),
        });
    }

    if let Some(targets) = &action.targets {
        let player_idx = action.player as usize;
        let opponent_id = (1 - action.player).to_string();
        let mut attackers_declared = Vec::new();

        let mut perm_indices = Vec::new();

        for target in targets {
            if target.type_ == "attacker" {
                if let Some(idx) = state.players[player_idx]
                    .battlefield
                    .iter()
                    .position(|p| p.id == target.id)
                {
                    perm_indices.push(idx);
                }
            }
        }

        for idx in perm_indices {
            let perm = &mut state.players[player_idx].battlefield[idx];
            if !perm.tapped && !perm.summoning_sick {
                perm.tapped = true;
                if let Some(combat) = &mut state.combat {
                    combat.attackers.push(Attacker {
                        permanent_id: perm.id.clone(),
                        target_id: opponent_id.clone(),
                    });
                }
                attackers_declared.push(perm.name.clone());
            }
        }

        if !attackers_declared.is_empty() {
            log(
                state,
                format!(
                    "Player {} attacks with: {}",
                    action.player,
                    attackers_declared.join(", ")
                ),
            );
        }
    }
}

fn handle_declare_blockers(state: &mut GameState, action: &GameAction) {
    if state.step != "declare-blockers" || state.active_player == action.player {
        return;
    }
    state.both_players_passed = false;
    log(
        state,
        format!(
            "Player {} declares blockers (logic simplified).",
            action.player
        ),
    );
}

fn resolve_or_advance(state: &mut GameState) {
    state.both_players_passed = false;
    if state.stack.is_empty() {
        advance_step_fixed(state);
        state.priority_player = state.active_player;
    } else {
        resolve_top_of_stack(state);
        state.priority_player = state.active_player;
    }
}

fn resolve_top_of_stack(state: &mut GameState) {
    if let Some(object) = state.stack.pop() {
        log(state, format!("Resolving {} on stack.", object.text));
        if object.type_.as_str() == "spell" {
            if let Some(card) = object.card {
                if card.type_line.contains("Creature")
                    || card.type_line.contains("Artifact")
                    || card.type_line.contains("Enchantment")
                {
                    // CRITICAL FIX: Ensure creatures always have power/toughness
                    // Default to 1/1 if not specified (for creatures) or 0/0 (for non-creatures)
                    let is_creature = card.type_line.contains("Creature");
                    let default_stat = if is_creature { Some(1) } else { Some(0) };

                    let power = parse_stat(&card.power).or(default_stat);
                    let toughness = parse_stat(&card.toughness).or(default_stat);

                    let perm = crate::state::Permanent {
                        id: format!("perm_{}", card.id),
                        card_id: card.id.clone(),
                        controller: object.controller,
                        owner: card.owner,
                        name: card.name.clone(),
                        type_line: card.type_line.clone(),
                        oracle_text: card.oracle_text.clone(),
                        tapped: false,
                        flipped: false,
                        face_down: false,
                        summoning_sick: true,
                        damage_marked: 0,
                        current_power: power,
                        current_toughness: toughness,
                        cmc: card.cmc,
                    };
                    state.players[object.controller as usize]
                        .battlefield
                        .push(perm);
                    log(
                        state,
                        format!(
                            "{} enters the battlefield (P/T: {}/{}).",
                            card.name,
                            power.unwrap_or(0),
                            toughness.unwrap_or(0)
                        ),
                    );
                } else {
                    state.players[object.controller as usize]
                        .graveyard
                        .push(card);
                }
            }
        }
    }
}

fn advance_step_fixed(state: &mut GameState) {
    let current = state.step.clone();
    eprintln!(
        "RUST DEBUG: Advancing from step '{}' on turn {}",
        current, state.turn
    );
    log(state, format!("DEBUG: Advancing from step '{}'", current));

    if current == "cleanup" {
        perform_cleanup_step(state);
        state.turn += 1;
        state.active_player = 1 - state.active_player;
        state.step = "untap".to_string();
        state.phase = "beginning".to_string();
        state.combat = None;
        perform_untap_step(state);
        return;
    }

    let next_step = get_next_step(&current);
    state.step = next_step.to_string();
    state.phase = step_to_phase(next_step);

    match next_step {
        "draw" => perform_draw_step(state),
        "combat-damage" => {
            log(state, "DEBUG: Entering combat-damage step".to_string());
            perform_combat_damage_step(state);
        }
        "declare-attackers" => {
            log(state, "DEBUG: Entering declare-attackers step".to_string());
        }
        _ => {}
    }

    log(state, format!("Entered {} step.", state.step));
}

fn get_next_step(current: &str) -> &str {
    match current {
        "untap" => "upkeep",
        "upkeep" => "draw",
        "draw" => "precombat-main",
        "precombat-main" => "begin-combat",
        "begin-combat" => "declare-attackers",
        "declare-attackers" => "declare-blockers",
        "declare-blockers" => "combat-damage",
        "combat-damage" => "end-combat",
        "end-combat" => "postcombat-main",
        "postcombat-main" => "end",
        "end" => "cleanup",
        _ => "cleanup",
    }
}

fn perform_untap_step(state: &mut GameState) {
    let active_id = state.active_player;
    log(
        state,
        format!("Turn {}: Untap Step for Player {}", state.turn, active_id),
    );
    for player in &mut state.players {
        if player.id == active_id {
            for perm in &mut player.battlefield {
                perm.tapped = false;
                perm.summoning_sick = false;
            }
            player.land_played_this_turn = false;
            player.lands_played_this_turn = 0;
        }
    }
}

fn perform_draw_step(state: &mut GameState) {
    let active_id = state.active_player as usize;
    if active_id >= state.players.len() {
        return;
    }
    if state.turn == 1 && state.active_player == 0 {
        log(
            state,
            "Turn 1: Skipping draw step for starting player".to_string(),
        );
        return;
    }

    let mut card_to_draw = None;
    let player_id = state.players[active_id].id;

    if let Some(card) = state.players[active_id].library.pop() {
        card_to_draw = Some(card);
    }

    if let Some(card) = card_to_draw {
        log(state, format!("Player {} draws {}", player_id, card.name));
        state.players[active_id].hand.push(card);
        state.players[active_id].has_drawn_this_game = true;
    } else {
        state.game_over = true;
        state.winner = Some(1 - state.active_player);
        log(
            state,
            format!(
                "Player {} attempted to draw from empty library and lost.",
                player_id
            ),
        );
    }
}

fn perform_combat_damage_step(state: &mut GameState) {
    eprintln!(
        "RUST DEBUG: Combat damage step started for turn {}",
        state.turn
    );
    log(state, "DEBUG: Combat damage step started".to_string());

    if let Some(combat) = state.combat.clone() {
        log(
            state,
            format!(
                "DEBUG: Found combat state with {} attackers",
                combat.attackers.len()
            ),
        );
        let mut damage_events = Vec::new();

        for attacker in &combat.attackers {
            let active_idx = state.active_player as usize;
            let attacker_info = state.players[active_idx]
                .battlefield
                .iter()
                .find(|p| p.id == attacker.permanent_id)
                .map(|perm| (perm.name.clone(), perm.current_power));

            if let Some((name, current_power)) = attacker_info {
                // CRITICAL FIX: Use current_power if available, otherwise default to 1
                // This ensures creatures always deal at least some damage
                let power = current_power.unwrap_or(1);
                log(
                    state,
                    format!("DEBUG: Attacker {} has power {}", name, power),
                );
                if power > 0 {
                    damage_events.push((name, power));
                }
            } else {
                log(
                    state,
                    format!(
                        "DEBUG: Could not find attacker with id {}",
                        attacker.permanent_id
                    ),
                );
            }
        }

        log(
            state,
            format!("DEBUG: Processing {} damage events", damage_events.len()),
        );
        for (attacker_name, power) in damage_events {
            let defender_idx = (1 - state.active_player) as usize;
            let old_life = state.players[defender_idx].life;
            state.players[defender_idx].life -= power;
            log(
                state,
                format!(
                    "{} deals {} damage to Player {} (life: {} -> {})",
                    attacker_name,
                    power,
                    state.players[defender_idx].id,
                    old_life,
                    state.players[defender_idx].life
                ),
            );
        }

        let mut loser = None;
        for player in &state.players {
            if player.life <= 0 {
                loser = Some(player.id);
            }
        }

        if let Some(loser_id) = loser {
            state.game_over = true;
            state.winner = Some(1 - loser_id);
            log(state, format!("Player {} has 0 life and loses.", loser_id));
        }
    } else {
        log(state, "DEBUG: No combat state found".to_string());
    }
}

fn perform_cleanup_step(state: &mut GameState) {
    log(state, "Cleanup Step".to_string());
    for player in &mut state.players {
        for perm in &mut player.battlefield {
            perm.damage_marked = 0;
        }
    }
}

fn find_and_remove_from_hand(
    state: &mut GameState,
    player_idx: usize,
    card_id: &str,
) -> Option<crate::state::Card> {
    let mut card_index = None;
    for (i, card) in state.players[player_idx].hand.iter().enumerate() {
        if card.id == *card_id {
            card_index = Some(i);
            break;
        }
    }
    if let Some(idx) = card_index {
        Some(state.players[player_idx].hand.remove(idx))
    } else {
        None
    }
}

fn parse_stat(stat: &Option<String>) -> Option<i32> {
    match stat {
        Some(s) => s.parse::<i32>().ok(),
        None => None,
    }
}

fn step_to_phase(step: &str) -> String {
    match step {
        "untap" | "upkeep" | "draw" => "beginning".to_string(),
        "precombat-main" => "precombat-main".to_string(),
        "begin-combat" | "declare-attackers" | "declare-blockers" | "combat-damage"
        | "end-combat" => "combat".to_string(),
        "postcombat-main" => "postcombat-main".to_string(),
        "end" | "cleanup" => "ending".to_string(),
        _ => "beginning".to_string(),
    }
}

fn log(state: &mut GameState, message: String) {
    if let Some(log) = &mut state.log {
        let entry = GameLogEntry {
            timestamp: get_timestamp(),
            turn: state.turn,
            phase: state.phase.clone(),
            step: state.step.clone(),
            player: None, // Or prioritize active player?
            message,
            card_name: None,
            action_type: None,
        };
        log.push(entry);
    }
}

fn get_timestamp() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as f64
}

fn handle_mulligan_action(state: &mut GameState, action: &GameAction) {
    // Check if we start a new mulligan (shuffle & draw)
    if let Some(to_bottom) = &action.to_bottom {
        if to_bottom.len() == 1 && to_bottom[0] == "MULLIGAN" {
            start_mulligan(state, action.player);
            return;
        }
    }

    // Check if keeping hand (empty to_bottom)
    let is_keep = match &action.to_bottom {
        Some(tb) => tb.is_empty(),
        None => true,
    };

    if is_keep {
        keep_hand(state, action.player);
    } else {
        // London Mulligan logic (put cards on bottom)
        if let Some(to_bottom) = &action.to_bottom {
            perform_london_mulligan(state, action.player, to_bottom);
        }

        // After putting cards on bottom, we check if everyone kept?
        // Logic in TS: effectively treats London resolution as a Keep.
        keep_hand(state, action.player);
    }
}

fn start_mulligan(state: &mut GameState, player_idx: u32) {
    let p_idx = player_idx as usize;
    log(state, format!("Player {} takes a mulligan.", player_idx));

    // 1. Move hand to library
    let mut hand_cards: Vec<crate::state::Card> = state.players[p_idx].hand.drain(..).collect();
    state.players[p_idx].library.append(&mut hand_cards);

    // 2. Shuffle
    let mut rng = thread_rng();
    state.players[p_idx].library.shuffle(&mut rng);

    // 3. Draw 7
    for _ in 0..7 {
        if let Some(card) = state.players[p_idx].library.pop() {
            state.players[p_idx].hand.push(card);
        }
    }

    // 4. Increment count
    if p_idx < state.mulligan_count.len() {
        state.mulligan_count[p_idx] += 1;
    }

    // Reset passed flags
    state.both_players_passed = false;
}

fn keep_hand(state: &mut GameState, player_idx: u32) {
    log(state, format!("Player {} keeps their hand.", player_idx));
    check_mulligan_completion(state);
}

fn perform_london_mulligan(state: &mut GameState, player_idx: u32, to_bottom: &Vec<String>) {
    let p_idx = player_idx as usize;
    log(
        state,
        format!(
            "Player {} puts {} cards on bottom.",
            player_idx,
            to_bottom.len()
        ),
    );

    // Remove cards from hand and put on bottom of library
    for card_id in to_bottom {
        if let Some(idx) = state.players[p_idx]
            .hand
            .iter()
            .position(|c| c.id == *card_id)
        {
            let card = state.players[p_idx].hand.remove(idx);
            state.players[p_idx].library.insert(0, card);
        }
    }
}

fn check_mulligan_completion(state: &mut GameState) {
    // Count "keeps their hand"
    let mut keep_count = 0;
    if let Some(log) = &state.log {
        for entry in log {
            if entry.message.contains("keeps their hand") {
                keep_count += 1;
            }
        }
    }

    if keep_count >= 2 {
        state.mulligan_phase = false;
        state.step = "draw".to_string();
        state.phase = "beginning".to_string();
        state.priority_player = state.active_player;
        state.both_players_passed = false;
        log(state, "Mulligan phase complete. Starting game.".to_string());

        perform_draw_step(state);
    }
}
