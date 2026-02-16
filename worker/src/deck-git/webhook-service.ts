// ============================================================
// WebhookService — Dispatch events to external integrations
// ============================================================
// Sends notifications to Discord, Slack, and generic webhooks
// based on repository events.
// ============================================================

import { type Webhook, type ActivityActionType, now, generateId } from './types.js';

export interface WebhookPayload {
  event: ActivityActionType;
  repoId: string;
  repoName?: string;
  actorName: string;
  timestamp: string;
  details: Record<string, any>;
  url?: string; // Link to the resource on DeckLens
}

export class WebhookService {
  constructor(private db: D1Database) {}

  /**
   * Register a new webhook for a repository.
   */
  async createWebhook(repoId: string, url: string, events: string[], secret?: string): Promise<Webhook> {
    const id = generateId();
    const createdAt = now();
    
    await this.db.prepare(`
      INSERT INTO deck_webhooks (id, repo_id, url, events_json, secret, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, ?)
    `).bind(id, repoId, url, JSON.stringify(events), secret ?? null, createdAt).run();

    return {
      id,
      repoId,
      url,
      events,
      secret: secret ?? null,
      active: true,
      createdAt
    };
  }

  /**
   * Delete a webhook.
   */
  async deleteWebhook(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM deck_webhooks WHERE id = ?').bind(id).run();
  }

  /**
   * List all webhooks for a repository.
   */
  async listWebhooks(repoId: string): Promise<Webhook[]> {
    const { results } = await this.db.prepare('SELECT * FROM deck_webhooks WHERE repo_id = ?')
      .bind(repoId)
      .all<any>();

    return (results || []).map(row => ({
      id: row.id,
      repoId: row.repo_id,
      url: row.url,
      events: JSON.parse(row.events_json || '[]'),
      secret: row.secret,
      active: !!row.active,
      createdAt: row.created_at
    }));
  }

  /**
   * Dispatch an event to all active webhooks for a repo.
   */
  async dispatch(repoId: string, event: ActivityActionType, details: Record<string, any>, actorName: string): Promise<void> {
    const webhooks = await this.listWebhooks(repoId);
    const activeHooks = webhooks.filter(w => w.active && (w.events.includes(event) || w.events.includes('*')));

    if (activeHooks.length === 0) return;

    // Get repo name for payload
    const repo = await this.db.prepare('SELECT name FROM deck_repos WHERE id = ?').bind(repoId).first<{ name: string }>();
    
    const payload: WebhookPayload = {
      event,
      repoId,
      repoName: repo?.name,
      actorName,
      timestamp: now(),
      details,
      url: `https://decklens.app/deckhub?repo=${repoId}`
    };

    const promises = activeHooks.map(async (webhook) => {
      try {
        if (webhook.url.includes('discord.com/api/webhooks')) {
          await this.sendToDiscord(webhook.url, payload);
        } else if (webhook.url.includes('hooks.slack.com/services')) {
          await this.sendToSlack(webhook.url, payload);
        } else {
          await this.sendGeneric(webhook.url, payload, webhook.secret);
        }

        // Audit the trigger
        await this.db.prepare(`
          INSERT INTO deck_audit_log (id, repo_id, actor_id, actor_name, action, details_json, created_at)
          VALUES (?, ?, 'system', 'WebhookService', 'webhook.trigger', ?, ?)
        `).bind(generateId(), repoId, JSON.stringify({ webhookId: webhook.id, event, success: true }), now()).run();

      } catch (err) {
        console.error(`[WebhookService] Failed to dispatch to ${webhook.id}:`, err);
        
        await this.db.prepare(`
          INSERT INTO deck_audit_log (id, repo_id, actor_id, actor_name, action, details_json, created_at)
          VALUES (?, ?, 'system', 'WebhookService', 'webhook.trigger', ?, ?)
        `).bind(generateId(), repoId, JSON.stringify({ webhookId: webhook.id, event, success: false, error: (err as Error).message }), now()).run();
      }
    });

    // Fire and forget (don't block the main request)
    // In a Worker, we should use ctx.waitUntil if available, but here we just return
    // The caller might want to wait for it though if they are not in a fetch handler.
    await Promise.all(promises);
  }

  private async sendToDiscord(url: string, payload: WebhookPayload): Promise<void> {
    const embed = {
      title: `${payload.actorName} triggered \`${payload.event}\``,
      description: this.formatDescription(payload),
      color: this.getEventColor(payload.event),
      url: payload.url,
      footer: { text: `DeckLens — ${payload.repoName || payload.repoId}` },
      timestamp: payload.timestamp
    };

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'DeckLens Hub',
        avatar_url: 'https://decklens.app/og-image.png',
        embeds: [embed]
      })
    });
  }

  private async sendToSlack(url: string, payload: WebhookPayload): Promise<void> {
    const block = {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${payload.actorName}* triggered \`${payload.event}\` in *${payload.repoName || payload.repoId}*\n${this.formatDescription(payload)}\n<${payload.url}|View on DeckLens>`
      }
    };

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        blocks: [block]
      })
    });
  }

  private async sendGeneric(url: string, payload: WebhookPayload, secret: string | null): Promise<void> {
    const body = JSON.stringify(payload);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    
    if (secret) {
      // Simple HMAC-like header (pseudo-code, real HMAC needs crypto API)
      headers['X-DeckLens-Signature'] = secret; 
    }

    await fetch(url, {
      method: 'POST',
      headers,
      body
    });
  }

  private formatDescription(payload: WebhookPayload): string {
    const d = payload.details;
    switch (payload.event) {
      case 'pr.open': return `Opened PR #${d.prNumber}: **${d.title}**`;
      case 'pr.merge': return `Merged PR #${d.prNumber}`;
      case 'issue.create': return `Created Issue #${d.number}: **${d.title}**`;
      case 'release.create': return `Published Release **${d.tagName}**: ${d.title}`;
      case 'check.run': return `Check **${d.checkName}** completed with status: \`${d.status}\``;
      default: return JSON.stringify(payload.details);
    }
  }

  private getEventColor(event: string): number {
    if (event.includes('open') || event.includes('create')) return 0x3dd68c; // Green
    if (event.includes('merge') || event.includes('verify')) return 0xc9a84c; // Gold
    if (event.includes('fail') || event.includes('error')) return 0xef5350; // Red
    return 0x5ea3f8; // Blue
  }
}
