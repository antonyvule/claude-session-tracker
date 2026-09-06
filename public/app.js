const STATUS_LABELS = {
  todo: 'To Do',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  done: 'Done',
  archived: 'Archived',
};
const STATUS_ICONS = {
  todo: '📝',
  in_progress: '🔄',
  blocked: '🚫',
  done: '✅',
  archived: '🗄️',
};
// "All" intentionally means all active work, not literally every status — Done
// and Archived are things you're finished with, so they only show when you pick
// those chips explicitly, never lumped into the default/catch-all view.
const ACTIVE_STATUSES = ['todo', 'in_progress', 'blocked'];
// Search result ordering: active work first (In Progress, then Blocked, then To
// Do), inactive last (Done, then Archived) — a pure client-side sort over
// already-fetched results using status data already held from the SSE feed, so
// it costs nothing on the search/ripgrep side.
const SEARCH_STATUS_ORDER = { in_progress: 0, blocked: 1, todo: 2, done: 3, archived: 4 };
const FILTER_CHIPS = ['active', 'todo', 'in_progress', 'blocked', 'done', 'archived'];
const FILTER_LABELS = { active: 'All', ...STATUS_LABELS };
const FILTER_ICONS = { active: '🗂️', ...STATUS_ICONS };

function loadFilter() {
  return localStorage.getItem('sessionFilter') || 'active';
}

const state = {
  cardsById: new Map(),
  projectsByKey: new Map(),
  staleThresholdHours: 24,
  adoConfig: { org: '', project: '' },
  selectedSessionId: null,
  chosenFolder: null,
  filter: loadFilter(),
  // The in-app terminal's WebSocket + xterm instance, if the panel is open for
  // the currently-selected session — closed and cleared whenever the detail
  // pane re-renders for a different session (the server-side PTY itself keeps
  // running regardless; only the browser's view of it disconnects).
  terminalSocket: null,
};

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) node.appendChild(c);
  return node;
}

// Deliberately small, not a full CommonMark parser — just enough for how Claude
// actually formats responses (bold/italic, inline/fenced code, headers, lists,
// links), so the transcript doesn't dump raw **/`/# syntax as plain text.
// Escaping happens before any tag is inserted, and the only interpolated
// attribute (link href) is restricted to http(s) URLs and drawn from the
// already-escaped text, so a literal " or & in transcript content can't break
// out of a tag or attribute.
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderMarkdown(raw) {
  const codeBlocks = [];
  let text = raw.replace(/```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g, (_, code) => {
    codeBlocks.push(`<pre class="md-code"><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  text = escapeHtml(text);
  text = text.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<div class="md-heading">$1</div>');
  text = text.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/(?:^|\n)((?:[-*]\s+.+(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^[-*]\s+/, '')}</li>`).join('');
    return `\n<ul>${items}</ul>`;
  });
  text = text.replace(/(?:^|\n)((?:\d+\.\s+.+(?:\n|$))+)/g, (_, block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\.\s+/, '')}</li>`).join('');
    return `\n<ol>${items}</ol>`;
  });
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);

  return text;
}

function toast(message, isError = false) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = el('div', { id: 'toast-host' });
    document.body.appendChild(host);
  }
  const node = el('div', { class: isError ? 'toast toast-error' : 'toast', text: message });
  host.appendChild(node);
  const duration = Math.max(3500, message.length * 60); // longer messages stay up longer
  setTimeout(() => node.remove(), duration);
}

async function api(url, opts) {
  const res = await fetch(url, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${res.status} ${res.statusText}`);
  return body;
}

// Shared success/failure toast wrapper for the common "fire a PATCH/POST,
// toast on failure" pattern. Returns undefined (already toasted) on failure
// so callers that need post-success logic can just check the return value.
async function apiWithToast(url, opts, errorPrefix, successMessage) {
  try {
    const result = await api(url, opts);
    if (successMessage) toast(successMessage);
    return result;
  } catch (err) {
    toast(`${errorPrefix}: ${err.message}`, true);
    return undefined;
  }
}

// ---------- SSE ----------
function connectSSE() {
  const es = new EventSource('/events');
  es.onmessage = (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'snapshot') {
      state.cardsById = new Map(msg.cards.map((c) => [c.sessionId, c]));
      state.projectsByKey = new Map(msg.projects.map((p) => [p.projectKey, p]));
      state.staleThresholdHours = msg.settings.staleThresholdHours;
      renderAll();
    } else if (msg.type === 'session:update') {
      const existing = state.cardsById.get(msg.sessionId) || {};
      state.cardsById.set(msg.sessionId, { ...existing, ...msg.patch });
      renderAll();
    } else if (msg.type === 'session:remove') {
      state.cardsById.delete(msg.sessionId);
      if (state.selectedSessionId === msg.sessionId) state.selectedSessionId = null;
      renderAll();
    } else if (msg.type === 'projects:update') {
      state.projectsByKey = new Map(msg.projects.map((p) => [p.projectKey, p]));
      renderSessionList();
    } else if (msg.type === 'poll:status') {
      const banner = document.getElementById('poll-banner');
      if (msg.ok) {
        banner.classList.add('hidden');
      } else {
        banner.textContent = `Live status unavailable: ${msg.error}`;
        banner.classList.remove('hidden');
      }
    }
  };
  es.onerror = () => {
    // browsers auto-reconnect EventSource with backoff; nothing extra needed
  };
}

function renderAll() {
  renderSessionList();
  if (state.selectedSessionId && state.cardsById.has(state.selectedSessionId)) {
    updateSelectedDetailHeader();
  }
}

// ---------- Helpers ----------
function relativeTime(ms) {
  const diff = Date.now() - ms;
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function cardSortKey(card) {
  return [
    card.pinned ? 0 : 1,
    card.needsAttention ? 0 : 1,
    card.stale ? 0 : 1,
    card.orderIndex !== null && card.orderIndex !== undefined ? card.orderIndex : Infinity,
    -card.lastActiveMs,
  ];
}

function compareArrays(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function projectDisplayName(projectKey, sampleCwd) {
  const p = state.projectsByKey.get(projectKey);
  if (p && p.displayName) return p.displayName;
  const parts = sampleCwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || sampleCwd;
}

// Project/repo label shown on each card (there's no project group header to
// carry this anymore). Doubles as the ADO ticket link when one is set.
function projectLabelEl(card) {
  const label = projectDisplayName(card.projectKey, card.cwd);
  const project = state.projectsByKey.get(card.projectKey);
  if (project && project.adoTicketId && state.adoConfig.org && state.adoConfig.project) {
    const url = `https://dev.azure.com/${state.adoConfig.org}/${state.adoConfig.project}/_workitems/edit/${project.adoTicketId}`;
    return el('a', { href: url, target: '_blank', text: `${label} #${project.adoTicketId}`, title: 'Project — opens linked ADO ticket', onclick: (e) => e.stopPropagation() });
  }
  return el('span', { class: 'project-label', text: label, title: 'Project' });
}

function matchesFilter(card) {
  if (state.filter === 'active') return ACTIVE_STATUSES.includes(card.status);
  return card.status === state.filter;
}

// ---------- Filter bar ----------
function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = '';
  for (const key of FILTER_CHIPS) {
    const isActive = state.filter === key;
    const chip = el('button', {
      class: isActive ? 'filter-chip active' : 'filter-chip',
      text: `${FILTER_ICONS[key]} ${FILTER_LABELS[key]}`,
      title: key === 'active' ? 'All active work — To Do, In Progress, Blocked. Done and Archived are excluded on purpose.' : `Show only ${STATUS_LABELS[key]}`,
      onclick: () => {
        state.filter = key;
        localStorage.setItem('sessionFilter', key);
        renderSessionList();
        renderFilterBar();
      },
    });
    if (key !== 'active' && key !== 'all') chip.setAttribute('data-status', key);
    bar.appendChild(chip);
  }
}

// ---------- Session list (left pane) ----------
function renderCard(card) {
  const title = card.titleOverride || card.name || `session ${card.sessionId.slice(0, 8)}`;
  const meta = [];
  meta.push(el('span', { class: 'status-pill', 'data-status': card.status, text: `${STATUS_ICONS[card.status]} ${STATUS_LABELS[card.status]}`, title: STATUS_LABELS[card.status] }));
  meta.push(projectLabelEl(card));
  if (card.branch) meta.push(el('span', { text: card.branch, title: `Git branch: ${card.branch}` }));
  meta.push(el('span', { text: relativeTime(card.lastActiveMs), title: new Date(card.lastActiveMs).toLocaleString() }));
  if (card.running) meta.push(el('span', { class: 'dot', title: 'Currently running' }));
  if (card.needsAttention) meta.push(el('span', { class: 'badge badge-needs-you', text: 'Needs you', title: 'The assistant is waiting on a tool/permission approval with no reply yet' }));
  if (card.stale) meta.push(el('span', { class: 'badge badge-stale', text: 'Stale', title: 'Was In Progress but untouched past the stale threshold' }));
  if (card.pinned) meta.push(el('span', { class: 'badge badge-pinned', text: 'Pinned', title: 'Pinned — always sorts to the top of the list' }));

  const isSelected = card.sessionId === state.selectedSessionId;
  return el('div', {
    class: isSelected ? 'card selected' : 'card',
    'data-status': card.status,
    'data-session-id': card.sessionId,
    draggable: 'true',
    onclick: () => selectSession(card.sessionId),
    ondragstart: (e) => {
      e.dataTransfer.setData('text/plain', JSON.stringify({ sessionId: card.sessionId }));
    },
    ondragover: (e) => e.preventDefault(),
    ondrop: (e) => {
      e.preventDefault();
      e.stopPropagation();
      handleSessionDrop(e, card);
    },
  }, [
    el('div', { class: 'card-title', text: title }),
    el('div', { class: 'card-meta' }, meta),
  ]);
}

async function handleSessionDrop(e, targetCard) {
  let dragged;
  try {
    dragged = JSON.parse(e.dataTransfer.getData('text/plain'));
  } catch {
    return;
  }
  if (!dragged || dragged.sessionId === targetCard.sessionId) return;

  const orderedIds = Array.from(state.cardsById.values())
    .filter(matchesFilter)
    .sort((a, b) => compareArrays(cardSortKey(a), cardSortKey(b)))
    .map((c) => c.sessionId);

  const fromIdx = orderedIds.indexOf(dragged.sessionId);
  if (fromIdx === -1) return;
  orderedIds.splice(fromIdx, 1);
  const toIdx = orderedIds.indexOf(targetCard.sessionId);
  orderedIds.splice(toIdx, 0, dragged.sessionId);

  await apiWithToast('/api/sessions/reorder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orderedSessionIds: orderedIds }),
  }, 'Failed to reorder');
}

function renderSessionList() {
  const container = document.getElementById('session-list');
  container.innerHTML = '';

  const allCards = Array.from(state.cardsById.values());
  let running = 0;
  let needsYou = 0;
  for (const c of allCards) {
    if (c.running) running += 1;
    if (c.needsAttention) needsYou += 1;
  }
  const countsEl = document.getElementById('counts');
  countsEl.innerHTML = '';
  countsEl.append(
    el('span', { class: 'stat-num', text: String(running) }),
    document.createTextNode(' running · '),
    el('span', { class: 'stat-num', text: String(needsYou) }),
    document.createTextNode(' need you')
  );
  document.title = needsYou > 0 ? `(${needsYou}) Claude Session Tracker` : 'Claude Session Tracker';

  const visibleCards = allCards.filter(matchesFilter).sort((a, b) => compareArrays(cardSortKey(a), cardSortKey(b)));

  if (visibleCards.length === 0) {
    container.appendChild(el('div', { class: 'empty-state', text: 'No sessions match this filter.' }));
  } else {
    for (const card of visibleCards) container.appendChild(renderCard(card));
  }
}

// Shared by the initial detail-pane render and the live SSE-driven patch below,
// so a session's status control and action buttons never go stale while its
// detail pane stays open (e.g. it starts running elsewhere) without needing a
// full re-render that would also reset the transcript scroll position and any
// unsaved notes/tags/rename edits.
function buildStatusSelect(sessionId, card) {
  const statusSelect = el('select', { class: 'status-select', 'data-status': card.status, title: 'Picking a status here marks it as manually set, so the tracker stops auto-managing it' });
  for (const s of Object.keys(STATUS_LABELS)) {
    const opt = el('option', { value: s, text: `${STATUS_ICONS[s]} ${STATUS_LABELS[s]}` });
    if (s === card.status) opt.selected = true;
    statusSelect.appendChild(opt);
  }
  statusSelect.addEventListener('change', async () => {
    const result = await apiWithToast(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: statusSelect.value, manually_set: true }),
    }, 'Failed to update status');
    if (result) statusSelect.setAttribute('data-status', statusSelect.value);
  });
  return statusSelect;
}

function actionBtnsKey(card) {
  return JSON.stringify([card.running, card.pid, card.projectKey, card.cwd]);
}

function buildActionBtns(card) {
  const actionBtns = el('div', { class: 'action-btns' });
  actionBtns.dataset.key = actionBtnsKey(card);
  if (card.running) {
    actionBtns.appendChild(el('button', { disabled: 'true', text: `Already open (pid ${card.pid})`, title: 'This exact session is already running elsewhere' }));
  } else {
    actionBtns.appendChild(el('button', { text: 'Resume', title: 'Reopen this exact session', onclick: () => runAction('resume', card) }));
  }
  actionBtns.appendChild(el('button', { text: 'Fork', title: 'Start a new session from this history, leaving this session untouched', onclick: () => runAction('fork', card) }));
  actionBtns.appendChild(el('button', { text: 'Continue latest in project', title: "Runs Claude Code's own \"continue most recent\" for this project — may land on a different session than this one", onclick: () => continueInProject(card.projectKey, card.cwd) }));
  actionBtns.appendChild(el('button', { text: 'Copy command', title: 'Copy the equivalent CLI command to your clipboard', onclick: () => copyCommand(card.running ? 'fork' : 'resume', card) }));
  return actionBtns;
}

function updateSelectedDetailHeader() {
  const card = state.cardsById.get(state.selectedSessionId);
  if (!card) return;
  const titleEl = document.getElementById('detail-title-text');
  if (titleEl) titleEl.textContent = card.titleOverride || card.name || state.selectedSessionId;

  const statusRow = document.querySelector('.detail-header .status-row');
  if (statusRow) {
    const existing = statusRow.querySelector('.status-select');
    // Don't yank the dropdown away while the user has it open/focused.
    if (!existing || document.activeElement !== existing) {
      if (existing) existing.remove();
      statusRow.appendChild(buildStatusSelect(state.selectedSessionId, card));
    }
  }

  const oldActionBtns = document.querySelector('.detail-header .action-btns');
  // Rebuilding unconditionally would drop an in-flight click (e.g. a
  // just-clicked Resume button) on every unrelated SSE patch; only replace
  // when something the buttons actually depend on changed.
  if (oldActionBtns && oldActionBtns.dataset.key !== actionBtnsKey(card)) {
    oldActionBtns.replaceWith(buildActionBtns(card));
  }
}

// Embeds a real interactive `claude --resume` session in the page via the
// server's PTY (src/ptyManager.js) instead of opening a separate terminal
// window. Collapsed by default; connecting is deferred until first opened.
function buildTerminalPanel(sessionId, card) {
  const panel = el('div', { class: 'terminal-panel' });
  const toggleBtn = el('button', { class: 'terminal-toggle', text: '▸ Open live terminal' });
  const termContainer = el('div', { class: 'terminal-container hidden' });
  panel.appendChild(toggleBtn);
  panel.appendChild(termContainer);

  let term = null;
  let fitAddon = null;
  let resizeObserver = null;

  function connect() {
    const term_ = new Terminal({ convertEol: true, fontSize: 13, scrollback: 5000 });
    fitAddon = new FitAddon.FitAddon();
    term_.loadAddon(fitAddon);
    term_.open(termContainer);
    fitAddon.fit();
    term = term_;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const params = new URLSearchParams({ sessionId, cwd: card.cwd });
    const ws = new WebSocket(`${proto}//${location.host}/ws/terminal?${params}`);
    state.terminalSocket = ws;

    ws.addEventListener('message', (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === 'data') term_.write(msg.data);
      else if (msg.type === 'exit') term_.write(`\r\n\x1b[2m[process exited, code ${msg.exitCode}]\x1b[0m\r\n`);
    });
    ws.addEventListener('close', (evt) => {
      if (evt.code === 1008) term_.write(`\r\n\x1b[2m[${evt.reason || 'connection closed'}]\x1b[0m\r\n`);
      if (state.terminalSocket === ws) state.terminalSocket = null;
    });
    ws.addEventListener('error', () => toast('Terminal connection error', true));

    term_.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
    });

    function sendResize() {
      fitAddon.fit();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term_.cols, rows: term_.rows }));
      }
    }
    resizeObserver = new ResizeObserver(sendResize);
    resizeObserver.observe(termContainer);
    ws.addEventListener('open', sendResize);
  }

  toggleBtn.addEventListener('click', () => {
    const isHidden = termContainer.classList.contains('hidden');
    if (isHidden) {
      termContainer.classList.remove('hidden');
      toggleBtn.textContent = '▾ Live terminal (collapse)';
      if (!term) connect();
      else fitAddon.fit();
    } else {
      termContainer.classList.add('hidden');
      toggleBtn.textContent = '▸ Open live terminal';
    }
  });

  return panel;
}

// ---------- Detail pane (right) ----------
async function selectSession(sessionId) {
  // Switching sessions (or re-rendering this one) tears down any open
  // in-app terminal view — the underlying PTY on the server keeps running
  // regardless; this only disconnects the browser's socket to it.
  if (state.terminalSocket) {
    state.terminalSocket.close();
    state.terminalSocket = null;
  }
  const card = state.cardsById.get(sessionId);
  // Selecting a session (e.g. from a search result) whose status the current
  // filter hides would otherwise update the detail pane while leaving the list
  // showing no corresponding card at all — switch to the chip that matches it.
  if (card && !matchesFilter(card)) {
    state.filter = card.status;
    localStorage.setItem('sessionFilter', state.filter);
    renderFilterBar();
  }
  state.selectedSessionId = sessionId;
  renderSessionList(); // refresh selection highlight
  const cardEl = document.querySelector(`.card[data-session-id="${sessionId}"]`);
  if (cardEl) cardEl.scrollIntoView({ block: 'nearest' });
  const empty = document.getElementById('detail-empty');
  const body = document.getElementById('detail-body');
  empty.classList.add('hidden');
  body.classList.remove('hidden');
  body.innerHTML = 'Loading…';

  let detail = null;
  try {
    detail = await api(`/api/sessions/${sessionId}/detail`);
  } catch {
    detail = null;
  }

  body.innerHTML = '';

  // Fixed header: title, status, folder, actions, cost — always visible, never scrolls.
  const header = el('div', { class: 'detail-header' });
  header.appendChild(el('h2', { id: 'detail-title-text', text: card.titleOverride || card.name || sessionId }));

  const statusRow = el('div', { class: 'detail-row status-row' }, [el('label', { text: 'Status' })]);
  statusRow.appendChild(buildStatusSelect(sessionId, card));
  header.appendChild(statusRow);

  header.appendChild(el('div', { class: 'detail-row' }, [
    el('label', { text: 'Folder' }),
    el('div', { text: card.cwd }),
  ]));

  header.appendChild(buildActionBtns(card));

  if (detail) {
    header.appendChild(el('div', { class: 'detail-row' }, [
      el('label', { text: `Cost estimate (rough) — ${detail.turnCount} turns` }),
      el('div', { text: `$${detail.costUsd.toFixed(4)}` }),
    ]));
  }
  body.appendChild(header);

  // Scrollable middle: only the transcript scrolls, everything else stays on screen.
  const transcriptWrap = el('div', { class: 'detail-transcript' });
  if (detail) {
    for (const turn of detail.turns) {
      const isUser = turn.role === 'user';
      const textEl = el('div', { class: 'turn-text' });
      textEl.innerHTML = renderMarkdown(turn.text);
      transcriptWrap.appendChild(el('div', { class: 'preview-turn', 'data-role': turn.role }, [
        el('div', { class: 'role', text: isUser ? '🧑 You' : '🤖 Claude' }),
        textEl,
      ]));
    }
  } else {
    transcriptWrap.appendChild(el('div', { text: 'No transcript on disk yet for this session.' }));
  }
  body.appendChild(transcriptWrap);
  transcriptWrap.scrollTop = transcriptWrap.scrollHeight; // land on the latest messages, not the oldest

  body.appendChild(buildTerminalPanel(sessionId, card));

  // Fixed footer: rename/notes/tags/pin/save — always visible, never scrolls.
  const footer = el('div', { class: 'detail-footer' });
  const titleInput = el('input', { type: 'text', value: card.titleOverride || '', placeholder: 'Rename…' });
  const notesArea = el('textarea', { rows: '2', text: card.notes || '' });
  const tagsInput = el('input', { type: 'text', value: card.tags || '', placeholder: 'comma,separated,tags' });
  const pinnedCheckbox = el('input', { type: 'checkbox' });
  pinnedCheckbox.checked = Boolean(card.pinned);

  const saveBtn = el('button', { text: 'Save', onclick: () =>
    apiWithToast(`/api/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title_override: titleInput.value || null,
        notes: notesArea.value,
        tags: tagsInput.value,
        pinned: pinnedCheckbox.checked,
      }),
    }, 'Failed to save', 'Saved.')
  });

  footer.appendChild(el('div', { class: 'detail-row' }, [el('label', { text: 'Rename' }), titleInput]));
  footer.appendChild(el('div', { class: 'detail-row' }, [el('label', { text: 'Notes' }), notesArea]));
  footer.appendChild(el('div', { class: 'detail-row' }, [el('label', { text: 'Tags' }), tagsInput]));
  footer.appendChild(el('div', { class: 'detail-row pinned-row' }, [
    el('label', { class: 'pinned-label' }, [pinnedCheckbox, document.createTextNode('Pinned')]),
    saveBtn,
  ]));
  body.appendChild(footer);
}

function latestRunningInProject(projectKey) {
  const running = Array.from(state.cardsById.values()).filter((c) => c.projectKey === projectKey && c.running);
  running.sort((a, b) => b.lastActiveMs - a.lastActiveMs);
  return running[0] || null;
}

async function continueInProject(projectKey, cwd) {
  const alreadyOpen = latestRunningInProject(projectKey);
  if (alreadyOpen) {
    selectSession(alreadyOpen.sessionId);
    if (alreadyOpen.pid) {
      const result = await api('/api/actions/focus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid: alreadyOpen.pid }),
      }).catch(() => ({ ok: false, result: 'error' }));
      const messages = {
        focused: `Already running (pid ${alreadyOpen.pid}) — focused its window.`,
        'focused-terminal-fallback': 'Already running — focused Windows Terminal (switch tabs to find it; this machine hosts sessions as tabs in one shared window).',
        'focus-blocked': `Already running (pid ${alreadyOpen.pid}) — found its window, but Windows blocked the focus switch; switched to it here instead.`,
      };
      toast(messages[result.result] || `Already running (pid ${alreadyOpen.pid}) — couldn't focus its window; switched to it here instead.`);
    } else {
      toast('A session in this project is already running — switched to it.');
    }
    return;
  }
  toast('Opening a new tab in your terminal…');
  runProjectAction('continue', cwd);
}

async function runAction(type, card) {
  await apiWithToast(`/api/actions/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: card.sessionId, cwd: card.cwd }),
  }, 'Failed to launch');
}

async function runProjectAction(type, cwd) {
  await apiWithToast(`/api/actions/${type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cwd }),
  }, 'Failed to launch');
}

async function copyCommand(type, card) {
  const params = new URLSearchParams({ type, sessionId: card.sessionId });
  const { command } = await api(`/api/actions/command?${params}`);
  await navigator.clipboard.writeText(command);
}

function closePanel(id) {
  document.getElementById(id).classList.add('hidden');
}

// ---------- New session modal ----------
async function openNewSessionModal() {
  const modal = document.getElementById('new-session-modal');
  modal.classList.remove('hidden');
  document.getElementById('ns-error').classList.add('hidden');
  state.chosenFolder = null;
  document.getElementById('ns-folder').value = '';

  const { roots } = await api('/api/projects/roots');
  const select = document.getElementById('ns-quickpick');
  select.innerHTML = '<option value="">— choose a known project —</option>';
  for (const root of roots) select.appendChild(el('option', { value: root, text: root }));
  select.onchange = () => {
    state.chosenFolder = select.value || null;
    document.getElementById('ns-folder').value = state.chosenFolder || '';
  };

  renderBrowse(null);
}

async function renderBrowse(path) {
  const container = document.getElementById('ns-browse');
  container.innerHTML = 'Loading…';
  const params = path ? `?path=${encodeURIComponent(path)}` : '';
  const data = await api(`/api/browse${params}`);
  container.innerHTML = '';
  const list = el('div', { class: 'browse-list' });
  if (data.parent) {
    list.appendChild(el('div', { class: 'browse-item', text: '.. (up)', onclick: () => renderBrowse(data.parent) }));
  }
  for (const entry of data.entries) {
    list.appendChild(el('div', { class: 'browse-item' }, [
      el('span', { text: entry.name, onclick: () => renderBrowse(entry.path) }),
      el('button', { text: 'select', onclick: () => {
        state.chosenFolder = entry.path;
        document.getElementById('ns-folder').value = entry.path;
      } }),
    ]));
  }
  container.appendChild(list);
}

async function launchNewSession() {
  const errorEl = document.getElementById('ns-error');
  errorEl.classList.add('hidden');
  if (!state.chosenFolder) {
    errorEl.textContent = 'Choose a folder first.';
    errorEl.classList.remove('hidden');
    return;
  }
  const payload = {
    cwd: state.chosenFolder,
    name: document.getElementById('ns-name').value || undefined,
    model: document.getElementById('ns-model').value || undefined,
    effort: document.getElementById('ns-effort').value || undefined,
  };
  try {
    await api('/api/actions/new', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    closePanel('new-session-modal');
    toast("Session launching — it won't appear in this list until you send it a first message (that's when Claude Code creates its transcript).");
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  }
}

async function copyNewSessionCommand() {
  const params = new URLSearchParams({
    type: 'new',
    name: document.getElementById('ns-name').value || '',
    model: document.getElementById('ns-model').value || '',
    effort: document.getElementById('ns-effort').value || '',
  });
  const { command } = await api(`/api/actions/command?${params}`);
  await navigator.clipboard.writeText(command);
}

// ---------- Search ----------
async function runSearch(query) {
  const panel = document.getElementById('search-results');
  const list = document.getElementById('search-results-list');
  if (!query) {
    panel.classList.add('hidden');
    return;
  }
  const { ok, error, results } = await api(`/api/search?q=${encodeURIComponent(query)}`);
  panel.classList.remove('hidden');
  list.innerHTML = '';
  if (!ok) {
    list.appendChild(el('div', { class: 'search-result', text: error }));
    return;
  }
  if (results.length === 0) {
    list.appendChild(el('div', { class: 'search-result', text: 'No matches.' }));
  }
  const sorted = results.slice().sort((a, b) => {
    const cardA = state.cardsById.get(a.sessionId);
    const cardB = state.cardsById.get(b.sessionId);
    const orderA = cardA ? SEARCH_STATUS_ORDER[cardA.status] ?? 5 : 5;
    const orderB = cardB ? SEARCH_STATUS_ORDER[cardB.status] ?? 5 : 5;
    if (orderA !== orderB) return orderA - orderB;
    return (cardB ? cardB.lastActiveMs : 0) - (cardA ? cardA.lastActiveMs : 0);
  });
  for (const r of sorted) {
    const card = state.cardsById.get(r.sessionId);
    const name = (card && (card.titleOverride || card.name)) || `session ${r.sessionId.slice(0, 8)}`;
    const head = [el('div', { class: 'search-result-name', text: name })];
    if (card) {
      head.unshift(el('span', {
        class: 'status-pill',
        'data-status': card.status,
        text: `${STATUS_ICONS[card.status]} ${STATUS_LABELS[card.status]}`,
      }));
    }
    list.appendChild(el('div', {
      class: 'search-result',
      onclick: () => { panel.classList.add('hidden'); selectSession(r.sessionId); },
    }, [
      el('div', { class: 'search-result-head' }, head),
      el('div', { class: 'search-result-snippet', text: r.snippet }),
    ]));
  }
}

// ---------- Wiring ----------
document.addEventListener('DOMContentLoaded', async () => {
  try {
    state.adoConfig = (await api('/api/config')).ado;
  } catch {
    // config endpoint unreachable at startup — list still renders without ADO links
  }

  renderFilterBar();
  connectSSE();

  document.getElementById('new-session-btn').addEventListener('click', openNewSessionModal);
  document.getElementById('ns-launch-btn').addEventListener('click', launchNewSession);
  document.getElementById('ns-copy-btn').addEventListener('click', copyNewSessionCommand);
  document.getElementById('help-btn').addEventListener('click', () => {
    document.getElementById('help-panel').classList.remove('hidden');
  });

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closePanel(btn.dataset.close));
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-wrap')) closePanel('search-results');
  });

  let searchTimer = null;
  document.getElementById('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(e.target.value.trim()), 300);
  });

  document.addEventListener('keydown', (e) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('search-input').focus();
    } else if (e.key === 'Escape') {
      closePanel('search-results');
      closePanel('new-session-modal');
      closePanel('help-panel');
    }
  });

  // Keep "3m ago" labels fresh between SSE updates.
  setInterval(renderSessionList, 30000);
});
