/**
 * Shared Primer Templates — used by both deck editor and collab chat.
 */

export interface PrimerTemplate {
  key: string;
  label: string;
  icon: string;
  content: string;
}

export const PRIMER_TEMPLATES: PrimerTemplate[] = [
  { key: 'strategy', label: 'Strategy', icon: '◆', content: '# Strategy\n\nThis deck aims to...\n\n' },
  { key: 'wincons', label: 'Win Conds', icon: '▲', content: '# Win Conditions\n\n- **Primary**: [[Card Name]] + [[Card Name]]\n- **Secondary**: Combat damage with...\n- **Backup**: ...\n\n' },
 { key: 'matchups', label: 'Matchups', icon: '◆', content: '# Matchup Notes\n\n## Favorable\n- Against aggro: ...\n\n## Unfavorable\n- Against control: ...\n\n## Tips\n- Mulligan for...\n\n' },
  { key: 'budget', label: 'Budget', icon: '◆', content: '# Budget Notes\n\n**Total Price**: ~€___\n\n## Key Upgrades\n- Replace [[Card Name]] with [[Card Name]] for better...\n\n## Budget Alternatives\n- [[Card Name]] can be swapped for...\n\n' },
  { key: 'full', label: 'Full Primer', icon: '▤', content: '# Deck Primer\n\n## Strategy\nThis deck aims to...\n\n## Key Cards\n- [[Card Name]] — Core combo piece\n- [[Card Name]] — Value engine\n\n## Win Conditions\n- **Primary**: ...\n- **Secondary**: ...\n\n## Mana Base\n- Run X lands with...\n\n## Matchup Notes\n- Against aggro: ...\n- Against control: ...\n\n## Changelog\n- v1.0: Initial build\n\n' },
];

/** Get template content by key */
export function getTemplateByKey(key: string): string | undefined {
  return PRIMER_TEMPLATES.find((t) => t.key === key)?.content;
}
