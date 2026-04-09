const express = require('express');
const cors = require('cors');
const path = require('path');
const { Redis } = require('@upstash/redis');

const app = express();
const PORT = process.env.PORT || 3000;

const SOFIA_TOKEN  = process.env.SOFIA_TOKEN  || 'echolink-sofia-2026';
const KDS_PASSWORD = process.env.KDS_PASSWORD || 'cuisine2026';

// ── UPSTASH REDIS ─────────────────────────────────────────
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const REDIS_KEY_ACTIVES   = 'kds:commandes:actives';
const REDIS_KEY_HISTORIQUE = 'kds:commandes:historique';

async function loadCommandes() {
  try {
    const data = await redis.get(REDIS_KEY_ACTIVES);
    return data ? (Array.isArray(data) ? data : JSON.parse(data)) : [];
  } catch (e) { console.log('⚠️ Redis load error:', e.message); return []; }
}

async function saveCommandes(commandes) {
  try { await redis.set(REDIS_KEY_ACTIVES, JSON.stringify(commandes)); }
  catch (e) { console.log('⚠️ Redis save error:', e.message); }
}

async function addToHistorique(commande) {
  try {
    await redis.lpush(REDIS_KEY_HISTORIQUE, JSON.stringify(commande));
    await redis.ltrim(REDIS_KEY_HISTORIQUE, 0, 499); // Garde 500 max
  } catch (e) { console.log('⚠️ Redis historique error:', e.message); }
}

async function getHistorique() {
  try {
    const items = await redis.lrange(REDIS_KEY_HISTORIQUE, 0, 499);
    return items.map(i => typeof i === 'string' ? JSON.parse(i) : i);
  } catch (e) { return []; }
}

// ── INIT ──────────────────────────────────────────────────
let commandes = [];
let orderCounter = 1;
let sseClients = [];

(async () => {
  commandes = await loadCommandes();
  orderCounter = commandes.length + 1;
  console.log(`📂 ${commandes.length} commandes actives chargées depuis Redis`);
})();

// ── MIDDLEWARE ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── TOKEN SOFIA ───────────────────────────────────────────
function verifyToken(req, res, next) {
  const token = req.headers['x-sofia-token'];
  if (token !== SOFIA_TOKEN) {
    console.log(`❌ Token invalide: "${token}"`);
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

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
  sseClients.forEach(c => c.write(`data: ${JSON.stringify(event)}\n\n`));
}

// ── HELPERS ───────────────────────────────────────────────
function parseField(val, def = []) {
  if (!val || val === 'Aucune' || val === 'Aucun' || val === '') return def;
  if (Array.isArray(val)) return val;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? p : [p];
  } catch {
    return String(val).split(',').map(s => s.trim()).filter(Boolean);
  }
}

function parseArticles(val) {
  if (!val || val === 'Aucun' || val === '') return [];
  if (Array.isArray(val)) return val;
  try {
    const p = JSON.parse(val);
    return Array.isArray(p) ? p : typeof p === 'object' ? [p] : [{ nom: String(val), qte: 1, prix: 0 }];
  } catch {
    return [{ nom: String(val), qte: 1, prix: 0 }];
  }
}

function extractPrix(nom) {
  const match = String(nom).match(/(\d+[.,]?\d*)\s*(?:€|EUR|euro)/i);
  return match ? parseFloat(match[1].replace(',', '.')) : 0;
}

// ── POST /api/commande ────────────────────────────────────
app.post('/api/commande', verifyToken, async (req, res) => {
  const data = req.body;
  console.log('📦 Reçu:', JSON.stringify(data));

  const articles    = parseArticles(data.articles);
  const sauces      = parseField(data.sauces, []);
  const supplements = parseField(data.supplements, []);
  const extras      = parseField(data.extras, []);

  // Parse total
  let total = parseFloat(String(data.total || '0').replace(/[€\sEUReur]/gi, '').replace(',', '.').trim()) || 0;

  // Fallback 1 : depuis les prix articles
  if (total === 0 && articles.length > 0) {
    total = articles.reduce((s, a) => s + (parseFloat(a.prix) || 0) * (parseInt(a.qte) || 1), 0);
  }

  // Fallback 2 : extraire depuis le nom ("Menu Big Max 10EUR")
  if (total === 0 && articles.length > 0) {
    articles.forEach(a => { if (!a.prix || a.prix === 0) a.prix = extractPrix(a.nom); });
    total = articles.reduce((s, a) => s + (parseFloat(a.prix) || 0) * (parseInt(a.qte) || 1), 0);
  }

  const commande = {
    id: data.commande_id || `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: data.timestamp || new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles, sauces,
    boisson: (data.boisson && data.boisson !== 'Aucune') ? data.boisson : '',
    supplements, extras,
    dessert: data.dessert || '',
    total: Math.round(total * 100) / 100,
    nom_client: data.nom_client || '',
    canal: data.canal || 'téléphone',
    statut: 'active'
  };

  commandes.push(commande);
  await saveCommandes(commandes);
  await addToHistorique(commande);

  broadcast({ type: 'new', commande });
  console.log(`✅ ${commande.id} — ${commande.total}€ — sauvegardé Redis`);
  res.status(201).json({ success: true, commande });
});

// ── DELETE /api/commande/:id ──────────────────────────────
app.delete('/api/commande/:id', async (req, res) => {
  const { id } = req.params;
  const index = commandes.findIndex(c => c.id === id);
  if (index === -1) return res.status(404).json({ error: 'Introuvable' });

  commandes.splice(index, 1);
  await saveCommandes(commandes);

  broadcast({ type: 'remove', id });
  console.log(`✅ ${id} terminé`);
  res.json({ success: true });
});

// ── GET /api/commandes ────────────────────────────────────
app.get('/api/commandes', (req, res) => res.json(commandes));

// ── GET /api/historique ───────────────────────────────────
app.get('/api/historique', async (req, res) => {
  res.json(await getHistorique());
});

// ── GET /api/test-commande ────────────────────────────────
app.get('/api/test-commande', async (req, res) => {
  const menus = [
    { nom: 'Menu Big Max', prix: 10 },
    { nom: 'Menu Chicken Deluxe', prix: 11.50 },
    { nom: 'Menu Fish Burger', prix: 10.50 },
    { nom: 'Tacos L', prix: 8 },
    { nom: 'Tacos XL', prix: 10 },
    { nom: 'Menu Sandwich Tandoori', prix: 9 },
    { nom: 'Menu Sandwich Kefta', prix: 9 },
    { nom: 'Menu Sandwich Baraka 1', prix: 9.50 }
  ];
  const sides = [
    { nom: 'Chicken Wings x6', prix: 6 },
    { nom: 'Onion Rings x8', prix: 4.50 },
    { nom: 'Nuggets x6', prix: 5 },
    { nom: 'Frites', prix: 2.50 }
  ];
  const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
  const pickN = (arr, mn, mx) => [...arr].sort(() => .5 - Math.random())
    .slice(0, mn + Math.floor(Math.random() * (mx - mn + 1)));

  const main     = pick(menus);
  const articles = [{ nom: main.nom, qte: 1, prix: main.prix }];
  if (Math.random() > .4) {
    const s = pick(sides);
    articles.push({ nom: s.nom, qte: 1, prix: s.prix });
  }

  const sauces      = pickN(['Algérienne','Samouraï','Ketchup','BBQ','Harissa','Blanche'], 1, 3);
  const boisson     = pick(['Coca Cola 33cl','Fanta Orange 33cl','Sprite 33cl','Ice Tea 33cl','Oasis Tropical 33cl']);
  const supplements = Math.random() > .5 ? pickN(['Cheddar','Bacon','Jalapeños','Emmental'], 1, 2) : [];
  const dessert     = pick(['','','Tiramisu Oreo','Milkshake Vanille','Tarte aux Daims','']);
  const total       = articles.reduce((s, a) => s + a.prix * a.qte, 0)
                    + supplements.length * 1
                    + (dessert ? 3.5 : 0);

  const commande = {
    id: `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles, sauces, boisson, supplements,
    extras: [], dessert,
    total: Math.round(total * 100) / 100,
    nom_client: '', canal: 'téléphone / Sofia', statut: 'active'
  };

  commandes.push(commande);
  await saveCommandes(commandes);
  await addToHistorique(commande);

  broadcast({ type: 'new', commande });
  console.log(`🧪 Test: ${commande.id} — ${commande.total}€`);
  res.json({ success: true, commande });
});

// ── AUTH KDS ──────────────────────────────────────────────
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    if (req.query.token !== KDS_PASSWORD) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f">
        <div style="background:#1a1a1a;padding:40px;border-radius:12px;text-align:center;color:#fff">
          <h2 style="color:#f5a623">🍔 KDS El Baraka</h2>
          <p style="color:#999;margin-bottom:20px">Acces cuisine requis</p>
          <form method="GET">
            <input type="password" name="token" placeholder="Mot de passe"
              style="padding:12px;border-radius:6px;border:1px solid #333;background:#111;color:#fff;width:220px;font-size:16px">
            <br><br>
            <button type="submit"
              style="padding:12px 28px;background:#f5a623;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:16px">
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

// ── START ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🍔 KDS démarré — port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}/?token=${KDS_PASSWORD}`);
  console.log(`🔐 Sofia token: ${SOFIA_TOKEN}`);
  console.log(`🗄️  Redis: ${process.env.UPSTASH_REDIS_REST_URL ? 'connecté' : '⚠️ URL manquante'}`);
});
