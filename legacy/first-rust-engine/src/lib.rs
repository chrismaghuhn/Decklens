// #![deny(clippy::all)]

use napi_derive::napi;

#[napi]
pub fn sum(a: i32, b: i32) -> i32 {
  a + b
}

pub mod engine;
pub mod state;
pub mod validation;
pub mod features;

use crate::state::{GameState, GameAction};
use crate::engine::apply_action;
use crate::validation::validate_action;

#[napi]
pub fn hello_world() -> String {
    "Hello from Rust Core!".to_string()
}

#[napi]
pub fn native_validate_action(state: GameState, action: GameAction) -> bool {
    validate_action(&state, &action).is_ok()
}

#[napi]
pub fn native_apply_action(state: GameState, action: GameAction) -> GameState {
    let mut new_state = state; // N-API object is already owned, but for safety in complex logic we might clone if we wanted to keep the original. 
    // However, here we want to return a Modified state. 
    // Since GameAction is passed by value, we can use it.
    
    apply_action(&mut new_state, &action);
    
    new_state
}

#[napi]
pub fn benchmark_simulation(state: GameState, iterations: u32) -> u32 {
    let mut current_state = state;
    let dummy_action = GameAction {
        type_: "pass".to_string(),
        player: 0,
        card_id: None,
        source_id: None,
        ability_index: None,
        targets: None,
        to_bottom: None,
    };
    
    for _ in 0..iterations {
        // 1. Clone State
        let mut simulated_state = current_state.clone();
        
        // 2. Apply Action (Engine Logic)
        apply_action(&mut simulated_state, &dummy_action);
    }
    
    current_state.turn
}
#[napi]
pub struct GameSession {
    state: GameState,
}

impl Default for GameSession {
    fn default() -> Self {
        Self::new()
    }
}

#[napi]
impl GameSession {
    #[napi(constructor)]
    pub fn new() -> Self {
        let mut state = crate::state::create_empty_state();
        state.players.push(crate::state::create_player(0));
        state.players.push(crate::state::create_player(1));
        
        GameSession {
            state,
        }
    }

    #[napi]
    pub fn apply_action(&mut self, action: GameAction) {
        apply_action(&mut self.state, &action);
    }
    
    #[napi]
    pub fn get_turn(&self) -> u32 {
        self.state.turn
    }
    
    #[napi]
    pub fn is_game_over(&self) -> bool {
        self.state.game_over
    }

    #[napi]
    pub fn get_priority_player(&self) -> u32 {
        self.state.priority_player
    }

    #[napi]
    pub fn get_active_player(&self) -> u32 {
        self.state.active_player
    }

    #[napi]
    pub fn get_features(&self, player: u32) -> Vec<f32> {
        crate::features::extract_features(&self.state, player)
    }

    #[napi]
    pub fn get_legal_actions(&self, player: u32) -> Vec<GameAction> {
        crate::validation::get_legal_actions(&self.state, player)
    }

    #[napi]
    pub fn get_score(&self, player: u32) -> f32 {
        let p_idx = player as usize;
        if p_idx >= self.state.players.len() { return 0.0; }
        
        let p = &self.state.players[p_idx];
        let opp = &self.state.players[1 - p_idx];
        
        let mut score = 0.0;
        
        // Life
        score += p.life as f32;
        
        // Hand advantage
        score += (p.hand.len() as f32) * 2.0;
        
        // Board advantage (simple count)
        score += (p.battlefield.len() as f32) * 3.0;
        
        // Health difference
        score += ((p.life - opp.life) as f32) * 0.5;
        
        score
    }
}
