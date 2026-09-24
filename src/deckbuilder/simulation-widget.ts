/**
 * Simulation Dashboard Widget — Monte Carlo statistics visualizer
 * 
 * Displays simulation results and controls for running deck analysis.
 */

import type { DeckbuilderDeck } from './types.js';
import type { DeckbuilderSearchCard } from '../shared/api.js';
import { runSimulation, type SimulationConfig, type SimulationResult } from './simulation-runner.js';
import { svgMarkup } from './line-icons.js';

/**
 * Render the simulation widget
 */
export function renderSimulationWidget(
  container: HTMLElement,
  deck: DeckbuilderDeck | null,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>
): void {
  container.textContent = '';

  if (!deck || deck.boards.mainboard.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'sim-widget-empty';
    empty.innerHTML = `
      <p style="text-align:center;padding:2rem 1rem;color:var(--text-dim);">
        ${svgMarkup('simulation')}<br>
        <span style="font-size:0.82rem;">Add cards to run simulations.</span>
      </p>
    `;
    container.appendChild(empty);
    return;
  }

  // Header
  const header = document.createElement('div');
  header.className = 'sim-header';
  header.innerHTML = `
    <span class="sim-icon">${svgMarkup('simulation')}</span>
    <span class="sim-title">Digital Twin Simulation</span>
  `;
  container.appendChild(header);

  // Controls
  const controls = document.createElement('div');
  controls.className = 'sim-controls';

  const iterSelect = document.createElement('select');
  iterSelect.className = 'sim-iter-select';
  iterSelect.innerHTML = `
    <option value="100">100 iterations</option>
    <option value="1000" selected>1,000 iterations</option>
    <option value="10000">10,000 iterations</option>
  `;

  const runBtn = document.createElement('button');
  runBtn.className = 'sim-run-btn';
  runBtn.textContent = 'Run Simulation';
  runBtn.onclick = () => runSimulationAndDisplay(deck, cardByName, parseInt(iterSelect.value, 10), resultsContainer);

  controls.appendChild(iterSelect);
  controls.appendChild(runBtn);
  container.appendChild(controls);

  // Results container
  const resultsContainer = document.createElement('div');
  resultsContainer.className = 'sim-results';
  resultsContainer.innerHTML = `
    <div class="sim-placeholder">
      <span class="sim-placeholder-icon">${svgMarkup("summary-bar")}</span>
      <p>Click "Run Simulation" to generate stats</p>
    </div>
  `;
  container.appendChild(resultsContainer);
}

/**
 * Run simulation and display results
 */
function runSimulationAndDisplay(
  deck: DeckbuilderDeck,
  cardByName: Record<string, DeckbuilderSearchCard | undefined>,
  iterations: number,
  container: HTMLElement
): void {
  container.textContent = '';

  // Show loading
  const loading = document.createElement('div');
  loading.className = 'sim-loading';
  loading.innerHTML = `
    <div class="sim-spinner"></div>
    <p>Running ${iterations.toLocaleString()} simulations...</p>
  `;
  container.appendChild(loading);

  // Run in next tick to allow UI update
  setTimeout(() => {
    const config: SimulationConfig = {
      iterations,
      maxTurns: 15,
      strategy: 'aggressive',
    };

    const startTime = performance.now();
    const result = runSimulation(deck, cardByName, config);
    const duration = performance.now() - startTime;

    displayResults(result, duration, container);
  }, 50);
}

/**
 * Display simulation results
 */
function displayResults(
  result: SimulationResult,
  duration: number,
  container: HTMLElement
): void {
  container.textContent = '';

  // Summary stats
  const summary = document.createElement('div');
  summary.className = 'sim-summary';
  summary.innerHTML = `
    <div class="sim-stat">
      <div class="sim-stat-label">Avg Goldfish</div>
      <div class="sim-stat-value">${result.avgGoldfishTurn.toFixed(1)} turns</div>
    </div>
    <div class="sim-stat">
      <div class="sim-stat-label">Win Condition</div>
      <div class="sim-stat-value">${result.winConditionReached.toFixed(0)}%</div>
    </div>
    <div class="sim-stat">
      <div class="sim-stat-label">Mulligan Rate</div>
      <div class="sim-stat-value">${result.mulliganRate.toFixed(0)}%</div>
    </div>
  `;
  container.appendChild(summary);

  // Manabase health
  const manabaseHealth = document.createElement('div');
  manabaseHealth.className = 'sim-manabase';
  manabaseHealth.innerHTML = `
    <div class="sim-section-title">Manabase Health</div>
    <div class="sim-health-row">
      <span class="sim-health-label">Mana Screwed:</span>
      <span class="sim-health-value ${result.manaScrewed > 20 ? 'sim-health-bad' : 'sim-health-ok'}">
        ${result.manaScrewed.toFixed(1)}%
      </span>
    </div>
    <div class="sim-health-row">
      <span class="sim-health-label">Mana Flooded:</span>
      <span class="sim-health-value ${result.manaFlooded > 15 ? 'sim-health-bad' : 'sim-health-ok'}">
        ${result.manaFlooded.toFixed(1)}%
      </span>
    </div>
  `;
  container.appendChild(manabaseHealth);

  // Distribution chart (simple bar chart)
  const distribution = document.createElement('div');
  distribution.className = 'sim-distribution';
  distribution.innerHTML = '<div class="sim-section-title">Turn Distribution</div>';
  
  const maxCount = Math.max(...Object.values(result.goldfishTurnDistribution));
  const sortedTurns = Object.keys(result.goldfishTurnDistribution)
    .map(Number)
    .sort((a, b) => a - b)
    .slice(0, 10); // Show first 10 turns

  for (const turn of sortedTurns) {
    const count = result.goldfishTurnDistribution[turn];
    const percentage = (count / result.iterations) * 100;
    const barWidth = (count / maxCount) * 100;

    const bar = document.createElement('div');
    bar.className = 'sim-distribution-bar';
    bar.innerHTML = `
      <span class="sim-turn-label">T${turn}</span>
      <div class="sim-bar-fill" style="width: ${barWidth}%"></div>
      <span class="sim-percentage">${percentage.toFixed(1)}%</span>
    `;
    distribution.appendChild(bar);
  }
  container.appendChild(distribution);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'sim-footer';
  footer.textContent = `${result.iterations.toLocaleString()} iterations • ${duration.toFixed(0)}ms`;
  container.appendChild(footer);
}
