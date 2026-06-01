const grid = document.getElementById('grid');
const refreshBtn = document.getElementById('refresh-btn');
const lastUpdated = document.getElementById('last-updated');
const configBanner = document.getElementById('config-banner');

let configWarningShown = false;

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
  const ghPRs = attachments.nodes.filter(a => a.url?.includes('github.com') && a.url.includes('/pull/'));
  if (!ghPRs.length) return [];

  // Prefer PRs whose title looks like a feature branch (e.g. "[TT-1234]" prefix),
  // falling back to all GitHub PRs if none match.
  const featurePRs = ghPRs.filter(a => /^\[?[A-Z]+-\d+\]?/.test(a.title || ''));
  const nodes = featurePRs.length ? featurePRs : ghPRs;

  return nodes.map(node => {
    const meta = node.metadata || {};
    const merged = meta.merged || meta.state === 'merged';
    const state = merged ? 'merged' : (meta.state || 'open');
    const numMatch = node.url.match(/\/pull\/(\d+)/);
    return {
      url: node.url,
      title: node.title || '',
      state,
      merged,
      draft: meta.draft || false,
      number: meta.number || (numMatch ? numMatch[1] : ''),
    };
  });
}

function renderPR(attachments) {
  const prs = parsePRsFromAttachments(attachments);
  if (!prs.length) return `<p class="error-msg" style="color:var(--text-muted)">No pull request found</p>`;
  return prs.map(pr => `
    <a class="pr-section" href="${escAttr(pr.url)}" target="_blank" rel="noopener">
      ${prIcon(pr.state, pr.merged, pr.draft)}
      <span class="pr-info">
        <span class="pr-title">${pr.number ? `#${pr.number} ` : ''}${escHtml(pr.title)}</span>
        <span class="pr-sub">${escHtml(repoFromUrl(pr.url))}</span>
      </span>
      ${prBadge(pr)}
    </a>`).join('');
}

function repoFromUrl(url) {
  const m = url.match(/github\.com\/[^/]+\/([^/]+)\/pull/);
  return m ? m[1] : 'GitHub';
}

function renderTicket(ticket) {
  if (ticket.error) return `<p class="error-msg">⚠ ${escHtml(ticket.error)}</p>`;
  if (!ticket) return `<p class="error-msg" style="color:var(--text-muted)">Ticket not found</p>`;
  return `<div class="ticket-section">
    <div class="ticket-top">
      <span class="ticket-id">${escHtml(ticket.identifier)}</span>
      <span class="ticket-title"><a href="${escAttr(ticket.url)}" target="_blank" rel="noopener">${escHtml(ticket.title)}</a></span>
    </div>
    <div class="ticket-meta">
      ${statusPill(ticket.state)}
      ${assigneeHtml(ticket.assignee)}
    </div>
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

  let bodyHtml = '';

  if (env.error) {
    bodyHtml = `<div class="card-body">
      <p class="error-msg">⚠ ${escHtml(env.error)}</p>
    </div>`;
  } else {
    const imageHtml = env.image
      ? `<code>${escHtml(env.image)}</code>`
      : `<span style="color:var(--text-muted)">—</span>`;

    const ticketSection = env.ticketId
      ? `<div class="ticket-placeholder">${skeletonRows()}</div>
         <hr class="divider" />
         <div class="pr-placeholder">${skeletonRows()}</div>`
      : `<p class="error-msg" style="color:var(--text-muted)">No ticket ID found in image tag</p>`;

    bodyHtml = `<div class="card-body">
      <div class="deploy-row">
        <span class="deploy-label">Image</span>
        <span class="deploy-value">${imageHtml}</span>
      </div>
      ${env.ticketId ? `<div class="deploy-row">
        <span class="deploy-label">Ticket</span>
        <span class="deploy-value"><code>${escHtml(env.ticketId)}</code></span>
      </div>` : ''}
      ${ticketSection}
    </div>`;
  }

  card.innerHTML = `<div class="card-header">
    <h2>${escHtml(env.name)}</h2>
    <span class="env-url"><a href="${escAttr(env.url)}" target="_blank" rel="noopener">${escHtml(env.url)}</a></span>
  </div>
  ${bodyHtml}`;

  return card;
}

async function load() {
  refreshBtn.classList.add('spinning');
  grid.innerHTML = '';
  configWarningShown = false;
  configBanner.classList.add('hidden');

  // Add skeleton cards immediately
  const placeholders = [1, 2].map(() => {
    const ph = document.createElement('div');
    ph.className = 'card';
    ph.innerHTML = `<div class="card-header"><h2>&nbsp;</h2></div>
      <div class="card-body">${skeletonRows()}</div>`;
    grid.appendChild(ph);
    return ph;
  });

  try {
    const res = await fetch('/api/deployments');
    const envs = await res.json();

    // Replace skeletons with real cards
    envs.forEach((env, i) => {
      const card = buildCard(env);
      grid.replaceChild(card, placeholders[i]);

      if (env.ticketId) {
        loadTicketAndPR(card, env.ticketId);
      }
    });

    lastUpdated.textContent = `Updated ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    grid.innerHTML = `<p class="error-msg">⚠ Failed to load deployment data: ${escHtml(err.message)}</p>`;
  } finally {
    refreshBtn.classList.remove('spinning');
    scheduleAutoRefresh();
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

let autoRefreshTimer = null;

function scheduleAutoRefresh() {
  clearTimeout(autoRefreshTimer);
  if (isWorkingHours()) {
    autoRefreshTimer = setTimeout(() => {
      load();
    }, 10 * 60 * 1000);
  }
}

refreshBtn.addEventListener('click', load);
load();
