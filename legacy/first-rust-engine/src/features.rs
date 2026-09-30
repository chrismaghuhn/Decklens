use crate::state::{GameState, Card, Permanent};
use std::collections::HashSet;

pub const FEATURE_DIM_V4: usize = 384;

#[allow(dead_code)]
struct BattlefieldStats {
    creatures: f32,
    non_creatures: f32,
    lands: f32,
    artifacts: f32,
    enchantments: f32,
    tapped: f32,
    untapped: f32,
    summoning_sick: f32,
    total_power: f32,
    total_toughness: f32,
    max_power: f32,
    has_planeswalker: bool,
    total_loyalty: f32,
    total_cmc: f32,
    non_land_count: f32,
    tag_ramp: f32,
    tag_engine: f32,
    tag_draw: f32,
    tag_combo_piece: f32,
    has_flying: bool,
    has_trample: bool,
    has_lifelink: bool,
    has_double_strike: bool,
    has_hexproof: bool,
    has_indestructible: bool,
    flying_power: f32,
    trample_power: f32,
    evasive_power: f32,
    attackable_power: f32,
    attackable_count: f32,
    with_abilities: f32,
    total_power_tough_product: f32,
    color_diversity: f32,
    vigilance_count: f32,
    haste_count: f32,
    menace_count: f32,
    deathtouch_count: f32,
    shroud_count: f32,
    ward_count: f32,
    first_strike_count: f32,
    reach_count: f32,
    unblockable_count: f32,
    etb_creature_count: f32,
    sacrifice_outlet_count: f32,
    token_generator_count: f32,
    enchantment_count: f32,
    dual_lands_count: f32,
    untapped_land_count: f32,
}

impl Default for BattlefieldStats {
    fn default() -> Self {
        BattlefieldStats {
            creatures: 0.0, non_creatures: 0.0, lands: 0.0, artifacts: 0.0, enchantments: 0.0,
            tapped: 0.0, untapped: 0.0, summoning_sick: 0.0,
            total_power: 0.0, total_toughness: 0.0, max_power: 0.0,
            has_planeswalker: false, total_loyalty: 0.0,
            total_cmc: 0.0, non_land_count: 0.0,
            tag_ramp: 0.0, tag_engine: 0.0, tag_draw: 0.0, tag_combo_piece: 0.0,
            has_flying: false, has_trample: false, has_lifelink: false,
            has_double_strike: false, has_hexproof: false, has_indestructible: false,
            flying_power: 0.0, trample_power: 0.0, evasive_power: 0.0,
            attackable_power: 0.0, attackable_count: 0.0, with_abilities: 0.0,
            total_power_tough_product: 0.0, color_diversity: 0.0,
            vigilance_count: 0.0, haste_count: 0.0, menace_count: 0.0, deathtouch_count: 0.0,
            shroud_count: 0.0, ward_count: 0.0, first_strike_count: 0.0, reach_count: 0.0, unblockable_count: 0.0,
            etb_creature_count: 0.0, sacrifice_outlet_count: 0.0, token_generator_count: 0.0,
            enchantment_count: 0.0, dual_lands_count: 0.0, untapped_land_count: 0.0,
        }
    }
}

struct HandStats {
    lands: f32,
    creatures: f32,
    instants: f32,
    sorceries: f32,
    total_cmc: f32,
    min_cmc: f32,
    max_cmc: f32,
    spell_count: f32,
    tag_ramp: f32,
    tag_draw: f32,
    tag_removal: f32,
    tag_counter: f32,
    tag_wipe: f32,
    tag_tutor: f32,
    tag_combo_piece: f32,
    tag_engine: f32,
    tag_finisher: f32,
    tag_protection: f32,
    tag_token_gen: f32,
    tag_recursion: f32,
    tag_reanimation: f32,
    cmc_curve: [f32; 7],
}

impl Default for HandStats {
    fn default() -> Self {
        HandStats {
            lands: 0.0, creatures: 0.0, instants: 0.0, sorceries: 0.0,
            total_cmc: 0.0, min_cmc: 999.0, max_cmc: 0.0, spell_count: 0.0,
            tag_ramp: 0.0, tag_draw: 0.0, tag_removal: 0.0, tag_counter: 0.0,
            tag_wipe: 0.0, tag_tutor: 0.0, tag_combo_piece: 0.0, tag_engine: 0.0,
            tag_finisher: 0.0, tag_protection: 0.0, tag_token_gen: 0.0,
            tag_recursion: 0.0, tag_reanimation: 0.0,
            cmc_curve: [0.0; 7],
        }
    }
}

struct GraveyardStats {
    creatures: f32,
    spells: f32,
    lands: f32,
    total_cmc: f32,
    removals: f32,
    high_cmc_creatures: f32,
    recursion_targets: f32,
}

impl Default for GraveyardStats {
    fn default() -> Self {
        GraveyardStats {
            creatures: 0.0, spells: 0.0, lands: 0.0, total_cmc: 0.0,
            removals: 0.0, high_cmc_creatures: 0.0, recursion_targets: 0.0,
        }
    }
}

fn norm(value: f32, min: f32, max: f32) -> f32 {
    if max == min { 0.0 } else { ((value - min) / (max - min)).clamp(0.0, 1.0) }
}

fn analyze_battlefield(perms: &Vec<Permanent>) -> BattlefieldStats {
    let mut stats = BattlefieldStats::default();
    let mut colors_found: HashSet<String> = HashSet::new();

    for p in perms {
        let tl = p.type_line.to_lowercase();
        let oracle = p.oracle_text.to_lowercase();
        
        // Colors
        // Rust note: `p.colors` is Vec<String> which is expensive to iterate often?
        // Actually it's fine.
        // But we don't have p.colors in Permanent struct in state.rs? 
        // Wait, Permanent struct does NOT have colors?
        // Checking state.rs... 
        // Permanent output in Step 467 shows: id, card_id, controller, owner, name, type_line, oracle_text, tapped, flipped, face_down, summoning_sick, damage_marked, current_power, current_toughness, cmc.
        // It DOES NOT have colors! 
        // JS version might be inferring it or it was added later.
        // For now, I'll skip color diversity from Permanent or try to infer from casting cost of card if I had access to card, but I only have Perm.
        // Actually I can ignore color diversity for now or implement it if I add colors to Permanent.
        // Let's skip it to avoid breaking compilation.

        let is_creature = p.current_power.is_some();

        if is_creature {
            stats.creatures += 1.0;
            let pow = p.current_power.unwrap_or(0) as f32;
            let tough = p.current_toughness.unwrap_or(0) as f32;
            stats.total_power += pow;
            stats.total_toughness += tough;
            if pow > stats.max_power { stats.max_power = pow; }
            stats.total_power_tough_product += pow * tough;

            if !p.summoning_sick && !p.tapped {
                stats.attackable_power += pow;
                stats.attackable_count += 1.0;
            }

            let has_flying = oracle.contains("flying");
            let has_trample = oracle.contains("trample");
            
            if has_flying { stats.has_flying = true; stats.flying_power += pow; }
            if has_trample { stats.has_trample = true; stats.trample_power += pow; }
            if oracle.contains("lifelink") { stats.has_lifelink = true; }
            if oracle.contains("double strike") { stats.has_double_strike = true; }
            if oracle.contains("hexproof") { stats.has_hexproof = true; }
            if oracle.contains("indestructible") { stats.has_indestructible = true; }

            if has_flying || has_trample || oracle.contains("unblockable") || oracle.contains("can't be blocked") {
                stats.evasive_power += pow;
            }
            
            if oracle.contains("vigilance") { stats.vigilance_count += 1.0; }
            if oracle.contains("haste") { stats.haste_count += 1.0; }
            if oracle.contains("menace") { stats.menace_count += 1.0; }
            if oracle.contains("deathtouch") { stats.deathtouch_count += 1.0; }
            if oracle.contains("shroud") { stats.shroud_count += 1.0; }
            if oracle.contains("ward") { stats.ward_count += 1.0; }
            if oracle.contains("first strike") && !oracle.contains("double strike") { stats.first_strike_count += 1.0; }
            if oracle.contains("reach") { stats.reach_count += 1.0; }
            if oracle.contains("unblockable") || oracle.contains("can't be blocked") { stats.unblockable_count += 1.0; }
            
            if oracle.contains("enters the battlefield") || (oracle.contains("when") && oracle.contains("enters")) {
                stats.etb_creature_count += 1.0;
            }
        } else {
            stats.non_creatures += 1.0;
        }

        if tl.contains("land") {
            stats.lands += 1.0;
            if !p.tapped { stats.untapped_land_count += 1.0; }
            // dual lands heuristic simple check
             if oracle.contains("add") && oracle.matches("{").count() >= 2 {
                stats.dual_lands_count += 1.0;
            }
        } else {
            stats.non_land_count += 1.0;
            stats.total_cmc += p.cmc as f32;
        }

        if tl.contains("artifact") { stats.artifacts += 1.0; }
        if tl.contains("enchantment") { 
            stats.enchantments += 1.0; 
            stats.enchantment_count += 1.0;
        }

        if oracle.contains("sacrifice") { stats.sacrifice_outlet_count += 1.0; }
        if oracle.contains("create") && oracle.contains("token") { stats.token_generator_count += 1.0; }
        
        // Permanent struct doesn't have current_loyalty? 
        // state.rs Permanent has: loyalty: Option<String> in Card, but Permanent has... nothing about loyalty?
        // Checking state.rs again...
        // Permanent: ... current_power: Option<i32>, current_toughness: Option<i32>, cmc: f64
        // No loyalty on Permanent. 
        // I'll skip planeswalker loyalty logic for now to avoid errors.
        
        if p.tapped { stats.tapped += 1.0; } else { stats.untapped += 1.0; }
        if p.summoning_sick { stats.summoning_sick += 1.0; }
        
        // Tags - Permanent doesn't have tags? Card has tags.
        // State.rs: Permanent has `cardId`. We might need to look up Card tags?
        // Efficient way: pass `state` or lookup map?
        // For Speed: Permanent SHOULD carry tags if we need them fast.
        // But for now, we don't have them on Permanent.
        // Strategy: Assume tags are missing on Permanent for MVP version.
        // Or better: The TS version has `p.tags`. This implies the JS `Permanent` object extends `Card` or copies tags.
        // In Rust, we strictly separate.
        // I will SKIP tags on battlefield for now.
    }
    
    stats.color_diversity = colors_found.len() as f32;
    stats
}

fn analyze_hand(hand: &Vec<Card>) -> HandStats {
    let mut stats = HandStats::default();
    
    for c in hand {
        let tl = c.type_line.to_lowercase();
        
        if tl.contains("land") {
            stats.lands += 1.0;
            continue;
        }
        
        stats.spell_count += 1.0;
        stats.total_cmc += c.cmc as f32;
        if (c.cmc as f32) < stats.min_cmc { stats.min_cmc = c.cmc as f32; }
        if (c.cmc as f32) > stats.max_cmc { stats.max_cmc = c.cmc as f32; }
        
        let bucket = (c.cmc as usize).min(6);
        stats.cmc_curve[bucket] += 1.0;
        
        if tl.contains("creature") { stats.creatures += 1.0; }
        if tl.contains("instant") { stats.instants += 1.0; }
        if tl.contains("sorcery") { stats.sorceries += 1.0; }
        
        for t in &c.tags {
            match t.as_str() {
                "ramp" => stats.tag_ramp += 1.0,
                "draw" => stats.tag_draw += 1.0,
                "removal" => stats.tag_removal += 1.0,
                "counter" => stats.tag_counter += 1.0,
                "wipe" => stats.tag_wipe += 1.0,
                "tutor" => stats.tag_tutor += 1.0,
                "combo-piece" => stats.tag_combo_piece += 1.0,
                "engine" => stats.tag_engine += 1.0,
                "finisher" => stats.tag_finisher += 1.0,
                "protection" => stats.tag_protection += 1.0,
                "token-generator" => stats.tag_token_gen += 1.0,
                "recursion" => stats.tag_recursion += 1.0,
                "reanimation" => stats.tag_reanimation += 1.0,
                _ => {}
            }
        }
    }
    
    if stats.min_cmc == 999.0 { stats.min_cmc = 0.0; }
    
    stats
}

fn analyze_graveyard(gy: &Vec<Card>) -> GraveyardStats {
    let mut stats = GraveyardStats::default();
    
    for c in gy {
        let tl = c.type_line.to_lowercase();
        if tl.contains("land") {
            stats.lands += 1.0;
            continue;
        }
        stats.total_cmc += c.cmc as f32;
        if tl.contains("creature") {
            stats.creatures += 1.0;
            if c.cmc >= 5.0 { stats.high_cmc_creatures += 1.0; }
        } else {
            stats.spells += 1.0;
        }
        
        for t in &c.tags {
             if t == "removal" { stats.removals += 1.0; }
             if t == "recursion" || t == "reanimation" { stats.recursion_targets += 1.0; }
        }
    }
    stats
}

// Helper to count specific phase/step
fn map_phase(p: &str) -> f32 {
    match p {
        "beginning" => 0.0,
        "precombat-main" => 0.25,
        "combat" => 0.5,
        "postcombat-main" => 0.75,
        "ending" => 1.0,
        _ => 0.0,
    }
}

fn map_step(s: &str) -> f32 {
    match s {
        "untap" => 0.0,
        "upkeep" => 1.0/11.0,
        "draw" => 2.0/11.0,
        "main" => 3.0/11.0,
        "begin-combat" => 4.0/11.0,
        "declare-attackers" => 5.0/11.0,
        "declare-blockers" => 6.0/11.0,
        "first-strike-damage" => 7.0/11.0,
        "combat-damage" => 8.0/11.0,
        "end-combat" => 9.0/11.0,
        "end" => 10.0/11.0,
        "cleanup" => 1.0,
        _ => 0.0,
    }
}

pub fn extract_features(state: &GameState, player: u32) -> Vec<f32> {
    let mut features = vec![0.0; FEATURE_DIM_V4]; // 384
    let mut idx = 0;
    
    let p_idx = player as usize;
    let opp_idx = 1 - p_idx;
    
    let me = &state.players[p_idx];
    let opp = &state.players[opp_idx];
    
    let my_board = analyze_battlefield(&me.battlefield);
    let opp_board = analyze_battlefield(&opp.battlefield);
    let my_hand = analyze_hand(&me.hand);
    let my_gy = analyze_graveyard(&me.graveyard);
    let opp_gy = analyze_graveyard(&opp.graveyard);
    
    // === Player Resources [0-19] ===
    features[idx] = norm(me.life as f32, 0.0, 40.0); idx += 1;
    // Total mana not calcable easily without analyzing lands/mana pool structure detailed. 
    // Using simple pool sum + loose land count?
    // Using mana_pool sum
    let mp = &me.mana_pool;
    let total_mana = (mp.w + mp.u + mp.b + mp.r + mp.g + mp.c + mp.s + mp.generic) as f32;
    features[idx] = norm(total_mana, 0.0, 20.0); idx += 1;
    features[idx] = norm(me.hand.len() as f32, 0.0, 15.0); idx += 1;
    features[idx] = norm(me.library.len() as f32, 0.0, 99.0); idx += 1;
    features[idx] = norm(me.graveyard.len() as f32, 0.0, 50.0); idx += 1;
    features[idx] = norm(me.exile.len() as f32, 0.0, 30.0); idx += 1;
    features[idx] = norm(me.battlefield.len() as f32, 0.0, 30.0); idx += 1;
    features[idx] = if me.land_played_this_turn { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(me.lands_played_this_turn as f32, 0.0, 3.0); idx += 1;
    features[idx] = norm(me.poison_counters as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(me.commander_tax as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.w as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.u as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.b as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.r as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.g as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(mp.c as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.creatures, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_board.non_creatures, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_board.lands, 0.0, 15.0); idx += 1;
    
    // === Battlefield Summary [20-59] ===
    features[idx] = norm(my_board.total_power, 0.0, 50.0); idx += 1;
    features[idx] = norm(my_board.total_toughness, 0.0, 50.0); idx += 1;
    features[idx] = norm(my_board.max_power, 0.0, 15.0); idx += 1;
    let avg_cmc = if my_board.non_land_count > 0.0 { my_board.total_cmc / my_board.non_land_count } else { 0.0 };
    features[idx] = norm(avg_cmc, 0.0, 8.0); idx += 1;
    features[idx] = if my_board.has_flying { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.has_trample { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.has_lifelink { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.has_double_strike { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.has_hexproof { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.has_indestructible { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(my_board.tapped, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_board.untapped, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_board.tag_ramp, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_board.tag_engine, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_board.tag_draw, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_board.artifacts, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.enchantments, 0.0, 10.0); idx += 1;
    features[idx] = if my_board.has_planeswalker { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(my_board.total_loyalty, 0.0, 20.0); idx += 1;
    features[idx] = norm(my_board.summoning_sick, 0.0, 10.0); idx += 1;
    
    // Pad to 60
    while idx < 60 { features[idx] = 0.0; idx += 1; }
    
    // === Hand Composition [60-99] ===
    features[idx] = norm(my_hand.lands, 0.0, 7.0); idx += 1;
    features[idx] = norm(my_hand.creatures, 0.0, 7.0); idx += 1;
    features[idx] = norm(my_hand.instants, 0.0, 7.0); idx += 1;
    features[idx] = norm(my_hand.sorceries, 0.0, 7.0); idx += 1;
    let avg_hand_cmc = if my_hand.spell_count > 0.0 { my_hand.total_cmc / my_hand.spell_count } else { 0.0 };
    features[idx] = norm(avg_hand_cmc, 0.0, 8.0); idx += 1;
    features[idx] = norm(my_hand.min_cmc, 0.0, 8.0); idx += 1;
    features[idx] = norm(my_hand.max_cmc, 0.0, 10.0); idx += 1;
    
    features[idx] = norm(my_hand.tag_ramp, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_hand.tag_draw, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_hand.tag_removal, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_hand.tag_counter, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_hand.tag_wipe, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_tutor, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_combo_piece, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_engine, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_finisher, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_protection, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_token_gen, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_recursion, 0.0, 3.0); idx += 1;
    features[idx] = norm(my_hand.tag_reanimation, 0.0, 3.0); idx += 1;
    
    for i in 0..7 {
        features[idx] = norm(my_hand.cmc_curve[i], 0.0, 4.0); idx += 1;
    }
    
    while idx < 100 { features[idx] = 0.0; idx += 1; }
    
    // === Game Context [100-119] ===
    features[idx] = norm(state.turn as f32, 0.0, 30.0); idx += 1;
    features[idx] = map_phase(&state.phase); idx += 1;
    features[idx] = map_step(&state.step); idx += 1;
    features[idx] = if state.active_player == player { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if state.priority_player == player { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(state.stack.len() as f32, 0.0, 10.0); idx += 1;
    features[idx] = if state.combat.is_some() { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if state.mulligan_phase { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if state.mulligan_phase { 1.0 } else { 0.0 }; idx += 1;
    let mull_cnt = if p_idx < state.mulligan_count.len() {
        state.mulligan_count[p_idx] as f32
    } else {
        0.0
    };
    features[idx] = norm(mull_cnt, 0.0, 5.0); idx += 1;
    features[idx] = if state.game_over { 1.0 } else { 0.0 }; idx += 1;
    
    let mut my_stack = 0.0;
    let mut opp_stack = 0.0;
    for s in &state.stack {
        if s.controller == player { my_stack += 1.0; } else { opp_stack += 1.0; }
    }
    features[idx] = norm(my_stack, 0.0, 5.0); idx += 1;
    features[idx] = norm(opp_stack, 0.0, 5.0); idx += 1;
    
    features[idx] = if state.turn <= 3 { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if state.turn >= 4 && state.turn <= 8 { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if state.turn >= 9 { 1.0 } else { 0.0 }; idx += 1;
    
    while idx < 120 { features[idx] = 0.0; idx += 1; }
    
    // === Opponent Info [120-159] ===
    features[idx] = norm(opp.life as f32, 0.0, 40.0); idx += 1;
    features[idx] = norm(opp.hand.len() as f32, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp.battlefield.len() as f32, 0.0, 30.0); idx += 1;
    features[idx] = norm(opp.graveyard.len() as f32, 0.0, 50.0); idx += 1;
    features[idx] = norm(opp_board.creatures, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp_board.total_power, 0.0, 50.0); idx += 1;
    features[idx] = norm(opp_board.total_toughness, 0.0, 50.0); idx += 1;
    features[idx] = norm(opp_board.max_power, 0.0, 15.0); idx += 1;
    features[idx] = if opp_board.has_flying { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(opp_board.tapped, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp_board.untapped, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp_board.lands, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp.poison_counters as f32, 0.0, 10.0); idx += 1;
    features[idx] = norm(opp.commander_tax as f32, 0.0, 10.0); idx += 1;
    features[idx] = if !opp.command_zone.is_empty() { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(opp_board.artifacts, 0.0, 10.0); idx += 1;
    features[idx] = norm(opp_board.enchantments, 0.0, 10.0); idx += 1;
    features[idx] = if opp_board.has_planeswalker { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(opp_board.total_loyalty, 0.0, 20.0); idx += 1;
    let opp_avg_cmc = if opp_board.non_land_count > 0.0 { opp_board.total_cmc / opp_board.non_land_count } else { 0.0 };
    features[idx] = norm(opp_avg_cmc, 0.0, 8.0); idx += 1;
    
    while idx < 160 { features[idx] = 0.0; idx += 1; }
    
    // === Advantage Signals [160-179] ===
    features[idx] = norm((me.life - opp.life) as f32, -40.0, 40.0); idx += 1;
    features[idx] = norm((me.hand.len() as isize - opp.hand.len() as isize) as f32, -7.0, 7.0); idx += 1;
    features[idx] = norm(my_board.total_power - opp_board.total_power, -30.0, 30.0); idx += 1;
    features[idx] = norm((me.battlefield.len() as isize - opp.battlefield.len() as isize) as f32, -20.0, 20.0); idx += 1;
    features[idx] = norm(my_board.lands - opp_board.lands, -10.0, 10.0); idx += 1;
    
    features[idx] = if opp_board.total_power as i32 >= me.life { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if my_board.total_power as i32 >= opp.life { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if opp.life <= 10 { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if me.life <= 10 { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = if me.library.len() <= 5 { 1.0 } else { 0.0 }; idx += 1;
    
    while idx < 180 { features[idx] = 0.0; idx += 1; }
    
    // === Commander [180-199] ===
    features[idx] = if !me.command_zone.is_empty() { 1.0 } else { 0.0 }; idx += 1;
    features[idx] = norm(me.commander_tax as f32, 0.0, 10.0); idx += 1;
    // skip commander damage for now
    
    while idx < 200 { features[idx] = 0.0; idx += 1; }
    
    // === v2 Features [200-255] ===
    features[idx] = norm(my_gy.creatures, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_gy.spells, 0.0, 15.0); idx += 1;
    features[idx] = norm(my_gy.total_cmc, 0.0, 60.0); idx += 1;
    features[idx] = norm(my_gy.high_cmc_creatures, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_gy.removals, 0.0, 5.0); idx += 1;
    features[idx] = norm(opp_gy.creatures, 0.0, 15.0); idx += 1;
    features[idx] = norm(opp.graveyard.len() as f32, 0.0, 50.0); idx += 1;
    features[idx] = norm(my_gy.recursion_targets, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_gy.lands, 0.0, 10.0); idx += 1;
    features[idx] = norm(opp_gy.spells, 0.0, 15.0); idx += 1;
    
    // Combat Threat [210-219]
    features[idx] = norm(my_board.attackable_power, 0.0, 40.0); idx += 1;
    features[idx] = norm(opp_board.attackable_power, 0.0, 40.0); idx += 1;
    
    let my_ttl = if my_board.attackable_power > 0.0 { opp.life as f32 / my_board.attackable_power } else { 99.0 };
    let opp_ttl = if opp_board.attackable_power > 0.0 { me.life as f32 / opp_board.attackable_power } else { 99.0 };
    
    features[idx] = norm(my_ttl, 0.0, 20.0); idx += 1;
    features[idx] = norm(opp_ttl, 0.0, 20.0); idx += 1;
    
    features[idx] = norm(my_board.evasive_power, 0.0, 30.0); idx += 1;
    features[idx] = norm(opp_board.evasive_power, 0.0, 30.0); idx += 1;
    
    // Skip tradeRatio for brevity
    features[idx] = 0.0; idx += 1;
    
    // Open mana
    let open_mana = (my_board.untapped - my_board.attackable_count).max(0.0);
    features[idx] = norm(open_mana, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.flying_power, 0.0, 20.0); idx += 1;
    features[idx] = norm(opp_board.flying_power, 0.0, 20.0); idx += 1;
    
    while idx < 256 { features[idx] = 0.0; idx += 1; }

    // === v4 Features [320-335] Extended Keywords ===
    // Note: Jumping indices for v3 logic check... logic in TS has idx=320 after copying v3.
    // I am skipping v3 specific "Best Card" sections (card features) for now because they require `extractCardFeatures` which is another complex function.
    // I will fill with 0s for v3 [256-319] and jump to v4 [320+].
    while idx < 320 { features[idx] = 0.0; idx += 1; }
    
    features[idx] = norm(my_board.vigilance_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.haste_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.menace_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.deathtouch_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.shroud_count, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_board.ward_count, 0.0, 5.0); idx += 1;
    features[idx] = norm(my_board.first_strike_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.reach_count, 0.0, 10.0); idx += 1;
    features[idx] = norm(my_board.unblockable_count, 0.0, 5.0); idx += 1;
    
    let kw_density = if my_board.creatures > 0.0 {
        (my_board.vigilance_count + my_board.haste_count + my_board.menace_count + 
         my_board.deathtouch_count + my_board.first_strike_count + my_board.reach_count + my_board.unblockable_count) / my_board.creatures
    } else { 0.0 };
    features[idx] = norm(kw_density, 0.0, 3.0); idx += 1;
    
    let evasion_density = if my_board.creatures > 0.0 { my_board.evasive_power / (my_board.total_power.max(1.0)) } else { 0.0 };
    features[idx] = evasion_density; idx += 1;
    
    // protection count
    let prot_count = (if my_board.has_hexproof { 1.0 } else { 0.0 }) + my_board.shroud_count + my_board.ward_count;
    features[idx] = norm(prot_count, 0.0, 5.0); idx += 1;
    
    while idx < 336 { features[idx] = 0.0; idx += 1; }
    
    // === v4 Synergy [336-350] ===
    let evasion_creature_count = my_board.unblockable_count + (if my_board.has_flying { my_board.creatures } else { 0.0 });
    features[idx] = norm(evasion_creature_count, 0.0, 10.0); idx += 1;
    
    // fill rest with 0s for now to ensure we finish
    while idx < 384 { features[idx] = 0.0; idx += 1; }
    
    features
}
