/**
 * CollabTasks — Task Board (Kanban) for collaborative deck editing.
 *
 * Track deckbuilding tasks: "Find 2 more 2-drops", "Test vs Aggro", etc.
 * Three columns: Todo | In Progress | Done.
 */

import { h } from '../shared/dom.js';

// ───── Types ─────

export interface DeckTask {
  id: string;
  deck_id: string;
  title: string;
  description: string;
  status: string;
  assigned_to: string | null;
  created_by: string;
  priority: number;
  created_at: string;
  completed_at: string | null;
}

// ───── State ─────

let tasks: DeckTask[] = [];
let panelEl: HTMLElement | null = null;
let panelVisible = false;
let deckId: string | null = null;

// ───── Public API ─────

export function initTasks(currentDeckId: string): void {
  deckId = currentDeckId;
  loadTasks();
}

export function toggleTaskPanel(): void {
  panelVisible = !panelVisible;
  if (panelVisible) showPanel();
  else hidePanel();
}

export function isTaskPanelOpen(): boolean {
  return panelVisible;
}

export function refreshTasks(): void {
  loadTasks();
}

// ───── API ─────

function getApiOrigin(): string {
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'http://localhost:8787';
  }
  return 'https://decklens-api.chrisgarkisch.workers.dev';
}

async function loadTasks(): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/tasks`, { credentials: 'include' });
    if (!resp.ok) return;
    const data = await resp.json() as { ok: boolean; data: { tasks: DeckTask[] } };
    if (data.ok && data.data?.tasks) {
      tasks = data.data.tasks;
      if (panelVisible) renderBoard();
    }
  } catch { /* ignore */ }
}

export async function createTask(title: string, description?: string): Promise<DeckTask | null> {
  if (!deckId) return null;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/tasks`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description }),
    });
    if (!resp.ok) return null;
    const data = await resp.json() as { ok: boolean; data: { task: DeckTask } };
    if (data.ok && data.data?.task) {
      tasks.push(data.data.task);
      if (panelVisible) renderBoard();
      return data.data.task;
    }
  } catch { /* ignore */ }
  return null;
}

async function updateTask(taskId: string, updates: { status?: string; assignedTo?: string }): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/tasks/${taskId}`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (resp.ok) {
      const data = await resp.json() as { ok: boolean; data: { task: DeckTask } };
      if (data.ok && data.data?.task) {
        const idx = tasks.findIndex((t) => t.id === taskId);
        if (idx >= 0) tasks[idx] = data.data.task;
        if (panelVisible) renderBoard();
      }
    }
  } catch { /* ignore */ }
}

async function deleteTask(taskId: string): Promise<void> {
  if (!deckId) return;
  try {
    const resp = await fetch(`${getApiOrigin()}/api/decks/${deckId}/tasks/${taskId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    if (resp.ok) {
      tasks = tasks.filter((t) => t.id !== taskId);
      if (panelVisible) renderBoard();
    }
  } catch { /* ignore */ }
}

// ───── Panel UI ─────

function showPanel(): void {
  if (panelEl) { panelEl.style.display = 'flex'; loadTasks(); return; }

  panelEl = h('div', { className: 'task-panel' },
    h('div', { className: 'task-panel-header' },
      h('span', { className: 'task-panel-title' }, '\u2705 Task Board'),
      h('div', { className: 'task-panel-actions-header' },
        h('button', { className: 'task-add-btn', onClick: () => promptCreateTask(), title: 'New task' }, '+ Task'),
        h('button', { className: 'task-panel-close', onClick: () => toggleTaskPanel(), title: 'Close' }, '\u2715'),
      ),
    ),
    h('div', { className: 'task-board', id: '_taskBoard' }),
  );
  document.body.appendChild(panelEl);
  renderBoard();
}

function hidePanel(): void {
  if (panelEl) panelEl.style.display = 'none';
}

function renderBoard(): void {
  const container = document.getElementById('_taskBoard');
  if (!container) return;

  const columns: { key: string; label: string; icon: string }[] = [
    { key: 'todo', label: 'To Do', icon: '\uD83D\uDCCB' },
    { key: 'in_progress', label: 'In Progress', icon: '\u23F3' },
    { key: 'done', label: 'Done', icon: '\u2705' },
  ];

  const colEls = columns.map((col) => {
    const colTasks = tasks.filter((t) => t.status === col.key);

    const listEl = h('div', { className: 'task-column-list' },
      ...colTasks.map((task) => renderTaskCard(task, col.key)),
      colTasks.length === 0
        ? h('div', { className: 'task-column-empty' }, 'No tasks')
        : '',
    );

    // Drop zone for drag-and-drop
    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      listEl.classList.add('task-drop-target');
    });
    listEl.addEventListener('dragleave', (e) => {
      if (listEl.contains(e.relatedTarget as Node)) return;
      listEl.classList.remove('task-drop-target');
    });
    listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      listEl.classList.remove('task-drop-target');
      const taskId = e.dataTransfer?.getData('application/x-task-id');
      if (taskId) updateTask(taskId, { status: col.key });
    });

    return h('div', { className: `task-column task-column-${col.key}` },
      h('div', { className: 'task-column-header' },
        h('span', {}, `${col.icon} ${col.label}`),
        h('span', { className: 'task-column-count' }, String(colTasks.length)),
      ),
      listEl,
    );
  });

  container.replaceChildren(...colEls);
}

function renderTaskCard(task: DeckTask, currentColumn: string): HTMLElement {
  const card = h('div', { className: `task-card${task.priority > 0 ? ' task-priority-high' : ''}` },
    h('div', { className: 'task-card-header' },
      h('span', { className: 'task-card-title' }, task.title),
      h('button', { className: 'task-card-delete', onClick: (e: MouseEvent) => {
        e.stopPropagation();
        if (confirm('Delete this task?')) deleteTask(task.id);
      }, title: 'Delete' }, '\u2715'),
    ),
    task.description ? h('div', { className: 'task-card-desc' }, task.description) : '',
    h('div', { className: 'task-card-footer' },
      task.assigned_to ? h('span', { className: 'task-assignee' }, `\uD83D\uDC64 ${task.assigned_to}`) : '',
      task.created_by ? h('span', { className: 'task-created-by' }, `by ${task.created_by}`) : '',
    ),
    h('div', { className: 'task-card-actions' },
      ...getNextStatuses(currentColumn).map(({ key, label }) =>
        h('button', { className: 'task-move-btn', onClick: () => updateTask(task.id, { status: key }) }, label),
      ),
    ),
  );

  // Drag-and-drop
  card.draggable = true;
  card.addEventListener('dragstart', (e) => {
    e.dataTransfer!.setData('application/x-task-id', task.id);
    e.dataTransfer!.effectAllowed = 'move';
    card.classList.add('task-dragging');
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('task-dragging');
  });

  return card;
}

function getNextStatuses(current: string): Array<{ key: string; label: string }> {
  switch (current) {
    case 'todo': return [{ key: 'in_progress', label: '\u25B6 Start' }];
    case 'in_progress': return [{ key: 'done', label: '\u2705 Done' }, { key: 'todo', label: '\u25C0 Back' }];
    case 'done': return [{ key: 'todo', label: '\u21BA Reopen' }];
    default: return [];
  }
}

function promptCreateTask(): void {
  const overlay = h('div', { className: 'task-modal-overlay' },
    h('div', { className: 'task-modal' },
      h('h3', {}, 'New Task'),
      h('label', {}, 'Title'),
      h('input', { type: 'text', className: 'task-input', placeholder: 'e.g. Find 2 more 2-drops', id: '_taskTitle' }),
      h('label', {}, 'Description (optional)'),
      h('textarea', { className: 'task-textarea', placeholder: 'Details...', id: '_taskDesc', rows: '2' }),
      h('div', { className: 'task-modal-actions' },
        h('button', { className: 'task-modal-cancel', onClick: () => overlay.remove() }, 'Cancel'),
        h('button', { className: 'task-modal-confirm', onClick: async () => {
          const title = (document.getElementById('_taskTitle') as HTMLInputElement)?.value?.trim();
          if (!title) return;
          const desc = (document.getElementById('_taskDesc') as HTMLTextAreaElement)?.value?.trim() || '';
          await createTask(title, desc);
          overlay.remove();
        }}, 'Create'),
      ),
    ),
  );
  document.body.appendChild(overlay);
  setTimeout(() => (document.getElementById('_taskTitle') as HTMLInputElement)?.focus(), 50);
}
