/**
 * Minimal Markdown-to-DOM renderer.
 * XSS-safe: uses only DOM APIs, no innerHTML.
 * Supports: **bold**, *italic*, # headings, - lists, [[Card Name]] links, line breaks.
 */

import { h } from '../shared/dom.js';

/**
 * Render a markdown string to a DocumentFragment (DOM nodes, no innerHTML).
 */
export function renderMarkdown(source: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = source.split('\n');
  let inList = false;
  let listEl: HTMLElement | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Empty line: break out of list, add spacing
    if (trimmed === '') {
      if (inList && listEl) {
        frag.appendChild(listEl);
        listEl = null;
        inList = false;
      }
      continue;
    }

    // Heading: # text
    const headingMatch = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      if (inList && listEl) {
        frag.appendChild(listEl);
        listEl = null;
        inList = false;
      }
      const level = headingMatch[1].length;
      const tag = level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5';
      const heading = document.createElement(tag);
      heading.className = 'md-heading';
      appendInlineNodes(heading, headingMatch[2]);
      frag.appendChild(heading);
      continue;
    }

    // List item: - text or * text
    const listMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        listEl = document.createElement('ul');
        listEl.className = 'md-list';
        inList = true;
      }
      const li = document.createElement('li');
      appendInlineNodes(li, listMatch[1]);
      listEl!.appendChild(li);
      continue;
    }

    // Regular paragraph
    if (inList && listEl) {
      frag.appendChild(listEl);
      listEl = null;
      inList = false;
    }
    const p = document.createElement('p');
    p.className = 'md-paragraph';
    appendInlineNodes(p, trimmed);
    frag.appendChild(p);
  }

  // Flush remaining list
  if (inList && listEl) {
    frag.appendChild(listEl);
  }

  return frag;
}

/**
 * Parse inline formatting and append as child nodes.
 * Handles: **bold**, *italic*, [[Card Name]] links, plain text.
 */
function appendInlineNodes(parent: HTMLElement, text: string): void {
  // Regex to match inline tokens
  const tokenPattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(\[\[(.+?)\]\])/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(text)) !== null) {
    // Append any text before this match
    if (match.index > lastIndex) {
      parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    }

    if (match[1]) {
      // **bold**
      const strong = document.createElement('strong');
      strong.textContent = match[2];
      parent.appendChild(strong);
    } else if (match[3]) {
      // *italic*
      const em = document.createElement('em');
      em.textContent = match[4];
      parent.appendChild(em);
    } else if (match[5]) {
      // [[Card Name]] → interactive card link with hover preview support
      const cardName = match[6];
      const link = h('a', {
        href: `https://scryfall.com/search?q=${encodeURIComponent(cardName)}`,
        target: '_blank',
        className: 'md-card-link',
      }, cardName);
      link.setAttribute('data-card-name', cardName);
      parent.appendChild(link);
    }

    lastIndex = match.index + match[0].length;
  }

  // Append remaining text
  if (lastIndex < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }
}
