import 'dotenv/config';
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
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
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
    res.json(data.data.issue);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Deployment status dashboard running at http://localhost:${PORT}`);
});
