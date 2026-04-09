const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// ── CONFIG SECURITE ───────────────────────────────────────
const SOFIA_TOKEN = process.env.SOFIA_TOKEN || 'echolink-sofia-2026';
const KDS_PASSWORD = process.env.KDS_PASSWORD || 'cuisine2026';

// ── SQLITE ────────────────────────────────────────────────
const db = new Database('./commandes.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS commandes (
    id TEXT PRIMARY KEY,
    timestamp TEXT,
    received_at TEXT,
    articles TEXT,
    sauces TEXT,
    boisson TEXT,
    supplements TEXT,
    extras TEXT,
    dessert TEXT,
    total REAL,
    nom_client TEXT,
    canal TEXT,
    statut TEXT DEFAULT 'active'
  )
`);

let commandes = db.prepare("SELECT * FROM commandes WHERE statut = 'active'").all().map(row => ({
  ...row,
  articles: JSON.parse(row.articles || '[]'),
  sauces: JSON.parse(row.sauces || '[]'),
  supplements: JSON.parse(row.supplements || '[]'),
  extras: JSON.parse(row.extras || '[]'),
}));

let sseClients = [];
let orderCounter = commandes.length + 1;
console.log(`📂 ${commandes.length} commandes actives chargées depuis SQLite`);

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// FIX 3 — Auth KDS via query param ?token=
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/' || req.path === '/index.html') {
    const token = req.query.token;
    if (token !== KDS_PASSWORD) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f">
        <div style="background:#1a1a1a;padding:40px;border-radius:12px;text-align:center;color:#fff">
          <h2 style="color:#f5a623">KDS El Baraka</h2>
          <p style="color:#999">Acces cuisine</p>
          <form method="GET">
            <input type="password" name="token" placeholder="Mot de passe"
              style="padding:10px;border-radius:6px;border:1px solid #333;background:#111;color:#fff;width:200px;margin:10px 0">
            <br><button type="submit"
              style="padding:10px 24px;background:#f5a623;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold">
              Entrer
            </button>
          </form>
        </div></body></html>
      `);
    }
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── SSE ───────────────────────────────────────────────────
app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'init', commandes })}\n\n`);
  sseClients.push(res);
  req.on('close', () => { sseClients = sseClients.filter(c => c !== res); });
});

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

// FIX 1 — Middleware token Sofia
function verifyToken(req, res, next) {
  const token = req.headers['x-sofia-token'];
  if (token !== SOFIA_TOKEN) {
    console.log(`❌ Token invalide: "${token}" — rejeté depuis ${req.ip}`);
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── HELPERS ───────────────────────────────────────────────
function parseField(val, defaultVal = []) {
  if (!val || val === 'Aucune' || val === 'Aucun' || val === '') return defaultVal;
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch (e) {
      return val.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return defaultVal;
}

function parseArticles(val) {
  if (!val || val === 'Aucun' || val === '') return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object') return [parsed];
    } catch (e) {
      return [{ nom: val, qte: 1, prix: 0 }];
    }
  }
  return [];
}

// ── POST /api/commande ────────────────────────────────────
app.post('/api/commande', verifyToken, (req, res) => {
  const data = req.body;
  console.log('📦 Commande reçue:', JSON.stringify(data, null, 2));

  const articles    = parseArticles(data.articles);
  const sauces      = parseField(data.sauces, []);
  const supplements = parseField(data.supplements, []);
  const extras      = parseField(data.extras, []);

  let totalRaw = String(data.total || '0').replace(/[€\s]/g, '').replace(',', '.').trim();
  let total = parseFloat(totalRaw) || 0;
  if (total === 0 && articles.length > 0) {
    total = articles.reduce((sum, a) => sum + (parseFloat(a.prix) || 0) * (parseInt(a.qte) || 1), 0);
  }

  const commande = {
    id: data.commande_id || `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: data.timestamp || new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles, sauces,
    boisson: data.boisson && data.boisson !== 'Aucune' ? data.boisson : '',
    supplements, extras,
    dessert: data.dessert || '',
    total: Math.round(total * 100) / 100,
    nom_client: data.nom_client || '',
    canal: data.canal || 'téléphone'
  };

  // FIX 2 — Sauvegarde SQLite
  db.prepare(`
    INSERT OR REPLACE INTO commandes
    (id, timestamp, received_at, articles, sauces, boisson, supplements, extras, dessert, total, nom_client, canal, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    commande.id, commande.timestamp, commande.received_at,
    JSON.stringify(commande.articles), JSON.stringify(commande.sauces),
    commande.boisson, JSON.stringify(commande.supplements),
    JSON.stringify(commande.extras), commande.dessert,
    commande.total, commande.nom_client, commande.canal
  );

  commandes.push(commande);
  broadcast({ type: 'new', commande });

  console.log(`✅ Commande sauvegardée (RAM + SQLite): ${commande.id}`);
  res.status(201).json({ success: true, commande });
});

// ── DELETE /api/commande/:id ──────────────────────────────
app.delete('/api/commande/:id', (req, res) => {
  const { id } = req.params;
  const index = commandes.findIndex(c => c.id === id);
  if (index === -1) return res.status(404).json({ error: 'Commande introuvable' });

  db.prepare("UPDATE commandes SET statut = 'terminee' WHERE id = ?").run(id);
  commandes.splice(index, 1);
  broadcast({ type: 'remove', id });

  console.log(`✅ Commande terminée: ${id}`);
  res.json({ success: true });
});

// ── GET /api/commandes ────────────────────────────────────
app.get('/api/commandes', (req, res) => { res.json(commandes); });

// ── GET /api/historique ───────────────────────────────────
app.get('/api/historique', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare("SELECT * FROM commandes WHERE received_at LIKE ? ORDER BY received_at DESC")
    .all(`${today}%`)
    .map(row => ({
      ...row,
      articles: JSON.parse(row.articles || '[]'),
      sauces: JSON.parse(row.sauces || '[]'),
      supplements: JSON.parse(row.supplements || '[]'),
      extras: JSON.parse(row.extras || '[]'),
    }));
  res.json(rows);
});

// ── GET /api/test-commande ────────────────────────────────
app.get('/api/test-commande', (req, res) => {
  const menus = [
    { nom: 'Menu Big Max', prix: 10.00 }, { nom: 'Menu Chicken Deluxe', prix: 11.50 },
    { nom: 'Menu Double Smash', prix: 12.00 }, { nom: 'Menu Fish Burger', prix: 10.50 },
    { nom: 'Tacos L', prix: 8.00 }, { nom: 'Tacos XL', prix: 10.00 }
  ];
  const sides = [
    { nom: 'Chicken Wings x6', prix: 6.00 }, { nom: 'Onion Rings x8', prix: 4.50 },
    { nom: 'Frites Supplément', prix: 3.00 }, { nom: 'Nuggets x6', prix: 5.00 }
  ];
  const sauceOpts   = ['Algérienne', 'Samouraï', 'Ketchup', 'Mayonnaise', 'BBQ', 'Harissa'];
  const boissonOpts = ['Coca Cola 33cl', 'Fanta Orange 33cl', 'Sprite 33cl', 'Ice Tea 33cl'];
  const suppOpts    = ['Cheddar', 'Bacon', 'Double Viande', 'Jalapeños'];
  const dessertOpts = ['', '', 'Sundae Caramel', 'Tiramisu', ''];

  const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
  const pickN = (arr, min, max) => {
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    return [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
  };

  const main     = pick(menus);
  const articles = [{ nom: main.nom, qte: 1, prix: main.prix }];
  if (Math.random() > 0.4) { const s = pick(sides); articles.push({ nom: s.nom, qte: 1, prix: s.prix }); }

  const sauces      = pickN(sauceOpts, 1, 3);
  const boisson     = pick(boissonOpts);
  const supplements = Math.random() > 0.5 ? pickN(suppOpts, 1, 2) : [];
  const dessert     = pick(dessertOpts);
  const total       = articles.reduce((s, a) => s + a.prix * a.qte, 0) + supplements.length + (dessert ? 3.50 : 0);

  const commande = {
    id: `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles, sauces, boisson, supplements,
    extras: [], dessert,
    total: Math.round(total * 100) / 100,
    nom_client: '', canal: 'téléphone'
  };

  db.prepare(`
    INSERT OR REPLACE INTO commandes
    (id, timestamp, received_at, articles, sauces, boisson, supplements, extras, dessert, total, nom_client, canal, statut)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `).run(
    commande.id, commande.timestamp, commande.received_at,
    JSON.stringify(commande.articles), JSON.stringify(commande.sauces),
    commande.boisson, JSON.stringify(commande.supplements),
    JSON.stringify(commande.extras), commande.dessert,
    commande.total, commande.nom_client, commande.canal
  );

  commandes.push(commande);
  broadcast({ type: 'new', commande });
  console.log(`🧪 Test: ${commande.id}`);
  res.json({ success: true, commande });
});

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   🍔  KDS EL BARAKA — Kitchen Display       ║
  ║   🌐  http://localhost:${PORT}?token=cuisine2026 ║
  ║   📡  Webhook: POST /api/commande            ║
  ║   🔐  X-Sofia-Token requis                   ║
  ║   🗄️  SQLite: commandes.db                   ║
  ╚══════════════════════════════════════════════╝
  `);
});
