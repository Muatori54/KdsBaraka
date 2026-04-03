/* ═══════════════════════════════════════════════════════════
   KDS EL BARAKA — Frontend Logic
   SSE Client · Card Rendering · Audio · Timers
   ═══════════════════════════════════════════════════════════ */

(() => {
    'use strict';

    const grid = document.getElementById('grid');
    const emptyState = document.getElementById('empty-state');
    const counterNum = document.getElementById('counter-num');
    const clockEl = document.getElementById('clock');
    const btnTest = document.getElementById('btn-test');

    const orders = new Map();
    let audioCtx = null;

    // ── Audio ────────────────────────────────────
    function initAudio() {
        if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }

    function playBip() {
        initAudio();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        const now = audioCtx.currentTime;
        const osc1 = audioCtx.createOscillator();
        const g1 = audioCtx.createGain();
        osc1.type = 'sine'; osc1.frequency.value = 880;
        g1.gain.setValueAtTime(0.3, now);
        g1.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc1.connect(g1).connect(audioCtx.destination);
        osc1.start(now); osc1.stop(now + 0.2);
        const osc2 = audioCtx.createOscillator();
        const g2 = audioCtx.createGain();
        osc2.type = 'sine'; osc2.frequency.value = 1100;
        g2.gain.setValueAtTime(0.3, now + 0.18);
        g2.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
        osc2.connect(g2).connect(audioCtx.destination);
        osc2.start(now + 0.18); osc2.stop(now + 0.4);
    }

    document.addEventListener('click', () => initAudio(), { once: true });

    // ── Clock ────────────────────────────────────
    function updateClock() {
        clockEl.textContent = new Date().toLocaleTimeString('fr-FR', {
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        });
    }
    setInterval(updateClock, 1000);
    updateClock();

    // ── Counter ──────────────────────────────────
    function updateCounter() {
        counterNum.textContent = orders.size;
        emptyState.classList.toggle('hidden', orders.size > 0);
    }

    // ── Timer ────────────────────────────────────
    function fmtTimer(receivedAt) {
        const diff = Math.floor((Date.now() - new Date(receivedAt).getTime()) / 1000);
        const m = Math.floor(Math.max(0, diff) / 60);
        const s = Math.max(0, diff) % 60;
        return {
            text: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
            urgent: m >= 10
        };
    }

    // ── Helpers ──────────────────────────────────
    function esc(t) { const d = document.createElement('div'); d.textContent = t; return d.innerHTML; }

    // ── Card Builder ─────────────────────────────
    function buildCard(cmd) {
        const el = document.createElement('div');
        el.className = 'order-card highlight';
        el.id = `card-${cmd.id}`;

        const canalLow = (cmd.canal || '').toLowerCase();
        const isPhone = canalLow.includes('tél') || canalLow.includes('tel') || canalLow.includes('phone') || canalLow.includes('sofia') || canalLow.includes('adam');
        const badgeClass = isPhone ? 'phone' : 'local';
        const badgeIcon = isPhone ? '📞' : '🖥️';
        const badgeText = isPhone ? cmd.canal : 'Sur place';

        const recDate = new Date(cmd.received_at || cmd.timestamp);
        const timeStr = recDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        // Articles — NO individual prices
        const articlesHtml = (cmd.articles || []).map(a => `
      <li class="item">
        <span class="item-name">
          <span class="qty">${a.qte}x</span>
          ${esc(a.nom)}
        </span>
      </li>
    `).join('');

        // Details
        let details = '';
        if (cmd.sauces && cmd.sauces.length) {
            details += `<div class="detail"><span class="detail-icon">🌶️</span><span class="detail-lbl">Sauces :</span><span class="detail-val">${cmd.sauces.map(s => `<span class="tag">${esc(s)}</span>`).join('')}</span></div>`;
        }
        if (cmd.boisson) {
            details += `<div class="detail"><span class="detail-icon">🥤</span><span class="detail-lbl">Boisson :</span><span class="detail-val">${esc(cmd.boisson)}</span></div>`;
        }
        if (cmd.supplements && cmd.supplements.length) {
            details += `<div class="detail"><span class="detail-icon">➕</span><span class="detail-lbl">Suppl. :</span><span class="detail-val">${cmd.supplements.map(s => `<span class="tag">${esc(s)}</span>`).join('')}</span></div>`;
        }
        if (cmd.extras && cmd.extras.length) {
            details += `<div class="detail"><span class="detail-icon">⭐</span><span class="detail-lbl">Extras :</span><span class="detail-val">${cmd.extras.map(s => `<span class="tag">${esc(s)}</span>`).join('')}</span></div>`;
        }
        if (cmd.dessert) {
            details += `<div class="detail"><span class="detail-icon">🍰</span><span class="detail-lbl">Dessert :</span><span class="detail-val">${esc(cmd.dessert)}</span></div>`;
        }

        let clientHtml = '';
        if (cmd.nom_client) {
            clientHtml = `<div class="client-row"><span class="client-icon">👤</span><span class="detail-lbl">Client :</span><span class="client-name">${esc(cmd.nom_client)}</span></div>`;
        }

        el.innerHTML = `
      <div class="card-head">
        <span class="card-id">${esc(cmd.id)}</span>
        <span class="badge ${badgeClass}">${badgeIcon} ${esc(badgeText)}</span>
      </div>
      <div class="card-time">
        <span class="received">Reçue à ${timeStr}</span>
        <span class="timer" data-at="${cmd.received_at || cmd.timestamp}">
          <span class="timer-dot"></span>
          <span class="timer-text">00:00</span>
        </span>
      </div>
      <div class="card-body">
        <ul class="items">${articlesHtml}</ul>
      </div>
      ${details ? `<div class="card-details">${details}</div>` : ''}
      ${clientHtml}
      <div class="card-foot">
        <span class="total">${(cmd.total || 0).toFixed(2)}<span class="total-eur">€</span></span>
        <div class="actions">
          <button class="btn-cancel" data-id="${cmd.id}">✕ Annuler</button>
          <button class="btn-done" data-id="${cmd.id}">✓ Prêt</button>
        </div>
      </div>
    `;

        el.querySelector('.btn-done').addEventListener('click', () => markDone(cmd.id));
        el.querySelector('.btn-cancel').addEventListener('click', () => cancelOrder(cmd.id));
        return el;
    }

    // ── Order Management ─────────────────────────
    function addOrder(cmd, withSound) {
        if (orders.has(cmd.id)) return;
        const el = buildCard(cmd);
        const cards = grid.querySelectorAll('.order-card');
        const cmdTime = new Date(cmd.received_at || cmd.timestamp).getTime();
        let inserted = false;
        for (const c of cards) {
            const t = c.querySelector('.timer');
            if (t && new Date(t.dataset.at).getTime() > cmdTime) {
                grid.insertBefore(el, c); inserted = true; break;
            }
        }
        if (!inserted) grid.insertBefore(el, emptyState);

        const timerEl = el.querySelector('.timer');
        const timerText = el.querySelector('.timer-text');
        const interval = setInterval(() => {
            const { text, urgent } = fmtTimer(timerEl.dataset.at);
            timerText.textContent = text;
            timerEl.classList.toggle('urgent', urgent);
        }, 1000);

        orders.set(cmd.id, { cmd, el, interval });
        setTimeout(() => el.classList.remove('highlight'), 3000);
        if (withSound) playBip();
        updateCounter();
    }

    function removeOrder(id, type) {
        const order = orders.get(id);
        if (!order) return;
        clearInterval(order.interval);
        order.el.classList.add(type === 'done' ? 'done' : 'cancelled');
        setTimeout(() => { order.el.remove(); orders.delete(id); updateCounter(); }, type === 'done' ? 700 : 350);
    }

    async function markDone(id) {
        try { await fetch(`/api/commande/${id}`, { method: 'DELETE' }); removeOrder(id, 'done'); } catch (e) { console.error(e); }
    }

    async function cancelOrder(id) {
        try { await fetch(`/api/commande/${id}`, { method: 'DELETE' }); removeOrder(id, 'cancel'); } catch (e) { console.error(e); }
    }

    // ── SSE ──────────────────────────────────────
    function connectSSE() {
        const src = new EventSource('/api/events');
        src.onmessage = (evt) => {
            const data = JSON.parse(evt.data);
            if (data.type === 'init') (data.commandes || []).forEach(c => addOrder(c, false));
            else if (data.type === 'new') addOrder(data.commande, true);
            else if (data.type === 'remove') removeOrder(data.id, 'done');
        };
        src.onerror = () => { src.close(); setTimeout(connectSSE, 3000); };
    }

    // ── Test Button ──────────────────────────────
    btnTest.addEventListener('click', async () => {
        btnTest.disabled = true; btnTest.style.opacity = '0.5';
        try { await fetch('/api/test-commande'); } catch (e) { }
        setTimeout(() => { btnTest.disabled = false; btnTest.style.opacity = '1'; }, 400);
    });

    connectSSE();
})();
