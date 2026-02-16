use napi_derive::napi;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ManaPool {
    #[napi(js_name = "W")]
    pub w: u32,
    #[napi(js_name = "U")]
    pub u: u32,
    #[napi(js_name = "B")]
    pub b: u32,
    #[napi(js_name = "R")]
    pub r: u32,
    #[napi(js_name = "G")]
    pub g: u32,
    #[napi(js_name = "C")]
    pub c: u32,
    #[napi(js_name = "S")]
    pub s: u32,
    pub generic: u32,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    #[napi(js_name = "oracleId")]
    pub oracle_id: String,
    pub name: String,
    #[napi(js_name = "manaCost")]
    pub mana_cost: String,
    pub cmc: f64,
    #[napi(js_name = "typeLine")]
    pub type_line: String,
    #[napi(js_name = "oracleText")]
    pub oracle_text: String,
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub loyalty: Option<String>,
    pub colors: Vec<String>,
    #[napi(js_name = "colorIdentity")]
    pub color_identity: Vec<String>,
    pub tags: Vec<String>,
    #[napi(js_name = "imageUrl")]
    pub image_url: String,
    pub owner: u32, // Changed from u8
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Permanent {
    pub id: String,
    #[napi(js_name = "cardId")]
    pub card_id: String,
    pub controller: u32, // Changed from u8
    pub owner: u32, // Changed from u8
    pub name: String,
    #[napi(js_name = "typeLine")]
    pub type_line: String,
    #[napi(js_name = "oracleText")]
    pub oracle_text: String,
    pub tapped: bool,
    pub flipped: bool,
    #[napi(js_name = "faceDown")]
    pub face_down: bool,
    #[napi(js_name = "summoningSick")]
    pub summoning_sick: bool,
    #[napi(js_name = "damageMarked")]
    pub damage_marked: u32,
    
    #[napi(js_name = "currentPower")]
    pub current_power: Option<i32>,
    #[napi(js_name = "currentToughness")]
    pub current_toughness: Option<i32>,
    pub cmc: f64,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlayerState {
    pub id: u32, // Changed from u8
    pub name: String,
    pub life: i32,
    #[napi(js_name = "poisonCounters")]
    pub poison_counters: u32,
    #[napi(js_name = "manaPool")]
    pub mana_pool: ManaPool,
    
    pub hand: Vec<Card>,
    pub library: Vec<Card>,
    pub graveyard: Vec<Card>,
    pub exile: Vec<Card>,
    pub battlefield: Vec<Permanent>,
    #[napi(js_name = "commandZone")]
    pub command_zone: Vec<Card>,
    
    #[napi(js_name = "commanderTax")]
    pub commander_tax: u32,
    
    // Using HashMap for better JS interop
    #[napi(js_name = "commanderDamage")]
    pub commander_damage: Option<HashMap<String, u32>>, 
    
    #[napi(js_name = "landPlayedThisTurn")]
    pub land_played_this_turn: bool,
    #[napi(js_name = "landsPlayedThisTurn")]
    pub lands_played_this_turn: u32,
    #[napi(js_name = "maxLandPlays")]
    pub max_land_plays: u32,
    #[napi(js_name = "hasDrawnThisGame")]
    pub has_drawn_this_game: bool,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StackObject {
    pub id: String,
    #[napi(js_name = "type")]
    pub type_: String, 
    pub card: Option<Card>,
    pub source: Option<Permanent>,
    pub controller: u32, // Changed from u8
    pub text: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Target {
    #[napi(js_name = "type")]
    pub type_: String,
    pub id: String,
    pub zone: Option<String>,
}

#[napi(object, js_name = "GameAction")]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GameAction {
    #[napi(js_name = "type")]
    pub type_: String,
    pub player: u32, // Changed from u8
    #[napi(js_name = "cardId")]
    pub card_id: Option<String>,
    #[napi(js_name = "sourceId")]
    pub source_id: Option<String>,
    #[napi(js_name = "abilityIndex")]
    pub ability_index: Option<u32>,
    pub targets: Option<Vec<Target>>,
    #[napi(js_name = "toBottom")]
    pub to_bottom: Option<Vec<String>>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Attacker {
    #[napi(js_name = "permanentId")]
    pub permanent_id: String,
    #[napi(js_name = "targetId")]
    pub target_id: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blocker {
    #[napi(js_name = "permanentId")]
    pub permanent_id: String,
    #[napi(js_name = "attackerId")]
    pub attacker_id: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CombatState {
    pub attackers: Vec<Attacker>,
    pub blockers: Vec<Blocker>,
    pub step: String,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GameState {
    pub players: Vec<PlayerState>,
    #[napi(js_name = "activePlayer")]
    pub active_player: u32, // Changed from u8
    #[napi(js_name = "priorityPlayer")]
    pub priority_player: u32, // Changed from u8
    pub turn: u32,
    pub phase: String,
    pub step: String,
    pub stack: Vec<StackObject>,
    #[napi(js_name = "bothPlayersPassed")]
    pub both_players_passed: bool,
    #[napi(js_name = "gameOver")]
    pub game_over: bool,
    pub winner: Option<u32>, // Changed from Option<u8> to Option<u32>
    
    #[napi(js_name = "mulliganPhase")]
    pub mulligan_phase: bool,
    #[napi(js_name = "mulliganCount")]
    pub mulligan_count: Vec<u32>,
    
    // TS defines log as GameLogEntry[], but simplified we can take any or skip
    // Let's make it optional and generic-ish (Vec<serde_json::Value> or similar if complex)
    // For now, simpler: Ignore log in Rust logic (it's for UI), but we need to accept it from JS
    // TS sends GameLogEntry objects. Rust expects Vec<String>. This will fail!
    // We must match the TS structure OR use a flexible type.
    // Changing log to Option<Vec<serde_json::Value>> or defining GameLogEntry struct.
    // Easiest: Define GameLogEntry struct.
    pub log: Option<Vec<GameLogEntry>>,
    
    #[napi(js_name = "actionHistory")]
    pub action_history: Option<Vec<GameAction>>,
    
    pub combat: Option<CombatState>,
}

#[napi(object)]
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GameLogEntry {
    pub timestamp: f64, // JS number
    pub turn: u32,
    pub phase: String,
    pub step: String,
    pub player: Option<u32>,
    pub message: String,
    #[napi(js_name = "cardName")]
    pub card_name: Option<String>,
    #[napi(js_name = "actionType")]
    pub action_type: Option<String>,
}

#[napi]
pub fn create_empty_state() -> GameState {
    GameState {
        players: vec![],
        active_player: 0,
        priority_player: 0,
        turn: 1,
        phase: "beginning".to_string(),
        step: "untap".to_string(),
        stack: vec![],
        both_players_passed: false,
        game_over: false,
        winner: None,
        mulligan_phase: true,
        mulligan_count: vec![0, 0],
        log: Some(vec![]),
        action_history: Some(vec![]),
        combat: None,
    }
}

pub fn create_player(id: u32) -> PlayerState {
    PlayerState {
        id,
        name: format!("Player {}", id),
        life: 20,
        poison_counters: 0,
        mana_pool: ManaPool { w: 0, u: 0, b: 0, r: 0, g: 0, c: 0, s: 0, generic: 0 },
        hand: vec![],
        library: create_dummy_deck(id),
        graveyard: vec![],
        exile: vec![],
        battlefield: vec![],
        command_zone: vec![],
        commander_tax: 0,
        commander_damage: Some(HashMap::new()),
        land_played_this_turn: false,
        lands_played_this_turn: 0,
        max_land_plays: 1,
        has_drawn_this_game: false,
    }
}

pub fn create_dummy_deck(owner_id: u32) -> Vec<Card> {
    let mut deck = Vec::new();
    
    // 40 Lands
    for i in 0..40 {
        deck.push(Card {
            id: format!("land_{}_{}", owner_id, i),
            oracle_id: "oid_land".to_string(),
            name: "Basic Land".to_string(),
            mana_cost: "".to_string(),
            cmc: 0.0,
            type_line: "Basic Land".to_string(),
            oracle_text: "{T}: Add {G}.".to_string(),
            power: None,
            toughness: None,
            loyalty: None,
            colors: vec![],
            color_identity: vec!["G".to_string()],
            tags: vec![],
            image_url: "".to_string(),
            owner: owner_id,
        });
    }
    
    // 20 Spells (Creatures)
    for i in 0..20 {
        deck.push(Card {
            id: format!("spell_{}_{}", owner_id, i),
            oracle_id: "oid_bear".to_string(),
            name: "Grizzly Bears".to_string(),
            mana_cost: "{1}{G}".to_string(),
            cmc: 2.0,
            type_line: "Creature — Bear".to_string(),
            oracle_text: "".to_string(),
            power: Some("2".to_string()),
            toughness: Some("2".to_string()),
            loyalty: None,
            colors: vec!["G".to_string()],
            color_identity: vec!["G".to_string()],
            tags: vec![],
            image_url: "".to_string(),
            owner: owner_id, 
        });
    }
    
    // Shuffle? No, engine shuffles on start.
    // Actually engine.rs start_mulligan shuffles library.
    
    deck
}
