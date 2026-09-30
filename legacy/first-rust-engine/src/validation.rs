use crate::state::{GameState, GameAction};

pub fn validate_action(state: &GameState, action: &GameAction) -> Result<(), String> {
    if state.game_over {
        return Err("Game is over".to_string());
    }

    // Concede is always valid
    if action.type_ == "concede" {
        return Ok(());
    }

    // Mulligan phase logic
    if state.mulligan_phase {
        if action.type_ == "mulligan" {
            // In a real implementation, we might check if they have cards to mulligan
            return Ok(());
        }
        if action.type_ == "concede" {
            return Ok(());
        }
        return Err("Not in mulligan phase (or invalid action for mulligan)".to_string());
    }

    // Pass is generally valid if you have priority
    if action.type_ == "pass" {
        if state.priority_player != action.player {
            return Err("Not your priority".to_string());
        }
        // In Untap/Cleanup, players usually can't act, but we allowed "pass" in TS optimization
        // to let the engine progress. We keep that logic here.
        return Ok(());
    }

    // Check priority for all other actions
    if state.priority_player != action.player {
        return Err("Not your priority".to_string());
    }

    // Phase/Step restrictions handled by specific validators
    match action.type_.as_str() {
        "play-land" => validate_play_land(state, action),
        "cast-spell" => validate_cast_spell(state, action),
        "activate-ability" => validate_activate_ability(state, action),
        _ => Err(format!("Unknown action type: {}", action.type_)),
    }
}

fn validate_play_land(state: &GameState, action: &GameAction) -> Result<(), String> {
    let player = &state.players[action.player as usize];

    // 1. Timing: Main Phase, Stack Empty, Active Player
    if state.phase != "precombat-main" && state.phase != "postcombat-main" {
        return Err("Can only play lands during main phase".to_string());
    }
    if state.active_player != action.player {
        return Err("Only active player can play lands".to_string());
    }
    if !state.stack.is_empty() {
        return Err("Cannot play lands while stack is not empty".to_string());
    }

    // 2. Limit: Lands per turn
    if player.lands_played_this_turn >= player.max_land_plays {
        return Err("Already played maximum lands this turn".to_string());
    }

    // 3. Card Check: Must be in hand and be a land
    if let Some(card_id) = &action.card_id {
        if let Some(card) = player.hand.iter().find(|c| c.id == *card_id) {
            if !card.type_line.to_lowercase().contains("land") {
                return Err("Card is not a land".to_string());
            }
        } else {
            return Err("Card not found in hand".to_string());
        }
    } else {
        return Err("No card specified for play-land".to_string());
    }

    Ok(())
}

fn validate_cast_spell(state: &GameState, action: &GameAction) -> Result<(), String> {
    // Placeholder: Full casting logic is complex (mana, targets, timing)
    // For now, we just check timing basic
    let player = &state.players[action.player as usize];
    
    if let Some(card_id) = &action.card_id {
        if let Some(card) = player.hand.iter().find(|c| c.id == *card_id) {
            let is_instant = card.type_line.to_lowercase().contains("instant") || card.oracle_text.to_lowercase().contains("flash");
            
            if !is_instant {
                // Sorcery speed checks
                if state.active_player != action.player {
                    return Err("Cannot cast sorcery-speed spell on opponent's turn".to_string());
                }
                if (state.phase != "precombat-main" && state.phase != "postcombat-main") || !state.stack.is_empty() {
                    return Err("Cannot cast sorcery-speed spell outside main phase or with non-empty stack".to_string());
                }
            }
            
            // TODO: Check Mana Cost
            
        } else {
            return Err("Card not found in hand".to_string());
        }
    } else {
        return Err("No card specified for cast-spell".to_string());
    }

    Ok(())
}

fn validate_activate_ability(_state: &GameState, _action: &GameAction) -> Result<(), String> {
    // Placeholder
    Ok(())
}

pub fn get_legal_actions(state: &GameState, player: u32) -> Vec<GameAction> {
    let mut actions = Vec::new();
    let p_idx = player as usize;
    
    // 1. Pass
    let pass_action = GameAction {
        type_: "pass".to_string(),
        player,
        card_id: None,
        source_id: None,
        ability_index: None,
        targets: None,
        to_bottom: None,
    };
    if validate_action(state, &pass_action).is_ok() {
        actions.push(pass_action);
    }
    
    // 2. Play Land
    for card in &state.players[p_idx].hand {
        let action = GameAction {
            type_: "play-land".to_string(),
            player,
            card_id: Some(card.id.clone()),
            source_id: None,
            ability_index: None,
            targets: None,
            to_bottom: None,
        };
        if validate_play_land(state, &action).is_ok() {
            actions.push(action);
        }
    }
    
    // 3. Cast Spell
    for card in &state.players[p_idx].hand {
        let action = GameAction {
            type_: "cast-spell".to_string(),
            player,
            card_id: Some(card.id.clone()),
            source_id: None,
            ability_index: None,
            targets: None,
            to_bottom: None,
        };
        if validate_cast_spell(state, &action).is_ok() {
            actions.push(action);
        }
    }
    
    // 4. Concede (Always valid but we don't usually want the bot to concede in training unless stuck)
    
    // 5. Combat (Attack/Block) - Placeholder
    // If step is declare-attackers, generate attack actions?
    // Current Rust engine might expects "declare-attackers" with targets?
    // For now, minimal set.
    
    actions
}
