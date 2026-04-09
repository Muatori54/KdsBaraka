const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const SOFIA_TOKEN  = process.env.SOFIA_TOKEN  || 'echolink-sofia-2026';
const KDS_PASSWORD = process.env.KDS_PASSWORD || 'cuisine2026';

const DB_FILE = './commandes.json';

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) { console.log('⚠️ DB error:', e.message); }
  return { commandes: [], historique: [] };
}

function saveDB(data) {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }
  catch (e) { console.log('⚠️ Save error:', e.message); }
}

const db = loadDB();
let commandes = db.commandes || [];
let orderCounter = commandes.length + 1;
let sseClients = [];
console.log(`📂 ${commandes.length} commandes chargées`);

// ── MIDDLEWARE DE BASE ────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── FIX TOKEN SOFIA (API uniquement) ─────────────────────
function verifyToken(req, res, next) {
  const token = req.headers['x-sofia-token'];
  if (token !== SOFIA_TOKEN) {
    console.log(`❌ Token invalide: "${token}"`);
    return res.status(401).json({ error: 'Non autorisé' });
  }
  next();
}

// ── ROUTES API ────────────────────────────────────────────
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
    return Array.isArray(p) ? p : typeof p === 'object' ? [p] : [{ nom: val, qte: 1, prix: 0 }];
  } catch {
    return [{ nom: val, qte: 1, prix: 0 }];
  }
}

app.post('/api/commande', verifyToken, (req, res) => {
  const data = req.body;
  console.log('📦 Reçu:', JSON.stringify(data));

  const articles    = parseArticles(data.articles);
  const sauces      = parseField(data.sauces, []);
  const supplements = parseField(data.supplements, []);
  const extras      = parseField(data.extras, []);

  let total = parseFloat(String(data.total || '0').replace(/[€\s]/g, '').replace(',', '.')) || 0;
  if (total === 0 && articles.length > 0)
    total = articles.reduce((s, a) => s + (parseFloat(a.prix) || 0) * (parseInt(a.qte) || 1), 0);

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
  const dbData = loadDB();
  dbData.commandes = commandes;
  dbData.historique = dbData.historique || [];
  dbData.historique.unshift({ ...commande, saved_at: new Date().toISOString() });
  if (dbData.historique.length > 500) dbData.historique = dbData.historique.slice(0, 500);
  saveDB(dbData);

  broadcast({ type: 'new', commande });
  console.log(`✅ ${commande.id} sauvegardé`);
  res.status(201).json({ success: true, commande });
});

app.delete('/api/commande/:id', (req, res) => {
  const { id } = req.params;
  const index = commandes.findIndex(c => c.id === id);
  if (index === -1) return res.status(404).json({ error: 'Introuvable' });

  const dbData = loadDB();
  const h = dbData.historique?.find(c => c.id === id);
  if (h) h.statut = 'terminee';
  dbData.commandes = (dbData.commandes || []).filter(c => c.id !== id);
  saveDB(dbData);

  commandes.splice(index, 1);
  broadcast({ type: 'remove', id });
  console.log(`✅ ${id} terminé`);
  res.json({ success: true });
});

app.get('/api/commandes', (req, res) => res.json(commandes));

app.get('/api/historique', (req, res) => {
  res.json(loadDB().historique || []);
});

app.get('/api/test-commande', (req, res) => {
  const menus = [
    { nom: 'Menu Big Max', prix: 10 }, { nom: 'Menu Chicken Deluxe', prix: 11.50 },
    { nom: 'Menu Fish Burger', prix: 10.50 }, { nom: 'Tacos L', prix: 8 }, { nom: 'Tacos XL', prix: 10 }
  ];
  const sides = [
    { nom: 'Chicken Wings x6', prix: 6 }, { nom: 'Onion Rings x8', prix: 4.50 }, { nom: 'Nuggets x6', prix: 5 }
  ];
  const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
  const pickN = (arr, mn, mx) => [...arr].sort(() => .5 - Math.random()).slice(0, mn + Math.floor(Math.random() * (mx - mn + 1)));

  const main     = pick(menus);
  const articles = [{ nom: main.nom, qte: 1, prix: main.prix }];
  if (Math.random() > .4) { const s = pick(sides); articles.push({ nom: s.nom, qte: 1, prix: s.prix }); }

  const sauces      = pickN(['Algérienne','Samouraï','Ketchup','BBQ','Harissa'], 1, 3);
  const boisson     = pick(['Coca Cola 33cl','Fanta Orange 33cl','Sprite 33cl','Ice Tea 33cl']);
  const supplements = Math.random() > .5 ? pickN(['Cheddar','Bacon','Jalapeños'], 1, 2) : [];
  const dessert     = pick(['','','Sundae Caramel','Tiramisu','']);
  const total       = articles.reduce((s, a) => s + a.prix * a.qte, 0) + supplements.length + (dessert ? 3.5 : 0);

  const commande = {
    id: `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: new Date().toISOString(), received_at: new Date().toISOString(),
    articles, sauces, boisson, supplements, extras: [], dessert,
    total: Math.round(total * 100) / 100, nom_client: '', canal: 'téléphone', statut: 'active'
  };

  commandes.push(commande);
  const dbData = loadDB();
  dbData.commandes = commandes;
  dbData.historique = dbData.historique || [];
  dbData.historique.unshift({ ...commande, saved_at: new Date().toISOString() });
  if (dbData.historique.length > 500) dbData.historique = dbData.historique.slice(0, 500);
  saveDB(dbData);

  broadcast({ type: 'new', commande });
  console.log(`🧪 Test: ${commande.id}`);
  res.json({ success: true, commande });
});

// ── STATIC + AUTH KDS (après les routes API) ─────────────
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html') {
    const token = req.query.token;
    if (token !== KDS_PASSWORD) {
      return res.status(401).send(`
        <html><body style="font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f0f0f">
        <div style="background:#1a1a1a;padding:40px;border-radius:12px;text-align:center;color:#fff">
          <h2 style="color:#f5a623">🍔 KDS El Baraka</h2>
          <p style="color:#999;margin-bottom:20px">Acces cuisine requis</p>
          <form method="GET">
            <input type="password" name="token" placeholder="Mot de passe"
              style="padding:12px;border-radius:6px;border:1px solid #333;background:#111;color:#fff;width:220px;font-size:16px">
            <br><br>
            <button type="submit" style="padding:12px 28px;background:#f5a623;color:#000;border:none;border-radius:6px;cursor:pointer;font-weight:bold;font-size:16px">
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
  console.log(`🍔 KDS démarré sur le port ${PORT}`);
  console.log(`🌐 http://localhost:${PORT}/?token=${KDS_PASSWORD}`);
  console.log(`🔐 Token Sofia: ${SOFIA_TOKEN}`);
});
