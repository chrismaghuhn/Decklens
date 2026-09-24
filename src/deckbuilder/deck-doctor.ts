import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { analyzeManaBase } from './mana-calc.js';
import { parseDeckDSL } from './deck-dsl-parser.js';
import { lintDeck } from './deck-linter.js';
import { svgMarkup } from './line-icons.js';

export interface DoctorDiagnosis {
  id: string;
  title: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  fixAction?: {
    label: string;
    searchQuery: string;
  };
}

export interface DoctorPersona {
  name: string;
  intro: string;
  noIssues: string;
  tone: 'stern' | 'helpful' | 'chaotic';
}

const PERSONA_PROFESSOR: DoctorPersona = {
  name: 'Professor Flunk',
  intro: 'Ahem. Let me see what... "creative" choices you\'ve made today.',
  noIssues: 'Well, I can\'t find anything to complain about. Don\'t let it go to your head.',
  tone: 'stern'
};

function normalizeKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function diagnoseDeck(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>
): DoctorDiagnosis[] {
  const diagnoses: DoctorDiagnosis[] = [];
  
  const entries = [...deck.boards.mainboard, ...deck.boards.commander];
  const totalCards = entries.reduce((sum, e) => sum + e.qty, 0);
  
  // 0. Calculate Color Identity for Safer Search
  const analysis = analyzeManaBase(deck, cardByName);
  const landCount = analysis.totalLands;
  const colorId = analysis.colors.map(c => c.color).join('').toLowerCase() || 'c';
  const idQuery = `id:${colorId}`;

  if (totalCards > 90) { // Commander context
    if (landCount < 33) {
      diagnoses.push({
        id: 'greedy-manabase',
        title: 'Greedy Manabase',
        message: `Only ${landCount} lands? Do you enjoy watching your opponents play while you miss land drops? I recommend at least 36-37.`,
        severity: 'critical',
        fixAction: { label: 'Find Lands', searchQuery: `t:land ${idQuery}` }
      });
    } else if (landCount < 36) {
       diagnoses.push({
        id: 'lean-manabase',
        title: 'Living on the Edge',
        message: `${landCount} lands is a bit risky. Unless your curve is extremely low, consider adding a couple more.`,
        severity: 'warning',
        fixAction: { label: 'Find Lands', searchQuery: `t:land ${idQuery}` }
      });
    }
  }

  // 2. Interaction Check
  let interactionCount = 0;
  let rampCount = 0;
  let drawCount = 0;

  for (const entry of entries) {
    const card = cardByName[normalizeKey(entry.name)];
    if (!card) continue;
    const text = (card.oracle_text || '').toLowerCase();
    const type = (card.type_line || '').toLowerCase();

    if (text.includes('destroy target') || text.includes('exile target') || text.includes('counter target')) {
      interactionCount += entry.qty;
    }
    
    if ((text.includes('add {') || text.includes('search your library for a land')) && !type.includes('land')) {
      rampCount += entry.qty;
    }

    if (text.includes('draw') && text.includes('card')) {
       drawCount += entry.qty;
    }
  }

  if (totalCards > 60) {
      if (interactionCount < 5) {
        diagnoses.push({
            id: 'interaction-deficit',
            title: 'Pacifist Run?',
            message: `You have only ~${interactionCount} interaction spells. You're going to lose to the first combo player you sit down with. Pack some removal!`,
            severity: 'critical',
            fixAction: { label: 'Find Removal', searchQuery: `o:/destroy|exile/ -t:land ${idQuery}` }
        });
      }

      if (rampCount < 8 && totalCards > 90) {
         diagnoses.push({
            id: 'ramp-anemia',
            title: 'Ramp Anemia',
            message: `Speed kills. You only have ~${rampCount} ramp sources. In Commander, if you aren't accelerating, you're falling behind.`,
            severity: 'warning',
            fixAction: { label: 'Find Ramp', searchQuery: `o:/add.*\\{|search.*land/ -t:land ${idQuery}` }
        });
      }
      
      if (drawCount < 8 && totalCards > 90) {
           diagnoses.push({
            id: 'gas-leak',
            title: 'Running on Fumes',
            message: `Only ~${drawCount} card draw sources. You'll be top-decking by turn 5. Add more draw to keep the engine running.`,
            severity: 'warning',
            fixAction: { label: 'Find Draw', searchQuery: `o:/draw.*cards?/ ${idQuery}` }
        });
      }
  }

  // DSL Requirements Check
  if (deck.notes && deck.notes.trim().length > 0) {
    const requirements = parseDeckDSL(deck.notes);
    if (requirements.length > 0) {
      const violations = lintDeck(deck, requirements, cardByName);
      
      for (const violation of violations) {
        const severity = violation.severity === 'error' ? 'critical' : violation.severity;
        diagnoses.push({
          id: `dsl-${violation.requirement.lineNumber}`,
          title: `DSL: ${violation.requirement.raw.replace(/^\/\/\s*/, '')}`,
          message: `${violation.message}${violation.current ? ` (${violation.current})` : ''}`,
          severity: severity as 'critical' | 'warning' | 'info',
          fixAction: violation.fix ? {
            label: violation.fix,
            searchQuery: '' // DSL violations don't have automatic search queries
          } : undefined
        });
      }
    }
  }

  return diagnoses;
}

export function renderDoctorModal(
  diagnoses: DoctorDiagnosis[],
  onFix: (query: string) => void,
  onClose: () => void
): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'doctor-overlay';
  overlay.onclick = (e) => {
    if (e.target === overlay) onClose();
  };

  const modal = document.createElement('div');
  modal.className = 'doctor-modal';
  
  // Header
  const header = document.createElement('div');
  header.className = 'doctor-header';
  
  const avatar = document.createElement('div');
  avatar.className = 'doctor-avatar';
  avatar.innerHTML = svgMarkup('doctor');
  
  const titleBlock = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'doctor-name';
  name.textContent = PERSONA_PROFESSOR.name;
  const intro = document.createElement('div');
  intro.className = 'doctor-intro';
  intro.textContent = diagnoses.length > 0 ? PERSONA_PROFESSOR.intro : PERSONA_PROFESSOR.noIssues;
  
  titleBlock.append(name, intro);
  header.append(avatar, titleBlock);
  
  // Content
  const content = document.createElement('div');
  content.className = 'doctor-content';

  if (diagnoses.length === 0) {
      const emptyState = document.createElement('div');
      emptyState.className = 'doctor-clean-bill';
      emptyState.textContent = 'Use the Deck Doctor to verify your deck\'s health!';
      content.appendChild(emptyState);
  } else {
    for (const d of diagnoses) {
        const item = document.createElement('div');
        item.className = `doctor-item severity-${d.severity}`;
        
        const icon = document.createElement('span');
        icon.className = 'doctor-item-icon';
        icon.innerHTML = svgMarkup('warning');
        
        const details = document.createElement('div');
        details.className = 'doctor-item-details';
        
        const h4 = document.createElement('h4');
        h4.textContent = d.title;
        
        const p = document.createElement('p');
        p.textContent = d.message;
        
        details.append(h4, p);
        
        item.append(icon, details);

        if (d.fixAction) {
            const btn = document.createElement('button');
            btn.className = 'doctor-fix-btn';
            btn.textContent = d.fixAction.label;
            btn.onclick = () => {
                onFix(d.fixAction!.searchQuery);
                onClose();
            };
            item.appendChild(btn);
        }
        
        content.appendChild(item);
    }
  }

  modal.append(header, content);
  overlay.appendChild(modal);

  return overlay;
}
