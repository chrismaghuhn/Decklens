/**
 * CollabChat — Chat panel for collaborative deck editing sessions.
 *
 * Slide-in panel on the right side with message history,
 * @mention highlighting, markdown rendering, [[Card Name]] hover previews,
 * primer template quick-insert, and Scryfall card autocomplete.
 */

import { h } from '../shared/dom.js';
import { getCollabManager, type CollabEvent } from './collab-manager.js';
import type { ChatMessage, CollabParticipant } from './types.js';
import { renderMarkdown } from './markdown-lite.js';
import { showHoverPreviewByName, hideHoverPreview } from './card-preview.js';
import { PRIMER_TEMPLATES } from './primer-templates.js';
import { attachCardAutocomplete, type CardAutocompleteController } from './card-autocomplete.js';

// ───── State ─────

let chatPanel: HTMLElement | null = null;
let chatMessagesContainer: HTMLElement | null = null;
let chatInput: HTMLTextAreaElement | null = null;
let isOpen = false;
let unreadCount = 0;
let badgeEl: HTMLElement | null = null;
const messages: ChatMessage[] = [];
const MAX_MESSAGES = 200;
let templatesBarVisible = false;
let autocompleteCtrl: CardAutocompleteController | null = null;

// ───── Initialization ─────

/** Call once after DOM is ready. Wires up CollabManager events. */
export function initCollabChat(): void {
  const mgr = getCollabManager();
  mgr.on('remote-chat-message', onRemoteChatMessage);
  mgr.on('disconnected', onDisconnected);
}

// ───── Panel Toggle ─────

/** Toggle chat panel open/closed */
export function toggleChatPanel(): void {
  if (isOpen) {
    closeChatPanel();
  } else {
    openChatPanel();
  }
}

/** Open the chat panel */
export function openChatPanel(): void {
  if (!chatPanel) createChatPanel();
  chatPanel!.classList.add('collab-chat-open');
  isOpen = true;

  // Clear unread
  unreadCount = 0;
  updateBadge();

  // Focus input
  setTimeout(() => chatInput?.focus(), 100);

  // Scroll to bottom
  scrollToBottom();
}

/** Close the chat panel */
export function closeChatPanel(): void {
  chatPanel?.classList.remove('collab-chat-open');
  isOpen = false;
}

/** Check if chat panel is open */
export function isChatOpen(): boolean {
  return isOpen;
}

// ───── Badge ─────

/** Set the badge element reference (called from collab-ui toolbar) */
export function setChatBadgeElement(el: HTMLElement): void {
  badgeEl = el;
  updateBadge();
}

function updateBadge(): void {
  if (!badgeEl) return;
  if (unreadCount > 0 && !isOpen) {
    badgeEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    badgeEl.classList.add('collab-chat-badge-visible');
  } else {
    badgeEl.textContent = '';
    badgeEl.classList.remove('collab-chat-badge-visible');
  }
}

// ───── Panel Creation ─────

function createChatPanel(): void {
  const header = h('div', { className: 'collab-chat-header' },
 h('span', {}, '❝ Chat'),
    h('button', {
      className: 'collab-chat-close-btn',
      onClick: () => closeChatPanel(),
      title: 'Close chat',
 }, '✕'),
  );

  chatMessagesContainer = h('div', { className: 'collab-chat-messages' });

  chatInput = document.createElement('textarea');
  chatInput.className = 'collab-chat-input';
  chatInput.placeholder = 'Type a message... (supports **markdown** and [[Card Name]])';
  chatInput.maxLength = 2000;
  chatInput.rows = 1;
  chatInput.addEventListener('keydown', onInputKeyDown);

  // Auto-resize textarea
  chatInput.addEventListener('input', () => {
    if (!chatInput) return;
    chatInput.style.height = 'auto';
    chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
  });

  // Attach card autocomplete with multi-line support
  autocompleteCtrl = attachCardAutocomplete({ input: chatInput, multiLine: true });

  const sendBtn = h('button', {
    className: 'collab-btn collab-chat-send-btn',
    onClick: () => sendMessage(),
    title: 'Send message',
 }, '➤');

  const templateToggle = h('button', {
    className: 'collab-chat-templates-toggle',
    onClick: () => toggleTemplatesBar(),
    title: 'Insert primer template',
 }, '▤');

  // Templates bar (hidden by default)
  const templatesBar = h('div', { className: 'collab-chat-templates-bar', id: '_chatTemplatesBar', style: 'display:none;' },
    ...PRIMER_TEMPLATES.map((tpl) =>
      h('button', {
        className: 'collab-chat-tpl-btn',
        onClick: () => insertTemplate(tpl.content),
        title: tpl.label,
      }, `${tpl.icon} ${tpl.label}`),
    ),
  );

  const inputRow = h('div', { className: 'collab-chat-input-row' },
    templateToggle,
    chatInput,
    sendBtn,
  );

  chatPanel = h('div', { className: 'collab-chat-panel' },
    header,
    chatMessagesContainer,
    templatesBar,
    inputRow,
  );

  document.body.appendChild(chatPanel);

  // Render existing messages
  renderAllMessages();
}

// ───── Templates ─────

function toggleTemplatesBar(): void {
  templatesBarVisible = !templatesBarVisible;
  const bar = document.getElementById('_chatTemplatesBar');
  if (bar) bar.style.display = templatesBarVisible ? '' : 'none';
}

function insertTemplate(content: string): void {
  if (!chatInput) return;
  const pos = chatInput.selectionStart || chatInput.value.length;
  const before = chatInput.value.slice(0, pos);
  const after = chatInput.value.slice(pos);
  chatInput.value = before + content + after;
  chatInput.focus();
  chatInput.selectionStart = chatInput.selectionEnd = pos + content.length;
  // Trigger auto-resize
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 200) + 'px';
}

// ───── Message Rendering ─────

function renderAllMessages(): void {
  if (!chatMessagesContainer) return;
  chatMessagesContainer.replaceChildren();
  for (const msg of messages) {
    chatMessagesContainer.appendChild(renderMessage(msg));
  }
  scrollToBottom();
}

/** Detect if text contains markdown syntax */
function hasMarkdown(text: string): boolean {
  return text.length > 10 && /[#*\[\]]/.test(text);
}

function renderMessage(msg: ChatMessage): HTMLElement {
  const time = formatRelativeTime(msg.timestamp);
  const useMarkdown = hasMarkdown(msg.text);

  const textEl = h('div', { className: useMarkdown ? 'collab-chat-text collab-chat-markdown' : 'collab-chat-text' });

  if (useMarkdown) {
    const frag = renderMarkdown(msg.text);
    textEl.appendChild(frag);
    // Attach card hover to [[Card Name]] links
    attachChatCardHover(textEl);
  } else {
    const textParts = highlightMentions(msg.text);
    textEl.append(...textParts);
  }

  return h('div', { className: 'collab-chat-msg' },
    h('div', { className: 'collab-chat-msg-header' },
      h('span', { className: 'collab-chat-sender', style: `color:${msg.color};` }, msg.participantName),
      h('span', { className: 'collab-chat-time' }, time),
    ),
    textEl,
  );
}

/** Attach delegated hover listeners for [[Card Name]] links rendered by markdown-lite */
function attachChatCardHover(container: HTMLElement): void {
  container.addEventListener('mouseover', (e) => {
    const target = (e.target as HTMLElement).closest('[data-card-name]');
    if (target) {
      showHoverPreviewByName(target.getAttribute('data-card-name')!, e);
    }
  });
  container.addEventListener('mouseout', (e) => {
    const target = (e.target as HTMLElement).closest('[data-card-name]');
    if (target) hideHoverPreview();
  });
}

function highlightMentions(text: string): (HTMLElement | string)[] {
  const parts: (HTMLElement | string)[] = [];
  const regex = /@(\w+)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(h('span', { className: 'collab-chat-mention' }, match[0]));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

function formatRelativeTime(timestamp: number): string {
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 10) return 'just now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom(): void {
  if (!chatMessagesContainer) return;
  // Only auto-scroll if user is near the bottom
  const { scrollTop, scrollHeight, clientHeight } = chatMessagesContainer;
  const isNearBottom = scrollHeight - scrollTop - clientHeight < 80;
  if (isNearBottom || messages.length <= 1) {
    requestAnimationFrame(() => {
      chatMessagesContainer!.scrollTop = chatMessagesContainer!.scrollHeight;
    });
  }
}

// ───── Sending Messages ─────

function sendMessage(): void {
  if (!chatInput) return;
  const text = chatInput.value.trim();
  if (!text) return;

  getCollabManager().sendChatMessage(text);
  chatInput.value = '';
  chatInput.style.height = 'auto';
  chatInput.focus();
}

function onInputKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

// ───── Event Handlers ─────

function onRemoteChatMessage(event: CollabEvent): void {
  const data = event.data as ChatMessage;

  messages.push(data);
  // Trim old messages
  while (messages.length > MAX_MESSAGES) {
    messages.shift();
  }

  // Render new message
  if (chatMessagesContainer) {
    chatMessagesContainer.appendChild(renderMessage(data));
    scrollToBottom();
    // Trim old DOM nodes too
    while (chatMessagesContainer.children.length > MAX_MESSAGES) {
      chatMessagesContainer.removeChild(chatMessagesContainer.firstChild!);
    }
  }

  // Update unread count if panel is closed
  if (!isOpen) {
    unreadCount++;
    updateBadge();
  }
}

function onDisconnected(): void {
  messages.length = 0;
  unreadCount = 0;
  updateBadge();
  if (chatMessagesContainer) chatMessagesContainer.replaceChildren();
}

/** Destroy the chat panel completely */
export function destroyCollabChat(): void {
  closeChatPanel();
  if (autocompleteCtrl) { autocompleteCtrl.destroy(); autocompleteCtrl = null; }
  chatPanel?.remove();
  chatPanel = null;
  chatMessagesContainer = null;
  chatInput = null;
  messages.length = 0;
  unreadCount = 0;
}
