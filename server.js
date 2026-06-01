import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

const ENVIRONMENTS = [
  {
    name: 'Staging',
    slug: 'staging',
    url: 'https://map.london.live.staging.w3w.io',
    statusPath: '/api/status',
  },
  {
    name: 'Preprod',
    slug: 'preprod',
    url: 'https://london.preprod.w3w.io',
    statusPath: '/api/status',
  },
];

app.use(express.static(join(__dirname, 'public')));

// Fetch deployment status for all environments
app.get('/api/deployments', async (req, res) => {
  const results = await Promise.all(
    ENVIRONMENTS.map(async (env) => {
      try {
        const response = await fetch(`${env.url}${env.statusPath}`, {
          timeout: 8000,
          headers: { 'Accept': 'application/json' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const image = data.image || '';
        const ticketMatch = image.match(/([A-Z]+-\d+)/);
        return {
          ...env,
          image,
          ticketId: ticketMatch ? ticketMatch[1] : null,
          error: null,
        };
      } catch (err) {
        return { ...env, image: null, ticketId: null, error: err.message };
      }
    })
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
