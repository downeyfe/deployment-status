const grid = document.getElementById('grid');
const refreshBtn = document.getElementById('refresh-btn');
const lastUpdated = document.getElementById('last-updated');
const configBanner = document.getElementById('config-banner');

let configWarningShown = false;

// ── Local storage overrides ───────────────────────────────────────────────────
const OVERRIDES_KEY = 'deployment-status-overrides';
const ONE_MONTH = 30 * 24 * 60 * 60 * 1000;

function loadOverrides() {
  try { return JSON.parse(localStorage.getItem(OVERRIDES_KEY) || '{}'); }
  catch { return {}; }
}

function saveOverrides(overrides) {
  localStorage.setItem(OVERRIDES_KEY, JSON.stringify(overrides));
}

function getOverride(image) {
  const overrides = loadOverrides();
  const entry = overrides[image];
  if (!entry) return null;
  if (Date.now() - entry.savedAt > ONE_MONTH) {
    delete overrides[image];
    saveOverrides(overrides);
    return null;
  }
  return entry.ticketId;
}

function setOverride(image, ticketId) {
  const overrides = loadOverrides();
  if (ticketId) {
    overrides[image] = { ticketId, savedAt: Date.now() };
  } else {
    delete overrides[image]; // clear override if empty
  }
  saveOverrides(overrides);
}

function clearAllOverrides() {
  localStorage.removeItem(OVERRIDES_KEY);
}

// Clear overrides and expired entries on load
(function pruneExpired() {
  const overrides = loadOverrides();
  let changed = false;
  for (const [key, entry] of Object.entries(overrides)) {
    if (Date.now() - entry.savedAt > ONE_MONTH) { delete overrides[key]; changed = true; }
  }
  if (changed) saveOverrides(overrides);
})();

// Clear overrides on sign out
document.getElementById('logout-btn')?.addEventListener('click', (e) => {
  e.preventDefault();
  clearAllOverrides();
  window.location.href = '/logout';
});

function prIcon(state, merged, draft) {
  const color = merged ? '#b97cf5' : draft ? '#7b82a8' : state === 'open' ? '#3dd68c' : '#f06070';
  return `<svg class="pr-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/>
    <path d="M6 9v6"/><path d="M18 15V9a3 3 0 0 0-3-3h-3"/>
  </svg>`;
}

function prBadge(pr) {
  if (pr.merged) return `<span class="badge badge-merged">Merged</span>`;
  if (pr.draft)  return `<span class="badge badge-draft">Draft</span>`;
  if (pr.state === 'open')   return `<span class="badge badge-open">Open</span>`;
  if (pr.state === 'closed') return `<span class="badge badge-closed">Closed</span>`;
  return '';
}

function approvalBadge(approvalStatus) {
  if (!approvalStatus) return '';
  if (approvalStatus === 'approved')          return `<span class="badge badge-approved">Approved</span>`;
  if (approvalStatus === 'changes_requested') return `<span class="badge badge-changes">Changes requested</span>`;
  return `<span class="badge badge-awaiting">Awaiting review</span>`;
}

function statusPill(state) {
  if (!state) return '';
  const colorMap = {
    '#e2e2e2': '#e2e2e2',
  };
  const bg = state.color ? `${state.color}22` : 'var(--surface)';
  const border = state.color ? `${state.color}55` : 'var(--border)';
  const text = state.color || 'var(--text-muted)';
  return `<span class="status-pill" style="background:${bg};border-color:${border};color:${text}">
    <span class="status-dot" style="background:${state.color || 'var(--text-muted)'}"></span>
    ${escHtml(state.name)}
  </span>`;
}

function assigneeHtml(assignee) {
  if (!assignee) return `<span class="assignee"><span class="avatar-placeholder">?</span> Unassigned</span>`;
  const initials = assignee.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const avatar = assignee.avatarUrl
    ? `<img class="avatar" src="${escAttr(assignee.avatarUrl)}" alt="${escAttr(assignee.name)}" />`
    : `<span class="avatar-placeholder">${escHtml(initials)}</span>`;
  return `<span class="assignee">${avatar} ${escHtml(assignee.name)}</span>`;
}

function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(str) { return escHtml(str); }

function skeletonRows() {
  return `<div class="loading-row">
    <div class="skeleton short"></div>
    <div class="skeleton long"></div>
    <div class="skeleton" style="width:60%"></div>
  </div>`;
}

function parsePRsFromAttachments(attachments) {
  if (!attachments?.nodes) return [];
  const ghPRs = attachments.nodes.filter(a =>
    a.url?.includes('github.com') &&
    a.url.includes('/pull/') &&
    !a.url.includes('/infrastructure-manifests/') &&
    !a.url.includes('/aws/'));
  if (!ghPRs.length) return [];

  const nodes = ghPRs;

  return nodes.map(node => {
    const meta = node.metadata || {};
    // meta.status values: "open", "inReview", "draft", "closed", "merged"
    const status = meta.status || 'open';
    const merged = status === 'merged' || !!meta.mergedAt;
    const draft = status === 'draft' || !!meta.draft;
    const state = merged ? 'merged' : draft ? 'draft' : status === 'closed' ? 'closed' : 'open';

    // Derive approval status from reviews (only meaningful for open PRs)
    let approvalStatus = null;
    if (state === 'open') {
      const reviews = meta.reviews || [];
      if (reviews.some(r => r.state === 'changesRequested')) approvalStatus = 'changes_requested';
      else if (reviews.some(r => r.state === 'approved')) approvalStatus = 'approved';
      else approvalStatus = 'pending';
    }

    // Build reviewer list for open PRs: reviewed + pending (requested but not yet reviewed)
    let reviewers = [];
    if (state === 'open') {
      const reviews = meta.reviews || [];
      const requestedIds = (meta.reviewers || []).map(String);

      // Most recent review per reviewer, excluding the PR author
      const reviewMap = new Map();
      for (const r of [...reviews].sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt))) {
        if (r.reviewerLogin && r.reviewerLogin === meta.userLogin) continue;
        if (String(r.reviewerId) === String(meta.userId)) continue;
        reviewMap.set(String(r.reviewerId), r);
      }

      reviewers = [
        ...[...reviewMap.values()].map(r => ({
          login: r.reviewerLogin,
          avatarUrl: r.reviewerAvatarUrl || `https://avatars.githubusercontent.com/u/${r.reviewerId}?v=4`,
          state: r.state,
        })),
        ...requestedIds
          .filter(id => !reviewMap.has(id))
          .map(id => ({
            login: null,
            avatarUrl: `https://avatars.githubusercontent.com/u/${id}?v=4`,
            state: 'pending',
          })),
      ];
    }

    const numMatch = node.url.match(/\/pull\/(\d+)/);
    return {
      url: node.url,
      title: node.title || '',
      state,
      merged,
      draft,
      number: meta.number || (numMatch ? numMatch[1] : ''),
      approvalStatus,
      reviewers,
    };
  });
}

function renderPR(attachments) {
  const prs = parsePRsFromAttachments(attachments);
  if (!prs.length) return `<p class="error-msg" style="color:var(--text-muted)">No pull request found</p>`;
  return prs.map(pr => {
    const reviewerAvatars = pr.reviewers.length
      ? `<span class="pr-reviewers">${pr.reviewers.map(r => {
          const label = r.login ? escAttr(r.login) : 'Pending reviewer';
          const cls = r.state === 'approved' ? 'reviewer-approved'
            : r.state === 'changesRequested' ? 'reviewer-changes'
            : r.state === 'commented' ? 'reviewer-commented'
            : 'reviewer-pending';
          return `<img class="reviewer-avatar ${cls}" src="${escAttr(r.avatarUrl)}" alt="${label}" title="${label}" />`;
        }).join('')}</span>`
      : '';
    return `
    <a class="pr-section" href="${escAttr(pr.url)}" target="_blank" rel="noopener">
      ${prIcon(pr.state, pr.merged, pr.draft)}
      <span class="pr-info">
        <span class="pr-title">${pr.number ? `#${pr.number} ` : ''}${escHtml(pr.title)}</span>
        <span class="pr-sub">${escHtml(repoFromUrl(pr.url))}${reviewerAvatars}</span>
      </span>
      <span class="pr-badges">
        ${prBadge(pr)}
        ${approvalBadge(pr.approvalStatus)}
      </span>
    </a>`;
  }).join('');
}

function repoFromUrl(url) {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull/);
  return m ? m[1] : 'GitHub';
}

function personHtml(person) {
  if (!person) return `<span class="person-unknown">Unassigned</span>`;
  const initials = person.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const avatar = person.avatarUrl
    ? `<img class="avatar" src="${escAttr(person.avatarUrl)}" alt="${escAttr(person.name)}" />`
    : `<span class="avatar-placeholder">${escHtml(initials)}</span>`;
  return `<span class="assignee">${avatar} ${escHtml(person.name)}</span>`;
}

function metaRow(label, valueHtml) {
  return `<div class="meta-row">
    <span class="meta-label">${escHtml(label)}</span>
    <span class="meta-value">${valueHtml}</span>
  </div>`;
}

function renderTicket(ticket) {
  if (ticket.error) return `<p class="error-msg">⚠ ${escHtml(ticket.error)}</p>`;
  if (!ticket) return `<p class="error-msg" style="color:var(--text-muted)">Ticket not found</p>`;
  return `<div class="ticket-section">
    <div class="ticket-top">
      <a class="ticket-id" href="${escAttr(ticket.url)}" target="_blank" rel="noopener">${escHtml(ticket.identifier)}</a>
      <span class="ticket-title"><a href="${escAttr(ticket.url)}" target="_blank" rel="noopener">${escHtml(ticket.title)}</a></span>
    </div>
    ${metaRow('Status', statusPill(ticket.state))}
    ${metaRow('Assigned to', personHtml(ticket.assignee))}
    ${ticket.developer ? metaRow('Developed by', personHtml(ticket.developer)) : ''}
  </div>`;
}

async function loadTicketAndPR(card, ticketId) {
  const ticketEl = card.querySelector('.ticket-placeholder');
  const prEl = card.querySelector('.pr-placeholder');

  try {
    const ticketRes = await fetch(`/api/linear/${encodeURIComponent(ticketId)}`);
    const ticket = await ticketRes.json();

    if (ticket.error && ticket.error.includes('not configured')) {
      configWarningShown = true;
      configBanner.classList.remove('hidden');
      ticketEl.innerHTML = `<p class="error-msg">⚠ ${escHtml(ticket.error)}</p>`;
      prEl.innerHTML = '';
      return;
    }

    ticketEl.innerHTML = renderTicket(ticket);
    prEl.innerHTML = renderPR(ticket.attachments);
  } catch (err) {
    ticketEl.innerHTML = `<p class="error-msg">⚠ ${escHtml(err.message)}</p>`;
    prEl.innerHTML = '';
  }
}

function buildCard(env) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.slug = env.slug;
  card.dataset.image = env.image || '';

  // Apply local override if present
  const overriddenTicketId = env.image ? getOverride(env.image) : null;
  const ticketId = overriddenTicketId || env.ticketId;

  let bodyHtml = '';

  if (env.error) {
    bodyHtml = `<div class="card-body">
      <p class="error-msg">⚠ ${escHtml(env.error)}</p>
    </div>`;
  } else {
    const imageHtml = env.image
      ? `<code>${escHtml(env.image)}</code>`
      : `<span style="color:var(--text-muted)">—</span>`;

    const ticketDisplay = ticketId
      ? `<span class="ticket-override-display">
          <code class="ticket-id-value">${escHtml(ticketId)}</code>
          ${overriddenTicketId ? `<span class="override-badge" title="Manually overridden">edited</span>` : ''}
          <button class="edit-ticket-btn" title="Edit ticket ID" aria-label="Edit ticket ID">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        </span>`
      : `<span style="color:var(--text-muted)">—
          <button class="edit-ticket-btn" title="Set ticket ID" aria-label="Set ticket ID" style="margin-left:0.4rem">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
          </button>
        </span>`;

    const ticketSection = ticketId
      ? `<div class="ticket-placeholder">${skeletonRows()}</div>
         <hr class="divider" />
         <div class="pr-placeholder">${skeletonRows()}</div>`
      : `<p class="error-msg" style="color:var(--text-muted)">No ticket ID found in image tag</p>`;

    bodyHtml = `<div class="card-body">
      <div class="deploy-row">
        <span class="deploy-label">Image</span>
        <span class="deploy-value">${imageHtml}</span>
      </div>
      <div class="deploy-row">
        <span class="deploy-label">Ticket</span>
        <span class="deploy-value ticket-row-value">${ticketDisplay}</span>
      </div>
      ${ticketSection}
    </div>`;
  }

  card.innerHTML = `<div class="card-header">
    <h2>${escHtml(env.name)}</h2>
    <span class="env-url"><a href="${escAttr(env.url)}" target="_blank" rel="noopener">${escHtml(env.url)}</a></span>
  </div>
  ${bodyHtml}`;

  // Wire up the edit button
  card.querySelector('.edit-ticket-btn')?.addEventListener('click', () => startTicketEdit(card, env, ticketId));

  return card;
}

function startTicketEdit(card, env, currentTicketId) {
  const ticketRowValue = card.querySelector('.ticket-row-value');
  const original = ticketRowValue.innerHTML;

  ticketRowValue.innerHTML = `
    <span class="ticket-edit-form">
      <input class="ticket-edit-input" type="text" value="${escAttr(currentTicketId || '')}" placeholder="TT-12345" spellcheck="false" />
      <button class="ticket-edit-confirm" title="Confirm">✓</button>
      <button class="ticket-edit-cancel" title="Cancel">✕</button>
    </span>`;

  const input = ticketRowValue.querySelector('.ticket-edit-input');
  input.focus();
  input.select();

  const confirm = () => {
    const newId = input.value.trim().toUpperCase();
    if (newId && newId !== (env.ticketId || '').toUpperCase()) {
      setOverride(env.image, newId);
    } else if (!newId) {
      setOverride(env.image, null); // clear override
    }
    // Rebuild the card with new override applied
    const newEnv = { ...env };
    const section = card.closest('.app-section');
    const appGrid = card.parentElement;
    const newCard = buildCard(newEnv);
    appGrid.replaceChild(newCard, card);
    const resolvedId = getOverride(newEnv.image) || newEnv.ticketId;
    if (resolvedId) loadTicketAndPR(newCard, resolvedId);
  };

  const cancel = () => { ticketRowValue.innerHTML = original;
    ticketRowValue.querySelector('.edit-ticket-btn')?.addEventListener('click', () => startTicketEdit(card, env, currentTicketId));
  };

  ticketRowValue.querySelector('.ticket-edit-confirm').addEventListener('click', confirm);
  ticketRowValue.querySelector('.ticket-edit-cancel').addEventListener('click', cancel);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirm();
    if (e.key === 'Escape') cancel();
  });
}

function buildAppSection(appName) {
  const section = document.createElement('section');
  section.className = 'app-section';
  section.innerHTML = `<h2 class="app-title">${escHtml(appName)}</h2><div class="app-grid"></div>`;
  return section;
}

function skeletonSection(appName) {
  const section = buildAppSection(appName);
  const appGrid = section.querySelector('.app-grid');
  [1, 2].forEach(() => {
    const ph = document.createElement('div');
    ph.className = 'card';
    ph.innerHTML = `<div class="card-header"><h2>&nbsp;</h2></div><div class="card-body">${skeletonRows()}</div>`;
    appGrid.appendChild(ph);
  });
  return section;
}

async function load() {
  refreshBtn.classList.add('spinning');
  grid.innerHTML = '';
  configWarningShown = false;
  configBanner.classList.add('hidden');

  // Skeleton sections
  const APP_NAMES = ['Map', 'Gateway', 'Auth'];
  const skeletonSections = APP_NAMES.map(name => {
    const s = skeletonSection(name);
    grid.appendChild(s);
    return s;
  });

  try {
    const res = await fetch('/api/deployments');
    const apps = await res.json();

    apps.forEach((app, i) => {
      const section = buildAppSection(app.name);
      const appGrid = section.querySelector('.app-grid');

      app.environments.forEach(env => {
        const card = buildCard(env);
        appGrid.appendChild(card);
        const resolvedTicketId = (env.image && getOverride(env.image)) || env.ticketId;
        if (resolvedTicketId) loadTicketAndPR(card, resolvedTicketId);
      });

      grid.replaceChild(section, skeletonSections[i]);
    });

    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    grid.innerHTML = `<p class="error-msg">⚠ Failed to load deployment data: ${escHtml(err.message)}</p>`;
  } finally {
    refreshBtn.classList.remove('spinning');
    lastLoadTime = Date.now();
  }
}

function isWorkingHoursInTz(timeZone) {
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' }).format(now);
  if (day === 'Sat' || day === 'Sun') return false;
  const hour = parseInt(new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', hour12: false }).format(now), 10);
  return hour >= 9 && hour < 18;
}

function isWorkingHours() {
  return isWorkingHoursInTz('Europe/London') || isWorkingHoursInTz('Asia/Ho_Chi_Minh');
}

const AUTO_REFRESH_INTERVAL = 10 * 60 * 1000; // 10 minutes
let lastLoadTime = null;

// Check every minute whether an auto-refresh is due.
// This keeps running continuously so it resumes automatically when working hours start.
setInterval(() => {
  if (!isWorkingHours()) return;
  if (!lastLoadTime || Date.now() - lastLoadTime >= AUTO_REFRESH_INTERVAL) {
    load();
  }
}, 60 * 1000);

refreshBtn.addEventListener('click', load);
load();
