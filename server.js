import dotenv from 'dotenv';
dotenv.config();                        // .env
dotenv.config({ path: '.env.local' }); // .env.local (local overrides, gitignored)
import express from 'express';
import session from 'express-session';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const APPLICATIONS = [
  {
    name: 'Map',
    statusPath: '/api/status',
    environments: [
      { name: 'Staging', slug: 'staging', url: 'https://map.london.live.staging.w3w.io' },
      { name: 'Preprod', slug: 'preprod', url: 'https://london.preprod.w3w.io' },
    ],
  },
  {
    name: 'Gateway',
    statusPath: '/healthz',
    environments: [
      { name: 'Staging', slug: 'staging', url: 'https://gateway.london.live.staging.w3w.io' },
      { name: 'Preprod', slug: 'preprod', url: 'https://gateway.london.preprod.w3w.io' },
    ],
  },
  {
    name: 'Auth',
    statusPath: '/api/healthz',
    environments: [
      { name: 'Staging', slug: 'staging', url: 'https://auth.london.live.staging.w3w.io' },
      { name: 'Preprod', slug: 'preprod', url: 'https://auth.london.preprod.w3w.io' },
    ],
  },
];

app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: false }));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-me-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

function requireAuth(req, res, next) {
  if (req.session?.authenticated) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authenticated' });
  res.redirect('/login');
}

// Public routes
app.get('/login', (req, res) => {
  if (req.session?.authenticated) return res.redirect('/');
  res.sendFile(join(__dirname, 'public/login.html'));
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.BASIC_AUTH_USER &&
    password === process.env.BASIC_AUTH_PASSWORD
  ) {
    req.session.authenticated = true;
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// Public static assets
app.use('/style.css', express.static(join(__dirname, 'public/style.css')));

// All routes below require auth
app.use(requireAuth);

app.use(express.static(join(__dirname, 'public')));

async function fetchEnvStatus(env, statusPath) {
  try {
    const response = await fetch(`${env.url}${statusPath}`, {
      timeout: 8000,
      headers: { 'Accept': 'application/json' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const image = data.image || '';
    const ticketMatch = image.match(/([A-Z]+-\d+)/);
    return { ...env, image, ticketId: ticketMatch ? ticketMatch[1] : null, error: null };
  } catch (err) {
    return { ...env, image: null, ticketId: null, error: err.message };
  }
}

// Fetch deployment status for all applications and environments
app.get('/api/deployments', async (req, res) => {
  const results = await Promise.all(
    APPLICATIONS.map(async (app) => ({
      name: app.name,
      environments: await Promise.all(app.environments.map(env => fetchEnvStatus(env, app.statusPath))),
    }))
  );
  res.json(results);
});

// Fetch Linear ticket info
const developerWhitelist = process.env.DEVELOPER_WHITELIST
  ? process.env.DEVELOPER_WHITELIST.split(',').map(n => n.trim()).filter(Boolean)
  : [];

function findDeveloper(issue) {
  if (developerWhitelist.length === 0) return null;

  const history = issue.history?.nodes || [];

  // Count state transitions per whitelisted actor, and track who moved it to "In Progress"
  const counts = {};
  const actors = {};
  let inProgressMover = null;

  for (const h of history) {
    if (!h.actor || !h.toState || !developerWhitelist.includes(h.actor.name)) continue;
    const name = h.actor.name;
    counts[name] = (counts[name] || 0) + 1;
    actors[name] = h.actor;
    if (!inProgressMover && h.toState.name.toLowerCase() === 'in progress') {
      inProgressMover = h.actor;
    }
  }

  if (Object.keys(counts).length === 0) return null;

  const maxCount = Math.max(...Object.values(counts));
  const topActors = Object.keys(counts).filter(n => counts[n] === maxCount);

  // Single winner
  if (topActors.length === 1) return actors[topActors[0]];

  // Tie-break: whoever moved it to "In Progress"
  if (inProgressMover && topActors.includes(inProgressMover.name)) return inProgressMover;

  // Still tied: return first alphabetically for determinism
  return actors[topActors.sort()[0]];
}

app.get('/api/linear/:ticketId', async (req, res) => {
  const { ticketId } = req.params;
  const apiKey = process.env.LINEAR_API_KEY;

  if (!apiKey) return res.status(503).json({ error: 'LINEAR_API_KEY not configured' });

  const query = `
    query Issue($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        state { name color }
        assignee { name avatarUrl }
        url
        priorityLabel
        labels { nodes { name color } }
        attachments { nodes { url title subtitle metadata } }
        history(first: 50) {
          nodes {
            createdAt
            toState { name }
            actor { name avatarUrl }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey,
      },
      body: JSON.stringify({ query, variables: { id: ticketId } }),
    });
    const data = await response.json();
    if (data.errors) throw new Error(data.errors[0].message);
    const issue = data.data.issue;
    res.json({ ...issue, developer: findDeveloper(issue) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Deployment status dashboard running at http://localhost:${PORT}`);
});
