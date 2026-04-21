const express = require('express');
const cors = require('cors');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

const SOFIA_TOKEN  = process.env.SOFIA_TOKEN  || 'echolink-sofia-2026';
const KDS_PASSWORD = process.env.KDS_PASSWORD || 'cuisine2026';
const ADMIN_TOKEN  = process.env.ADMIN_TOKEN  || 'echolink-admin-2026';

// ── UPSTASH REDIS ─────────────────────────────────────────────────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── HELPERS REDIS MULTI-RESTAURANTS ──────────────────────────────────────────
// Chaque restaurant a ses propres clés préfixées par son slug
// ex: kds:elbaraka:commandes:actives, kds:elbaraka:config, etc.

function keys(slug) {
  return {
    actives:    `kds:${slug}:commandes:actives`,
    historique: `kds:${slug}:commandes:historique`,
    menu:       `kds:${slug}:menu`,
    config:     `kds:${slug}:config`,
  };
}

// Rétrocompat : si les anciennes clés existent (kds:commandes:actives), 
// on les migre vers kds:elbaraka:* au premier accès
async function migrateOldKeys(slug) {
  if (slug !== 'elbaraka') return;
  const alreadyMigrated = await redis.get(`kds:${slug}:migrated`);
  if (alreadyMigrated) return;

  const oldActives    = await redis.get('kds:commandes:actives');
  const oldHistorique = await redis.get('kds:commandes:historique');

  if (oldActives)    await redis.set(keys(slug).actives,    oldActives);
  if (oldHistorique) await redis.set(keys(slug).historique, oldHistorique);
  await redis.set(`kds:${slug}:migrated`, '1');
  console.log(`✅ Migration Redis vers namespace ${slug} effectuée`);
}

async function loadCommandes(slug) {
  await migrateOldKeys(slug);
  try {
    const data = await redis.get(keys(slug).actives);
    return data ? (Array.isArray(data) ? data : JSON.parse(data)) : [];
  } catch { return []; }
}

async function saveCommandes(slug, commandes) {
  await redis.set(keys(slug).actives, JSON.stringify(commandes));
}

async function addToHistorique(slug, commande) {
  try {
    const data = await redis.get(keys(slug).historique);
    const hist = data ? (Array.isArray(data) ? data : JSON.parse(data)) : [];
    hist.push(commande);
    // Garder seulement les 500 dernières commandes
    const trimmed = hist.slice(-500);
    await redis.set(keys(slug).historique, JSON.stringify(trimmed));
  } catch(e) { console.error('Erreur historique:', e); }
}

async function loadConfig(slug) {
  try {
    const data = await redis.get(keys(slug).config);
    return data ? (typeof data === 'object' ? data : JSON.parse(data)) : null;
  } catch { return null; }
}

async function loadMenu(slug) {
  try {
    const data = await redis.get(keys(slug).menu);
    return data ? (Array.isArray(data) ? data : JSON.parse(data)) : [];
  } catch { return []; }
}

// ── SSE CLIENTS PAR RESTAURANT ───────────────────────────────────────────────
const sseClients = {}; // { slug: [res, res, ...] }

function getClients(slug) {
  if (!sseClients[slug]) sseClients[slug] = [];
  return sseClients[slug];
}

function broadcastToSlug(slug, data) {
  const clients = getClients(slug);
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(client => {
    try { client.write(payload); } catch(e) {}
  });
}

// ── MIDDLEWARES ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MIDDLEWARE AUTH SLUG ──────────────────────────────────────────────────────
// Vérifie que le restaurant existe via un token URL ou cookie simple
// Pour V1 : token URL (?token=xxx) ou password KDS
function authDashboard(req, res, next) {
  const { slug } = req.params;
  const token = req.query.token || req.headers['x-dashboard-token'];
  // Pour V1 on accepte le KDS_PASSWORD ou un token par restaurant
  // En prod on stockerait le token dans Redis config
  if (!token || token !== KDS_PASSWORD) {
    return res.status(401).send('Accès non autorisé. Ajoutez ?token=VOTRE_TOKEN à l\'URL.');
  }
  req.slug = slug;
  next();
}

function authAdmin(req, res, next) {
  const token = req.query.token || req.headers['x-admin-token'];
  if (!token || token !== ADMIN_TOKEN) {
    return res.status(401).send('Accès admin non autorisé.');
  }
  next();
}

// ════════════════════════════════════════════════════════════════════════════
// ── ROUTES EXISTANTES — NE PAS TOUCHER ──────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// Webhook Make.com → commande entrant (compatible rétrocompat elbaraka)
app.post('/api/commande', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== `Bearer ${SOFIA_TOKEN}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const { articles, total, horodatage, restaurant_slug } = req.body;
  const slug = restaurant_slug || 'elbaraka'; // rétrocompat

  if (!articles || !Array.isArray(articles)) {
    return res.status(400).json({ error: 'Articles manquants ou invalides' });
  }

  const commande = {
    id: Date.now().toString(),
    articles,
    total: total || articles.reduce((s, a) => {
      const m = String(a).match(/(\d+(?:[.,]\d+)?)\s*(?:EUR|€)/i);
      return s + (m ? parseFloat(m[1].replace(',', '.')) : 0);
    }, 0),
    horodatage: horodatage || new Date().toISOString(),
    statut: 'active',
    slug,
  };

  const commandes = await loadCommandes(slug);
  commandes.push(commande);
  await saveCommandes(slug, commandes);
  await addToHistorique(slug, commande);

  broadcastToSlug(slug, { type: 'nouvelle_commande', commande });
  console.log(`📦 [${slug}] Commande reçue:`, commande.articles);
  res.json({ success: true, commande_id: commande.id });
});

// SSE rétrocompat (sans slug) → redirige vers elbaraka
app.get('/api/events', async (req, res) => {
  const password = req.query.password;
  if (password !== KDS_PASSWORD) return res.status(401).send('Non autorisé');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const slug = 'elbaraka';
  getClients(slug).push(res);

  const commandes = await loadCommandes(slug);
  res.write(`data: ${JSON.stringify({ type: 'init', commandes })}\n\n`);

  const hb = setInterval(() => res.write(': heartbeat\n\n'), 30000);
  req.on('close', () => {
    clearInterval(hb);
    const idx = getClients(slug).indexOf(res);
    if (idx > -1) getClients(slug).splice(idx, 1);
  });
});

// Test commande rétrocompat
app.get('/api/test-commande', async (req, res) => {
  const slug = 'elbaraka';
  const commande = {
    id: Date.now().toString(),
    articles: ['Menu Chicken Tandoori 9EUR', 'Coca Cola 2EUR'],
    total: 11,
    horodatage: new Date().toISOString(),
    statut: 'active',
    slug,
  };
  const commandes = await loadCommandes(slug);
  commandes.push(commande);
  await saveCommandes(slug, commandes);
  await addToHistorique(slug, commande);
  broadcastToSlug(slug, { type: 'nouvelle_commande', commande });
  res.json({ success: true, message: 'Commande test envoyée', commande });
});

// ════════════════════════════════════════════════════════════════════════════
// ── NOUVELLES ROUTES DASHBOARD SAAS ─────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════

// SSE par restaurant
app.get('/api/:slug/events', async (req, res) => {
  const { slug } = req.params;
  const password = req.query.password || req.query.token;
  if (password !== KDS_PASSWORD) return res.status(401).send('Non autorisé');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  getClients(slug).push(res);

  const commandes = await loadCommandes(slug);
  res.write(`data: ${JSON.stringify({ type: 'init', commandes })}\n\n`);

  const hb = setInterval(() => res.write(': heartbeat\n\n'), 30000);
  req.on('close', () => {
    clearInterval(hb);
    const idx = getClients(slug).indexOf(res);
    if (idx > -1) getClients(slug).splice(idx, 1);
  });
});

// Terminer une commande
app.post('/api/:slug/commandes/:id/terminer', async (req, res) => {
  const { slug, id } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const commandes = await loadCommandes(slug);
  const idx = commandes.findIndex(c => c.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Commande non trouvée' });

  commandes[idx].statut = 'terminee';
  commandes[idx].termineAt = new Date().toISOString();

  // Retirer des actives après 30s (on met juste le statut pour l'affichage)
  await saveCommandes(slug, commandes);
  broadcastToSlug(slug, { type: 'commande_terminee', commande_id: id });

  // Après 30s on purge des actives
  setTimeout(async () => {
    const fresh = await loadCommandes(slug);
    const filtered = fresh.filter(c => c.id !== id);
    await saveCommandes(slug, filtered);
    broadcastToSlug(slug, { type: 'commande_supprimee', commande_id: id });
  }, 30000);

  res.json({ success: true });
});

// Historique du restaurant
app.get('/api/:slug/historique', async (req, res) => {
  const { slug } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const hist = await redis.get(keys(slug).historique);
  const commandes = hist ? (Array.isArray(hist) ? hist : JSON.parse(hist)) : [];

  // Filtre par date si fourni (?date=2026-04-21)
  const { date } = req.query;
  const filtered = date
    ? commandes.filter(c => c.horodatage && c.horodatage.startsWith(date))
    : commandes;

  res.json({ commandes: filtered.reverse() });
});

// Analytics
app.get('/api/:slug/analytics', async (req, res) => {
  const { slug } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const hist = await redis.get(keys(slug).historique);
  const all = hist ? (Array.isArray(hist) ? hist : JSON.parse(hist)) : [];

  const today = new Date().toISOString().split('T')[0];
  const thisMonth = today.substring(0, 7);

  const todayOrders = all.filter(c => c.horodatage && c.horodatage.startsWith(today));
  const monthOrders = all.filter(c => c.horodatage && c.horodatage.startsWith(thisMonth));

  const caJour  = todayOrders.reduce((s, c) => s + (parseFloat(c.total) || 0), 0);
  const caMois  = monthOrders.reduce((s, c) => s + (parseFloat(c.total) || 0), 0);

  // Heure de pointe (tranche de 1h avec le plus de commandes aujourd'hui)
  const byHour = {};
  todayOrders.forEach(c => {
    const h = new Date(c.horodatage).getHours();
    byHour[h] = (byHour[h] || 0) + 1;
  });
  const peakHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];

  res.json({
    nb_commandes_jour: todayOrders.length,
    ca_jour: Math.round(caJour * 100) / 100,
    ca_mois: Math.round(caMois * 100) / 100,
    heure_pointe: peakHour ? `${peakHour[0]}h00` : null,
    nb_commandes_mois: monthOrders.length,
  });
});

// Récupérer le menu
app.get('/api/:slug/menu', async (req, res) => {
  const { slug } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const menu = await loadMenu(slug);
  res.json({ menu });
});

// Mettre à jour le menu
app.post('/api/:slug/menu', async (req, res) => {
  const { slug } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const { menu } = req.body;
  if (!Array.isArray(menu)) return res.status(400).json({ error: 'Menu invalide' });

  await redis.set(keys(slug).menu, JSON.stringify(menu));

  // TODO: sync ElevenLabs knowledge base via API
  // const elevenKey = process.env.ELEVENLABS_API_KEY;
  // ...

  res.json({ success: true, message: 'Menu mis à jour' });
});

// Config du restaurant
app.get('/api/:slug/config', async (req, res) => {
  const { slug } = req.params;
  const token = req.headers['x-dashboard-token'] || req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const config = await loadConfig(slug);
  res.json({ config: config || { slug, nom: slug, logo: null } });
});

// ── ROUTE ADMIN ───────────────────────────────────────────────────────────────
app.get('/api/admin/restaurants', authAdmin, async (req, res) => {
  // Lister tous les slugs connus (stockés dans une clé index)
  try {
    const slugsData = await redis.get('kds:restaurants:index');
    const slugs = slugsData ? JSON.parse(slugsData) : ['elbaraka'];
    
    const stats = await Promise.all(slugs.map(async (slug) => {
      const config = await loadConfig(slug);
      const hist = await redis.get(keys(slug).historique);
      const all = hist ? (Array.isArray(hist) ? hist : JSON.parse(hist)) : [];
      const today = new Date().toISOString().split('T')[0];
      const todayOrders = all.filter(c => c.horodatage && c.horodatage.startsWith(today));
      const caJour = todayOrders.reduce((s, c) => s + (parseFloat(c.total) || 0), 0);
      return {
        slug,
        nom: config?.nom || slug,
        nb_commandes_jour: todayOrders.length,
        ca_jour: Math.round(caJour * 100) / 100,
        actif: true,
      };
    }));

    res.json({ restaurants: stats });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Créer un nouveau restaurant (onboarding)
app.post('/api/admin/restaurants', authAdmin, async (req, res) => {
  const { slug, nom, numero_sofia, webhook_make } = req.body;
  if (!slug || !nom) return res.status(400).json({ error: 'slug et nom requis' });

  const config = { slug, nom, numero_sofia, webhook_make, cree_le: new Date().toISOString() };
  await redis.set(keys(slug).config, JSON.stringify(config));

  // Ajouter à l'index
  const slugsData = await redis.get('kds:restaurants:index');
  const slugs = slugsData ? JSON.parse(slugsData) : ['elbaraka'];
  if (!slugs.includes(slug)) {
    slugs.push(slug);
    await redis.set('kds:restaurants:index', JSON.stringify(slugs));
  }

  res.json({ success: true, message: `Restaurant ${nom} créé`, config });
});

// Test commande par slug
app.get('/api/:slug/test-commande', async (req, res) => {
  const { slug } = req.params;
  const token = req.query.token;
  if (token !== KDS_PASSWORD) return res.status(401).json({ error: 'Non autorisé' });

  const commande = {
    id: Date.now().toString(),
    articles: ['Menu Chicken Tandoori 9EUR', 'Coca Cola 2EUR'],
    total: 11,
    horodatage: new Date().toISOString(),
    statut: 'active',
    slug,
  };
  const commandes = await loadCommandes(slug);
  commandes.push(commande);
  await saveCommandes(slug, commandes);
  await addToHistorique(slug, commande);
  broadcastToSlug(slug, { type: 'nouvelle_commande', commande });
  res.json({ success: true, message: 'Commande test envoyée', commande });
});

// ── ROUTES DASHBOARD HTML ─────────────────────────────────────────────────────
// Sert le fichier dashboard.html pour toutes les routes /dashboard/*
app.get('/dashboard/:slug*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 Echo-Link KDS démarré sur le port ${PORT}`);
  console.log(`🗄️  Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'connecté' : '⚠️ URL manquante'}`);
  console.log(`📊 Dashboard: /dashboard/:slug?token=${KDS_PASSWORD}`);
});
