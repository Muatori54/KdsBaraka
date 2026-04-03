const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let commandes = [];
let sseClients = [];
let orderCounter = 1;

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write(`data: ${JSON.stringify({ type: 'init', commandes })}\n\n`);
  sseClients.push(res);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  sseClients.forEach(client => client.write(payload));
}

// ── Helper: convertit string ou tableau en tableau propre ──
function parseField(val, defaultVal = []) {
  if (!val || val === 'Aucune' || val === 'Aucun' || val === '') return defaultVal;
  if (Array.isArray(val)) return val;
  // Si c'est une string JSON, on essaie de la parser
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      return [parsed];
    } catch (e) {
      // Sinon on retourne la string dans un tableau
      return [val];
    }
  }
  return defaultVal;
}

// ── Helper: convertit articles string en tableau d'objets ──
function parseArticles(val) {
  if (!val || val === 'Aucun' || val === '') return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
      // Si c'est un objet unique
      if (typeof parsed === 'object') return [parsed];
    } catch (e) {
      // String simple comme "Sandwich Curry" → on crée un objet
      return [{ nom: val, qte: 1, prix: 0 }];
    }
  }
  return [];
}

// ── POST /api/commande ────────────────────────────────────
app.post('/api/commande', (req, res) => {
  const data = req.body;

  console.log('📦 Données reçues:', JSON.stringify(data, null, 2));

  const articles = parseArticles(data.articles);
  const sauces = parseField(data.sauces, []);
  const supplements = parseField(data.supplements, []);
  const extras = parseField(data.extras, []);

  // Total : depuis les articles ou depuis data.total
  let total = parseFloat(data.total) || 0;
  if (total === 0 && articles.length > 0) {
    total = articles.reduce((sum, a) => sum + (parseFloat(a.prix) || 0) * (parseInt(a.qte) || 1), 0);
  }

  const commande = {
    id: data.commande_id || `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: data.timestamp || new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles,
    sauces,
    boisson: data.boisson && data.boisson !== 'Aucune' ? data.boisson : '',
    supplements,
    extras,
    dessert: data.dessert || '',
    total: Math.round(total * 100) / 100,
    nom_client: data.nom_client || '',
    canal: data.canal || 'téléphone'
  };

  commandes.push(commande);
  broadcast({ type: 'new', commande });

  console.log(`✅ Commande enregistrée: ${commande.id} — Articles:`, commande.articles);
  res.status(201).json({ success: true, commande });
});

// ── DELETE /api/commande/:id ──────────────────────────────
app.delete('/api/commande/:id', (req, res) => {
  const { id } = req.params;
  const index = commandes.findIndex(c => c.id === id);

  if (index === -1) return res.status(404).json({ error: 'Commande introuvable' });

  commandes.splice(index, 1);
  broadcast({ type: 'remove', id });

  console.log(`🗑️  Commande supprimée: ${id}`);
  res.json({ success: true });
});

// ── GET /api/commandes ────────────────────────────────────
app.get('/api/commandes', (req, res) => {
  res.json(commandes);
});

// ── GET /api/test-commande ────────────────────────────────
app.get('/api/test-commande', (req, res) => {
  const menus = [
    { nom: 'Menu Big Max', prix: 10.00 },
    { nom: 'Menu Chicken Deluxe', prix: 11.50 },
    { nom: 'Menu Double Smash', prix: 12.00 },
    { nom: 'Menu Wrap Épicé', prix: 9.50 },
    { nom: 'Menu Fish Burger', prix: 10.50 },
    { nom: 'Tacos L', prix: 8.00 },
    { nom: 'Tacos XL', prix: 10.00 },
    { nom: 'Menu Nuggets x10', prix: 9.00 }
  ];

  const sides = [
    { nom: 'Chicken Wings x6', prix: 6.00 },
    { nom: 'Mozzarella Sticks x5', prix: 5.50 },
    { nom: 'Onion Rings x8', prix: 4.50 },
    { nom: 'Frites Supplément', prix: 3.00 },
    { nom: 'Nuggets x6', prix: 5.00 },
    { nom: 'Tenders x4', prix: 6.50 }
  ];

  const sauceOptions = ['Algérienne', 'Samouraï', 'Ketchup', 'Mayonnaise', 'BBQ', 'Biggy Burger', 'Harissa', 'Blanche'];
  const boissonOptions = ['Coca Cola 33cl', 'Fanta Orange 33cl', 'Sprite 33cl', 'Ice Tea 33cl', 'Eau 50cl', 'Oasis Tropical 33cl'];
  const supplementOptions = ['Cheddar', 'Bacon', 'Oeuf', 'Double Viande', 'Jalapeños'];
  const dessertOptions = ['', '', 'Sundae Caramel', 'Cookie Chocolat', 'Tiramisu', ''];

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const pickN = (arr, min, max) => {
    const n = Math.floor(Math.random() * (max - min + 1)) + min;
    return [...arr].sort(() => 0.5 - Math.random()).slice(0, n);
  };

  const mainItem = pick(menus);
  const articles = [{ nom: mainItem.nom, qte: 1, prix: mainItem.prix }];
  if (Math.random() > 0.4) {
    const side = pick(sides);
    articles.push({ nom: side.nom, qte: 1, prix: side.prix });
  }

  const sauces = pickN(sauceOptions, 1, 3);
  const boisson = pick(boissonOptions);
  const supplements = Math.random() > 0.5 ? pickN(supplementOptions, 1, 2) : [];
  const dessert = pick(dessertOptions);
  const total = articles.reduce((sum, a) => sum + a.prix * a.qte, 0) + supplements.length * 1.00 + (dessert ? 3.50 : 0);

  const commande = {
    id: `CMD-${String(orderCounter++).padStart(4, '0')}`,
    timestamp: new Date().toISOString(),
    received_at: new Date().toISOString(),
    articles,
    sauces,
    boisson,
    supplements,
    extras: [],
    dessert,
    total: Math.round(total * 100) / 100,
    nom_client: '',
    canal: 'téléphone'
  };

  commandes.push(commande);
  broadcast({ type: 'new', commande });

  console.log(`🧪 Commande test injectée: ${commande.id}`);
  res.json({ success: true, commande });
});

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════════╗
  ║   🍔  KDS EL BARAKA — Kitchen Display       ║
  ║   🌐  http://localhost:${PORT}                 ║
  ║   📡  Webhook: POST /api/commande            ║
  ║   🧪  Test:    GET  /api/test-commande        ║
  ╚══════════════════════════════════════════════╝
  `);
});
