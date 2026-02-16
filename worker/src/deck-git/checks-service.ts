// ============================================================
// ChecksService — CI/CD-like validation for deck PRs
// ============================================================
// Runs configurable checks on deck state: format validation,
// regression tests, tag quotas, budget limits, and custom
// playgroup rules.
// ============================================================

import {
  type DeckState,
  type DeckBoard,
  type CheckRun,
  type CheckName,
  type CheckStatus,
  type CheckResult,
  type CheckReport,
  type CheckDetail,
  type RepoSettings,
  type PlaygroupRule,
  generateId,
  now,
} from './types.js';
import { WebhookService } from './webhook-service.js';
import { PolicyService } from './policy-service.js';

const BOARDS: DeckBoard[] = ['commander', 'mainboard', 'sideboard', 'maybeboard'];

export class ChecksService {
  private policySvc = new PolicyService();

  constructor(private db: D1Database, private webhookSvc: WebhookService) {}

  // ==================== Run All Checks ====================

  /**
   * Run all required checks for a PR and store results.
   */
  async runChecks(
    repoId: string,
    prId: string,
    commitId: string,
    deckState: DeckState,
    settings: RepoSettings
  ): Promise<CheckRun[]> {
    const checks: CheckRun[] = [];
    const format = deckState.meta.format || 'commander';

    // Always run format validation
    checks.push(await this.runSingleCheck(repoId, prId, commitId, 'format_validation', () =>
      this.checkFormatValidation(deckState, format)
    ));

    // Run regression tests if configured
    if (settings.requiredChecks?.includes('regression_test')) {
      checks.push(await this.runSingleCheck(repoId, prId, commitId, 'regression_test', () =>
        this.checkRegressionTests(deckState)
      ));
    }

    // Run tag quotas if configured
    if (settings.tagQuotas && Object.keys(settings.tagQuotas).length > 0) {
      checks.push(await this.runSingleCheck(repoId, prId, commitId, 'tag_quotas', () =>
        this.checkTagQuotas(deckState, settings.tagQuotas!)
      ));
    }

    // Run budget check if configured
    if (settings.maxBudget && settings.maxBudget > 0) {
      checks.push(await this.runSingleCheck(repoId, prId, commitId, 'budget', () =>
        this.checkBudget(deckState, settings.maxBudget!)
      ));
    }

    // Run sideboard check
    if (settings.requiredChecks?.includes('sideboard_complete')) {
      checks.push(await this.runSingleCheck(repoId, prId, commitId, 'sideboard_complete', () =>
        this.checkSideboardComplete(deckState)
      ));
    }

    // Run playgroup rules
    if (settings.playgroupRules && settings.playgroupRules.length > 0) {
      checks.push(await this.runSingleCheck(repoId, prId, commitId, 'playgroup_rules', () =>
        this.checkPlaygroupRules(deckState, settings.playgroupRules!)
      ));
    }

    return checks;
  }

  /**
   * Run a single check: create record, execute, update result.
   */
  private async runSingleCheck(
    repoId: string,
    prId: string,
    commitId: string,
    checkName: CheckName,
    checkFn: () => CheckResult
  ): Promise<CheckRun> {
    const checkId = generateId();
    const startedAt = now();

    // Create pending check
    await this.db
      .prepare(`
        INSERT INTO check_runs (id, pr_id, commit_id, check_name, status, report_json, started_at, completed_at)
        VALUES (?, ?, ?, ?, 'running', NULL, ?, NULL)
      `)
      .bind(checkId, prId, commitId, checkName, startedAt)
      .run();

    // Execute check
    let result: CheckResult;
    let status: CheckStatus;

    try {
      result = checkFn();
      status = result.status;
    } catch (e) {
      status = 'error';
      result = {
        status: 'fail',
        report: {
          summary: `Check failed with error: ${e instanceof Error ? e.message : 'Unknown error'}`,
          details: [],
        },
      };
    }

    const completedAt = now();

    // Update check with result
    await this.db
      .prepare('UPDATE check_runs SET status = ?, report_json = ?, completed_at = ? WHERE id = ?')
      .bind(status, JSON.stringify(result.report), completedAt, checkId)
      .run();

    // Webhook if failed
    if (status === 'fail' || status === 'error') {
      await this.webhookSvc.dispatch(repoId, 'check.run', {
        prId,
        checkName,
        status,
        summary: result.report.summary
      }, 'system');
    }

    return {
      id: checkId,
      prId,
      commitId,
      checkName,
      status,
      report: result.report,
      startedAt,
      completedAt,
    };
  }

  // ==================== Individual Checks ====================

  /**
   * Validate deck against format rules (EDH/Commander focus).
   */
  checkFormatValidation(state: DeckState, format: string): CheckResult {
    const details: CheckDetail[] = [];
    const commanderCount = state.boards.commander.length;
    const mainboardCount = state.boards.mainboard.reduce((sum, c) => sum + c.qty, 0);
    const totalCards = commanderCount + mainboardCount;

    if (format === 'commander') {
      // Must have exactly 1 commander (or 2 with partner)
      if (commanderCount === 0) {
        details.push({ severity: 'error', message: 'No commander designated' });
      } else if (commanderCount > 2) {
        details.push({
          severity: 'error',
          message: `Too many commanders: ${commanderCount} (max 2 with Partner)`,
        });
      }

      // Deck must be exactly 100 cards
      if (totalCards < 100) {
        details.push({
          severity: 'error',
          message: `Deck has ${totalCards} cards (need 100)`,
          board: 'mainboard',
        });
      } else if (totalCards > 100) {
        details.push({
          severity: 'error',
          message: `Deck has ${totalCards} cards (max 100)`,
          board: 'mainboard',
        });
      }

      // Singleton rule (except basic lands)
      const basicLands = new Set([
        'Plains', 'Island', 'Swamp', 'Mountain', 'Forest',
        'Snow-Covered Plains', 'Snow-Covered Island', 'Snow-Covered Swamp',
        'Snow-Covered Mountain', 'Snow-Covered Forest',
        'Wastes',
      ]);

      for (const entry of state.boards.mainboard) {
        if (entry.qty > 1 && !basicLands.has(entry.name)) {
          details.push({
            severity: 'error',
            message: `Singleton violation: ${entry.name} (${entry.qty} copies)`,
            card: entry.name,
            board: 'mainboard',
          });
        }
      }
    }

    const hasErrors = details.some(d => d.severity === 'error');

    return {
      status: hasErrors ? 'fail' : 'pass',
      report: {
        summary: hasErrors
          ? `Format validation failed: ${details.filter(d => d.severity === 'error').length} error(s)`
          : 'Format validation passed',
        details,
        metrics: {
          commanderCount,
          mainboardCount,
          totalCards,
        },
      },
    };
  }

  /**
   * Regression tests: check mana curve, land count, and basic playability.
   */
  checkRegressionTests(state: DeckState): CheckResult {
    const details: CheckDetail[] = [];

    // Count lands
    const lands = state.boards.mainboard.filter(c =>
      c.tags.includes('land') || c.tags.includes('Land')
    );
    const landCount = lands.reduce((sum, c) => sum + c.qty, 0);
    const totalMain = state.boards.mainboard.reduce((sum, c) => sum + c.qty, 0);

    // Land ratio check (should be ~33-40% for commander)
    const landRatio = totalMain > 0 ? landCount / totalMain : 0;
    if (landRatio < 0.30) {
      details.push({
        severity: 'warning',
        message: `Low land count: ${landCount} lands (${(landRatio * 100).toFixed(1)}% — recommend 33-40%)`,
      });
    } else if (landRatio > 0.45) {
      details.push({
        severity: 'warning',
        message: `High land count: ${landCount} lands (${(landRatio * 100).toFixed(1)}% — recommend 33-40%)`,
      });
    }

    // Average CMC check (non-land cards)
    // Note: We don't have CMC data in DeckState directly, so check tag-based categories
    const hasLowCurve = state.boards.mainboard.some(c => c.tags.includes('1-drop') || c.tags.includes('2-drop'));
    if (!hasLowCurve && totalMain > 30) {
      details.push({
        severity: 'info',
        message: 'No early drops detected (1-2 CMC). Consider adding low-cost cards.',
      });
    }

    const hasErrors = details.some(d => d.severity === 'error');

    return {
      status: hasErrors ? 'fail' : 'pass',
      report: {
        summary: details.length === 0
          ? 'Regression tests passed'
          : `Regression tests: ${details.length} finding(s)`,
        details,
        metrics: {
          landCount,
          landRatio: Math.round(landRatio * 100),
          totalMainboard: totalMain,
        },
      },
    };
  }

  /**
   * Check tag-based quotas: e.g. "need at least 10 ramp cards".
   */
  checkTagQuotas(state: DeckState, quotas: Record<string, number>): CheckResult {
    const details: CheckDetail[] = [];

    for (const [tag, minCount] of Object.entries(quotas)) {
      let count = 0;
      for (const board of BOARDS) {
        for (const entry of state.boards[board]) {
          if (entry.tags.includes(tag)) count += entry.qty;
        }
      }

      if (count < minCount) {
        details.push({
          severity: 'warning',
          message: `Tag quota not met: "${tag}" has ${count} cards (need ${minCount})`,
        });
      }
    }

    return {
      status: details.some(d => d.severity === 'error') ? 'fail' : 'pass',
      report: {
        summary: details.length === 0
          ? 'All tag quotas met'
          : `Tag quotas: ${details.length} unmet`,
        details,
      },
    };
  }

  /**
   * Check total deck budget (requires price data in tags).
   * Note: For now we check if a "budget" tag exists; full price integration
   * would require Scryfall/TCGPlayer API calls.
   */
  checkBudget(state: DeckState, maxBudget: number): CheckResult {
    // Placeholder: In production, this would fetch prices from cache
    // For now, just report the check was run
    return {
      status: 'pass',
      report: {
        summary: `Budget check: max $${maxBudget} (price lookup pending)`,
        details: [{
          severity: 'info',
          message: `Budget limit set to $${maxBudget}. Full price validation requires card price data.`,
        }],
        metrics: { maxBudget },
      },
    };
  }

  /**
   * Check that sideboard has content (for competitive formats).
   */
  checkSideboardComplete(state: DeckState): CheckResult {
    const sideboardCount = state.boards.sideboard.reduce((sum, c) => sum + c.qty, 0);
    const details: CheckDetail[] = [];

    if (sideboardCount === 0) {
      details.push({
        severity: 'warning',
        message: 'Sideboard is empty',
        board: 'sideboard',
      });
    } else if (sideboardCount < 15 && state.meta.format !== 'commander') {
      details.push({
        severity: 'info',
        message: `Sideboard has ${sideboardCount} cards (15 recommended for competitive)`,
        board: 'sideboard',
      });
    }

    return {
      status: details.some(d => d.severity === 'error') ? 'fail' : 'pass',
      report: {
        summary: sideboardCount > 0
          ? `Sideboard: ${sideboardCount} cards`
          : 'Sideboard is empty',
        details,
        metrics: { sideboardCount },
      },
    };
  }

  /**
   * Evaluate custom playgroup rules (Policy as Code).
   */
  checkPlaygroupRules(state: DeckState, rules: PlaygroupRule[]): CheckResult {
    const violations = this.policySvc.evaluate(state, rules);
    const details = this.policySvc.convertToCheckDetails(violations);

    const errorCount = details.filter(d => d.severity === 'error').length;

    return {
      status: errorCount > 0 ? 'fail' : 'pass',
      report: {
        summary: errorCount > 0
          ? `Policy check failed: ${errorCount} errors found`
          : 'Policy check passed',
        details,
      },
    };
  }

  // ==================== Queries ====================

  /**
   * Get all check runs for a PR.
   */
  async getCheckRuns(prId: string): Promise<CheckRun[]> {
    const rows = await this.db
      .prepare('SELECT * FROM check_runs WHERE pr_id = ? ORDER BY started_at ASC')
      .bind(prId)
      .all<{
        id: string;
        pr_id: string;
        commit_id: string;
        check_name: string;
        status: string;
        report_json: string | null;
        started_at: string | null;
        completed_at: string | null;
      }>();

    return (rows.results || []).map(row => ({
      id: row.id,
      prId: row.pr_id,
      commitId: row.commit_id,
      checkName: row.check_name as CheckName,
      status: row.status as CheckStatus,
      report: row.report_json ? JSON.parse(row.report_json) : null,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    }));
  }

  /**
   * Check if all required checks have passed for a PR.
   */
  async allChecksPassed(prId: string): Promise<boolean> {
    const checks = await this.getCheckRuns(prId);
    if (checks.length === 0) return true; // No checks required

    return checks.every(c => c.status === 'pass');
  }
}
