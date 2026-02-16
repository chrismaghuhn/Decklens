// ==================== DOM-Only Rendering (Audit Report Â§4 - Score 18) ====================
// Mini hyperscript helper - XSS-safe by design.
// Source: decklens-audit-report-v4.3.md L617-684
//
// SECURITY GUARANTEES:
// - âœ… on* attributes as strings are REJECTED (only functions allowed)
// - âœ… String children become TextNodes (auto-escaped, no innerHTML)
// - âœ… target="_blank" links get rel="noopener noreferrer" automatically
// - âœ… No innerHTML usage anywhere

/**
 * Event handler type for DOM events.
 * SECURITY: Only functions are accepted, not strings like 'onclick="evil()"'
 */
type EventHandler = (e: any) => void;

/**
 * Props type for h() helper.
 * Note: This is intentionally broad to support all HTML attributes.
 * Future improvement: per-element Props typing for better IDE support.
 */
type Props = Record<string, string | number | boolean | EventHandler | null | undefined>;

/**
 * Child type for h() helper.
 * Strings are converted to TextNodes (auto-escaped).
 * Nodes are appended directly.
 */
type Child = Node | string | null | undefined | false;

/**
 * Flatten nested children arrays into a single array.
 */
function flattenChildren(children: (Child | Child[])[]): Child[] {
  const result: Child[] = [];
  for (const child of children) {
    if (Array.isArray(child)) {
      result.push(...flattenChildren(child));
    } else {
      result.push(child);
    }
  }
  return result;
}

/**
 * Mini hyperscript helper - safe by design.
 * Uses only DOM APIs, no innerHTML.
 *
 * SECURITY GUARANTEES:
 * - on* attributes as strings are REJECTED (only functions allowed)
 * - String children become TextNodes (auto-escaped)
 * - target="_blank" links get rel="noopener noreferrer" automatically
 *
 * @example
 * ```ts
 * const card = h('div', { className: 'card', 'data-id': '123' },
 *   h('img', { src: imgUrl, alt: cardName }),
 *   h('span', { className: 'card-name' }, cardName), // textNode, not innerHTML
 *   h('a', { href: url, target: '_blank' }, 'View') // auto: rel="noopener noreferrer"
 * );
 * container.replaceChildren(card);
 * ```
 */
export function h(
  tag: string,
  props: Props = {},
  ...children: (Child | Child[])[]
): HTMLElement {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    // Skip null/undefined values
    if (value === null || value === undefined) continue;

    if (key.startsWith('on')) {
      // SECURITY: Only allow function event handlers, reject strings
      if (typeof value === 'function') {
        const eventName = key.slice(2).toLowerCase();
        el.addEventListener(eventName, value as EventListener);
      }
      // String on* props are silently ignored for security (no onclick="evil()")
    } else if (key === 'className') {
      el.className = String(value);
    } else if (key === 'htmlFor') {
      el.setAttribute('for', String(value));
    } else if (typeof value === 'boolean') {
      // Boolean attributes: presence = true, absence = false
      if (value) {
        el.setAttribute(key, '');
      }
      // If false, don't set the attribute at all
    } else {
      el.setAttribute(key, String(value));
    }
  }

  // SECURITY: Auto-add noopener noreferrer for external links
  if (tag.toLowerCase() === 'a' && props.target === '_blank') {
    const existingRel = String(props.rel || '');
    const relParts = new Set(existingRel.split(' ').filter(Boolean));
    relParts.add('noopener');
    relParts.add('noreferrer');
    el.setAttribute('rel', [...relParts].join(' '));
  }

  // Append children
  const flatChildren = flattenChildren(children);
  for (const child of flatChildren) {
    if (child === null || child === undefined || child === false) {
      continue; // Skip falsy values (useful for conditional rendering)
    }
    // SECURITY: Strings become TextNodes (auto-escaped, no innerHTML)
    if (typeof child === 'string') {
      el.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }

  return el;
}


/**
 * Create a document fragment to batch multiple elements.
 */
export function fragment(...children: (Child | Child[])[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  const flatChildren = flattenChildren(children);
  for (const child of flatChildren) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string') {
      frag.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      frag.appendChild(child);
    }
  }
  return frag;
}

/**
 * Clear all children and set new content.
 * Safe replacement for innerHTML assignments.
 */
export function replaceChildren(parent: HTMLElement, ...children: (Child | Child[])[]): void {
  parent.replaceChildren(...flattenChildren(children).filter((c): c is Node | string =>
    c !== null && c !== undefined && c !== false
  ).map(c => typeof c === 'string' ? document.createTextNode(c) : c));
}


/**
 * Map an array to elements.
 * @example
 * h('ul', {}, ...mapChildren(items, (item, i) => h('li', { key: i }, item.name)))
 */
export function mapChildren<T>(
  items: T[],
  render: (item: T, index: number) => Child
): Child[] {
  return items.map(render);
}

// Export types for consumers
export type { Props, Child, EventHandler };
