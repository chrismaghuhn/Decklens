// ============================================================
// SlashCommandService — Parse & execute /commands in comments
// ============================================================
// Detects slash commands in PR/Issue comment bodies and
// executes the corresponding action automatically.
// ============================================================

export interface SlashCommand {
  command: string;
  args: string[];
  raw: string;
}

const SUPPORTED_COMMANDS = [
  '/recheck', '/label', '/unlabel', '/assign', '/unassign',
  '/close', '/reopen', '/approve', '/merge', '/help',
];

/**
 * Parse slash commands from a comment body.
 * Only the first line starting with / is treated as a command.
 */
export function parseSlashCommand(body: string): SlashCommand | null {
  const trimmed = body.trim();
  if (!trimmed.startsWith('/')) return null;

  const firstLine = trimmed.split('\n')[0].trim();
  const parts = firstLine.split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  if (!SUPPORTED_COMMANDS.includes(command)) return null;

  return { command, args, raw: firstLine };
}

/**
 * Format a result message for a slash command execution.
 */
export function formatCommandResult(command: string, success: boolean, message: string): string {
  return success
    ? `\u2705 \`${command}\` — ${message}`
    : `\u274C \`${command}\` — ${message}`;
}
