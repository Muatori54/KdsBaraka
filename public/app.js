/* ═══════════════════════════════════════════════
   KDS EL BARAKA — Frontend Logic
   SSE Client + Order Card Rendering + Audio
   ═══════════════════════════════════════════════ */

(() => {
    'use strict';

    // ── DOM Refs ─────────────────────────────────
    const grid = document.getElementById('orders-grid');
    const emptyState = document.getElementById('empty-state');
    const counterNum = document.getElementById('counter-number');
    const clockEl = document.getElementById('clock');
    const btnTest = document.getElementById('btn-add-test');

    // ── State ────────────────────────────────────
    let orders = new Map();   // id → { commande, element, interval }
    let audioCtx = null;

    // ── Audio Beep (AudioContext, no external file) ──
    function initAudio() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    function playBeep() {
        initAudio();
        if (audioCtx.state === 'suspended') audioCtx.resume();

        // Two-tone notification beep
        const now = audioCtx.currentTime;

        // First tone
        const osc1 = audioCtx.createOscillator();
        const gain1 = audioCtx.createGain();
        osc1.type = 'sine';
        osc1.frequency.value = 880;
        gain1.gain.setValueAtTime(0.3, now);
        gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc1.connect(gain1);
        gain1.connect(audioCtx.destination);
        osc1.start(now);
        osc1.stop(now + 0.15);

        // Second tone (higher)
        const osc2 = audioCtx.createOscillator();
        const gain2 = audioCtx.createGain();
        osc2.type = 'sine';
        osc2.frequency.value = 1100;
        gain2.gain.setValueAtTime(0.3, now + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
        osc2.connect(gain2);
        gain2.connect(audioCtx.destination);
        osc2.start(now + 0.15);
        osc2.stop(now + 0.35);
    }

    // ── Clock ────────────────────────────────────
    function updateClock() {
        const now = new Date();
        clockEl.textContent = now.toLocaleTimeString('fr-FR', {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
    }
    setInterval(updateClock, 1000);
    updateClock();

    // ── Counter ──────────────────────────────────
    function updateCounter() {
        const count = orders.size;
        counterNum.textContent = count;
        emptyState.classList.toggle('hidden', count > 0);
    }

    // ── Timer Formatting ─────────────────────────
    function formatTimer(receivedAt) {
        const diff = Math.floor((Date.now() - new Date(receivedAt).getTime()) / 1000);
        const m = Math.floor(diff / 60);
        const s = diff % 60;
        return {
            text: `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`,
            urgent: m >= 10
        };
    }

    // ── Build Card HTML ──────────────────────────
    function buildCard(cmd) {
        const card = document.createElement('div');
        card.className = 'order-card new-highlight';
        card.id = `card-${cmd.id}`;

        // Determine canal
        const isPhone = (cmd.canal || '').toLowerCase().includes('t') || (cmd.canal || '').toLowerCase().includes('phone');
        const canalClass = isPhone ? 'telephone' : 'surplace';
        const canalIcon = isPhone ? '📞' : '🖥️';
        const canalText = isPhone ? 'Téléphone' : 'Sur place';

        // Format received time
        const receivedDate = new Date(cmd.received_at || cmd.timestamp);
        const timeStr = receivedDate.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

        // Articles HTML
        const articlesHtml = (cmd.articles || []).map(a => `
      <li class="article-item">
        <span class="article-name">
          <span class="article-qty">${a.qte}x</span>
          ${escapeHtml(a.nom)}
        </span>
        <span class="article-price">${a.prix.toFixed(2)}€</span>
      </li>
    `).join('');

        // Details sections
        let detailsHtml = '';

        if (cmd.sauces && cmd.sauces.length > 0) {
            detailsHtml += `
        <div class="detail-row">
          <span class="detail-icon">🌶️</span>
          <span class="detail-label">Sauces:</span>
          <span class="detail-value">${cmd.sauces.map(s => `<span class="tag">${escapeHtml(s)}</span>`).join(' ')}</span>
        </div>`;
        }

        if (cmd.boisson) {
            detailsHtml += `
        <div class="detail-row">
          <span class="detail-icon">🥤</span>
          <span class="detail-label">Boisson:</span>
          <span class="detail-value">${escapeHtml(cmd.boisson)}</span>
        </div>`;
        }

        if (cmd.supplements && cmd.supplements.length > 0) {
            detailsHtml += `
        <div class="detail-row">
          <span class="detail-icon">➕</span>
          <span class="detail-label">Suppl.:</span>
          <span class="detail-value">${cmd.supplements.map(s => `<span class="tag">${escapeHtml(s)}</span>`).join(' ')}</span>
        </div>`;
        }

        if (cmd.extras && cmd.extras.length > 0) {
            detailsHtml += `
        <div class="detail-row">
          <span class="detail-icon">⭐</span>
          <span class="detail-label">Extras:</span>
          <span class="detail-value">${cmd.extras.map(s => `<span class="tag">${escapeHtml(s)}</span>`).join(' ')}</span>
        </div>`;
        }

        if (cmd.dessert) {
            detailsHtml += `
        <div class="detail-row">
          <span class="detail-icon">🍰</span>
          <span class="detail-label">Dessert:</span>
          <span class="detail-value">${escapeHtml(cmd.dessert)}</span>
        </div>`;
        }

        card.innerHTML = `
      <div class="card-header">
        <span class="card-id">${escapeHtml(cmd.id)}</span>
        <span class="canal-badge ${canalClass}">${canalIcon} ${canalText}</span>
      </div>
      <div class="card-timer-row">
        <span class="received-time">Reçue à ${timeStr}</span>
        <span class="timer" data-received="${cmd.received_at || cmd.timestamp}">00:00</span>
      </div>
      <div class="card-body">
        <ul class="articles-list">${articlesHtml}</ul>
      </div>
      ${detailsHtml ? `<div class="card-details">${detailsHtml}</div>` : ''}
      <div class="card-footer">
        <span class="total">${(cmd.total || 0).toFixed(2)}<span class="total-currency">€</span></span>
        <div class="card-actions">
          <button class="btn-cancel" data-id="${cmd.id}" title="Annuler la commande">✕ Annuler</button>
          <button class="btn-ready" data-id="${cmd.id}" title="Commande prête">✓ Prêt</button>
        </div>
      </div>
    `;

        // Event listeners
        card.querySelector('.btn-ready').addEventListener('click', () => markReady(cmd.id));
        card.querySelector('.btn-cancel').addEventListener('click', () => cancelOrder(cmd.id));

        return card;
    }

    // ── Escape HTML ──────────────────────────────
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ── Add Order to Grid ────────────────────────
    function addOrder(cmd, withSound = true) {
        if (orders.has(cmd.id)) return; // prevent duplicates

        const card = buildCard(cmd);

        // Insert before empty state, sorted by time (oldest first = at start)
        const existingCards = grid.querySelectorAll('.order-card');
        let inserted = false;

        const cmdTime = new Date(cmd.received_at || cmd.timestamp).getTime();

        for (const existing of existingCards) {
            const timerEl = existing.querySelector('.timer');
            if (timerEl) {
                const existingTime = new Date(timerEl.dataset.received).getTime();
                if (cmdTime < existingTime) {
                    grid.insertBefore(card, existing);
                    inserted = true;
                    break;
                }
            }
        }

        if (!inserted) {
            grid.insertBefore(card, emptyState);
        }

        // Timer interval
        const timerEl = card.querySelector('.timer');
        const interval = setInterval(() => {
            const { text, urgent } = formatTimer(timerEl.dataset.received);
            timerEl.textContent = text;
            timerEl.classList.toggle('urgent', urgent);
        }, 1000);

        orders.set(cmd.id, { commande: cmd, element: card, interval });

        // Remove highlight after 3s
        setTimeout(() => card.classList.remove('new-highlight'), 3000);

        // Sound
        if (withSound) {
            playBeep();
        }

        updateCounter();
    }

    // ── Remove Order ─────────────────────────────
    function removeOrder(id, animate = false) {
        const order = orders.get(id);
        if (!order) return;

        clearInterval(order.interval);

        if (animate) {
            order.element.classList.add('completed');
            setTimeout(() => {
                order.element.remove();
                orders.delete(id);
                updateCounter();
            }, 800);
        } else {
            order.element.remove();
            orders.delete(id);
            updateCounter();
        }
    }

    // ── Mark as Ready ────────────────────────────
    async function markReady(id) {
        try {
            await fetch(`/api/commande/${id}`, { method: 'DELETE' });
            removeOrder(id, true);
        } catch (e) {
            console.error('Error marking ready:', e);
        }
    }

    // ── Cancel Order ─────────────────────────────
    async function cancelOrder(id) {
        try {
            await fetch(`/api/commande/${id}`, { method: 'DELETE' });
            removeOrder(id, false);
        } catch (e) {
            console.error('Error cancelling:', e);
        }
    }

    // ── SSE Connection ───────────────────────────
    function connectSSE() {
        const evtSource = new EventSource('/api/events');

        evtSource.onmessage = (event) => {
            const data = JSON.parse(event.data);

            switch (data.type) {
                case 'init':
                    // Load all existing orders (no sound on init)
                    (data.commandes || []).forEach(cmd => addOrder(cmd, false));
                    break;

                case 'new':
                    addOrder(data.commande, true);
                    break;

                case 'remove':
                    removeOrder(data.id, true);
                    break;
            }
        };

        evtSource.onerror = () => {
            console.warn('SSE connection lost. Reconnecting in 3s...');
            evtSource.close();
            setTimeout(connectSSE, 3000);
        };
    }

    // ── Test Button ──────────────────────────────
    btnTest.addEventListener('click', async () => {
        btnTest.disabled = true;
        btnTest.style.opacity = '0.5';
        try {
            await fetch('/api/test-commande');
        } catch (e) {
            console.error('Error creating test order:', e);
        }
        setTimeout(() => {
            btnTest.disabled = false;
            btnTest.style.opacity = '1';
        }, 500);
    });

    // ── Init Audio on first interaction ──────────
    document.addEventListener('click', () => initAudio(), { once: true });

    // ── Start ────────────────────────────────────
    connectSSE();

})();
