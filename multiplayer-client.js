// =========================================================
// dy/dx МУЛЬТИПЛЕЕР — клиентская интеграция с Supabase (полная версия)
// Подключите ПОСЛЕ основного game-скрипта, перед </body>:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="multiplayer-client.js"></script>
// =========================================================

const SUPABASE_URL = 'https://kgtheatplbbknrddlqsq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtndGhlYXRwbGJia25yZGRscXNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxOTA4MjcsImV4cCI6MjEwMTc2NjgyN30.cklnXKo9SzIsNKLSqjztABKRnAtF6aMRnlxfM0w_S8s';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function getTelegramUser() {
    try {
        const tg = window.Telegram.WebApp;
        if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
            const u = tg.initDataUnsafe.user;
            return { id: String(u.id), username: u.username || u.first_name || 'Игрок', avatar_url: u.photo_url || null };
        }
    } catch (e) {}
    let id = localStorage.getItem('dydx_fallback_id');
    if (!id) { id = 'guest_' + Math.floor(Math.random() * 1000000); localStorage.setItem('dydx_fallback_id', id); }
    return { id, username: 'Гость', avatar_url: null };
}

const ME = getTelegramUser();

window.Multiplayer = {
    ME, channel: null, advanceTimer: null,
    roundState: null,          // crash
    arenaState: null, arenaBets: [],
    rouletteState: null,
    durakRoomsChannel: null, durakRoomChannel: null, myDurakRoomId: null,
    dailyCd: null,

    async init() {
        await sb.from('users').upsert(
            { telegram_id: ME.id, username: ME.username, avatar_url: ME.avatar_url },
            { onConflict: 'telegram_id', ignoreDuplicates: true }
        );

        const bal = await this.getBalance();
        if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }

        // Каждые 500мс: двигаем раунды вперёд + опрашиваем открытые "_public" окна состояния.
        // ВАЖНО: crash_state/arena_state/roulette_state — закрытые таблицы (чтобы никто не подсмотрел
        // исход заранее), поэтому Realtime на них подписаться нельзя — вместо этого опрашиваем
        // отдельные "_public" представления, где скрытые поля видны только после завершения раунда.
        this.advanceTimer = setInterval(async () => {
            sb.rpc('advance_crash_round');
            sb.rpc('advance_arena_round');
            sb.rpc('advance_roulette_round');

            const { data: cs } = await sb.from('crash_state_public').select('*').eq('id', 1).single();
            if (cs) this.onCrashUpdate(cs);
            const { data: as } = await sb.from('arena_state_public').select('*').eq('id', 1).single();
            if (as) this.onArenaUpdate(as);
            const { data: rs } = await sb.from('roulette_state_public').select('*').eq('id', 1).single();
            if (rs) this.onRouletteUpdate(rs);
        }, 500);

        this.channel = sb.channel('game-sync')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crash_bets' }, (p) => this.onCrashBet(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crash_bets' }, (p) => this.onCrashCashout(p.new))
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'arena_bets' }, () => this.refreshArenaBets())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'durak_rooms' }, (p) => this.onDurakRoomsChange(p))
            .subscribe();

        const { data: cs } = await sb.from('crash_state_public').select('*').eq('id', 1).single();
        if (cs) this.onCrashUpdate(cs);
        const { data: as } = await sb.from('arena_state_public').select('*').eq('id', 1).single();
        if (as) this.onArenaUpdate(as);
        const { data: rs } = await sb.from('roulette_state_public').select('*').eq('id', 1).single();
        if (rs) this.onRouletteUpdate(rs);

        this.refreshDailyStatus();
        this.refreshDurakRoomList();
        this.refreshMyNfts();
        this.refreshMarketListings();
        setInterval(() => this.refreshMarketListings(), 5000); // лента лотов обновляется каждые 5с
    },

    // ================= КРАШ (РАКЕТА) =================
    lastCrashSig: null, lastArenaSig: null, lastRouletteSig: null,
    onCrashUpdate(state) {
        this.roundState = state;
        const C = window.Crash; if (!C) return;
        let sig = `${state.status}|${state.start_at}|${state.next_round_at}`;
        if (sig === this.lastCrashSig) return; // ничего не изменилось — не дёргаем анимацию заново
        this.lastCrashSig = sig;
        if (state.status === 'waiting') C.syncWaiting(state.next_round_at);
        else if (state.status === 'flying') C.syncFlying(state.start_at);
        else if (state.status === 'crashed') C.syncCrashed(state.target_multiplier);
    },
    onCrashBet(bet) { window.App && window.App.toast(`${bet.username || 'Игрок'}: ставка ${bet.amount}`, ''); this.renderCrashFeed(); },
    onCrashCashout(bet) {
        if (bet.cashed_out_multiplier) window.App && window.App.toast(`${bet.username || 'Игрок'} забрал на ${Number(bet.cashed_out_multiplier).toFixed(2)}x`, 'success');
        this.renderCrashFeed();
    },
    async renderCrashFeed() {
        if (!this.roundState || !this.roundState.start_at) return;
        const { data } = await sb.from('crash_bets').select('*').eq('round_started_at', this.roundState.start_at).order('id', { ascending: false }).limit(20);
        const el = document.getElementById('crash-live-feed'); if (!el || !data) return;
        el.innerHTML = data.map(b => `<div class="live-bet-row">
            <span>${b.username || 'Игрок'}</span><span>${b.amount}</span>
            <span style="color:${b.cashed_out_multiplier ? 'var(--green)' : 'var(--text-muted)'}">${b.cashed_out_multiplier ? Number(b.cashed_out_multiplier).toFixed(2)+'x' : '...'}</span>
        </div>`).join('');
    },
    async placeBet(amount) {
        const { data, error } = await sb.rpc('place_bet', { p_telegram_id: ME.id, p_username: ME.username, p_amount: amount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка ставки', 'error'); return false; }
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        return true;
    },
    async cashOut() {
        if (!this.roundState || !this.roundState.start_at) return null;
        const { data, error } = await sb.rpc('cash_out', { p_telegram_id: ME.id, p_round_started_at: this.roundState.start_at });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Не удалось забрать', 'error'); return null; }
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        window.App.toast(`Забрано ${data[0].win_amount}!`, 'success');
        return data[0].win_amount;
    },

    // ================= АРЕНА =================
    async onArenaUpdate(state) {
        this.arenaState = state;
        await this.refreshArenaBets();
        if (window.ArenaUI) window.ArenaUI.render(state, this.arenaBets);
        let sig = `${state.status}|${state.join_deadline}|${state.winner_angle}`;
        if (sig === this.lastArenaSig) return;
        this.lastArenaSig = sig;
        if (state.status === 'spinning' && state.winner_angle !== null && window.ArenaUI) {
            window.ArenaUI.spinTo(Number(state.winner_angle));
        }
        if (state.status === 'finished' && state.winner_telegram_id) {
            const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
            let iWon = state.winner_telegram_id === ME.id;
            window.App.toast(iWon ? '🎉 Вы выиграли банк на Арене!' : 'Арена: победитель забрал банк', iWon ? 'success' : '');
        }
    },
    async refreshArenaBets() {
        if (!this.arenaState || !this.arenaState.join_deadline) { this.arenaBets = []; return; }
        const { data } = await sb.from('arena_bets').select('*').eq('round_key', this.arenaState.join_deadline).order('id');
        this.arenaBets = data || [];
        if (window.ArenaUI) window.ArenaUI.render(this.arenaState, this.arenaBets);
    },
    async arenaJoin(amount) {
        const { data, error } = await sb.rpc('arena_join', { p_telegram_id: ME.id, p_username: ME.username, p_avatar_url: ME.avatar_url, p_amount: amount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return false; }
        window.App.toast(data[0].message, 'success');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        return true;
    },

    // ================= МУЛЬТИПЛЕЕРНАЯ РУЛЕТКА =================
    onRouletteUpdate(state) {
        this.rouletteState = state;
        const R = window.Roulette; if (!R) return;
        let sig = `${state.status}|${state.join_deadline}|${state.winning_color}`;
        if (sig === this.lastRouletteSig) return;
        this.lastRouletteSig = sig;
        if (state.status === 'waiting') R.syncWaiting(state.join_deadline);
        else if (state.status === 'spinning') R.syncSpinning();
        else if (state.status === 'finished') R.syncFinished(state.winning_color);
    },
    async rouletteBet(color, amount) {
        const { data, error } = await sb.rpc('roulette_bet', { p_telegram_id: ME.id, p_username: ME.username, p_color: color, p_amount: amount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка ставки', 'error'); return false; }
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        return true;
    },

    // ================= ДУРАК =================
    async refreshDurakRoomList() {
        const { data } = await sb.from('durak_rooms').select('id, status, bet, host_username').eq('status', 'waiting').order('created_at', { ascending: false });
        if (window.DurakUI) window.DurakUI.renderRoomList(data || []);
    },
    onDurakRoomsChange(payload) {
        this.refreshDurakRoomList();
        if (this.myDurakRoomId && payload.new && payload.new.id === this.myDurakRoomId) {
            this.subscribeDurakRoom(this.myDurakRoomId, true);
        }
    },
    async durakCreateRoom(bet) {
        const { data, error } = await sb.rpc('durak_create_room', { p_host_id: ME.id, p_host_username: ME.username, p_bet: bet });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast('Комната создана, ждём соперника', 'success');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        this.myDurakRoomId = data[0].room_id;
        this.subscribeDurakRoom(data[0].room_id);
    },
    async durakJoinRoom(roomId) {
        const { data, error } = await sb.rpc('durak_join_room', { p_room_id: roomId, p_guest_id: ME.id, p_guest_username: ME.username });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Не удалось войти', 'error'); return; }
        window.App.toast('Игра началась!', 'success');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        this.myDurakRoomId = roomId;
        this.subscribeDurakRoom(roomId);
    },
    async subscribeDurakRoom(roomId, silent) {
        if (this.durakRoomChannel) sb.removeChannel(this.durakRoomChannel);
        const { data: room } = await sb.from('durak_rooms').select('*').eq('id', roomId).single();
        if (!room) return;
        const role = room.host_telegram_id === ME.id ? 'host' : room.guest_telegram_id === ME.id ? 'guest' : null;
        if (!role) return;
        if (!silent && window.DurakUI) window.DurakUI.enterTable(roomId, role);
        if (window.DurakUI) window.DurakUI.render(room);
        this.durakRoomChannel = sb.channel('durak-room-' + roomId)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'durak_rooms', filter: `id=eq.${roomId}` }, (p) => {
                if (window.DurakUI) window.DurakUI.render(p.new);
            })
            .subscribe();
    },
    async durakPlay(roomId, card) {
        const { data: room } = await sb.from('durak_rooms').select('attacker, host_telegram_id, guest_telegram_id, table_cards').eq('id', roomId).single();
        if (!room) return;
        const myRole = room.host_telegram_id === ME.id ? 'host' : 'guest';
        const isAttacker = room.attacker === myRole;
        let res;
        if (isAttacker) {
            res = await sb.rpc('durak_attack', { p_room_id: roomId, p_telegram_id: ME.id, p_card: card });
        } else {
            const undefended = (room.table_cards || []).find(p => !p.defend);
            if (!undefended) { window.App.toast('Нет карты для отбоя', 'error'); return; }
            res = await sb.rpc('durak_defend', { p_room_id: roomId, p_telegram_id: ME.id, p_attack_card: undefended.attack, p_defend_card: card });
        }
        const { data, error } = res;
        if (error || !data || !data[0].success) window.App.toast((data && data[0] && data[0].message) || 'Недопустимый ход', 'error');
    },
    async durakTake(roomId) {
        const { data, error } = await sb.rpc('durak_take', { p_room_id: roomId, p_telegram_id: ME.id });
        if (error || !data || !data[0].success) window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
    },
    async durakPass(roomId) {
        const { data, error } = await sb.rpc('durak_pass', { p_room_id: roomId, p_telegram_id: ME.id });
        if (error || !data || !data[0].success) window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
    },

    // ================= ПРОМОКОДЫ =================
    async redeemPromo(code) {
        if (!code || !code.trim()) return window.App.toast('Введите код', 'error');
        const { data, error } = await sb.rpc('redeem_promo', { p_code: code.trim().toUpperCase(), p_telegram_id: ME.id });
        if (error) { window.App.toast('Ошибка сети', 'error'); return; }
        const r = data[0];
        window.App.toast(r.message, r.success ? 'success' : 'error');
        if (r.success) { window.App.balance = Number(r.new_balance); window.App.updBalUI(); }
    },

    // ================= ЕЖЕДНЕВНЫЙ БОНУС =================
    async claimDaily() {
        const { data, error } = await sb.rpc('claim_daily_bonus', { p_telegram_id: ME.id });
        if (error) { window.App.toast('Ошибка сети', 'error'); return; }
        const r = data[0];
        window.App.toast(r.message, r.success ? 'success' : 'error');
        if (r.success) { window.App.balance = Number(r.new_balance); window.App.updBalUI(); }
        this.refreshDailyStatus(r.next_claim_at);
    },
    async refreshDailyStatus(knownNext) {
        let nextAt = knownNext;
        if (!nextAt) {
            const { data } = await sb.from('daily_claims').select('last_claimed_at').eq('telegram_id', ME.id).maybeSingle();
            if (data && data.last_claimed_at) nextAt = new Date(new Date(data.last_claimed_at).getTime() + 4*60*60*1000).toISOString();
        }
        const btn = document.getElementById('daily-bonus-btn'); if (!btn) return;
        if (this.dailyCd) clearInterval(this.dailyCd);
        const tick = () => {
            const rem = nextAt ? new Date(nextAt).getTime() - Date.now() : 0;
            if (rem <= 0) { btn.disabled = false; btn.innerText = '🎁 Забрать ежедневный бонус (2000)'; clearInterval(this.dailyCd); }
            else { btn.disabled = true; let m = Math.floor(rem/60000), s = Math.floor((rem%60000)/1000); btn.innerText = `⏳ Бонус через ${m}:${s.toString().padStart(2,'0')}`; }
        };
        tick(); this.dailyCd = setInterval(tick, 1000);
    },

    async getBalance() {
        const { data } = await sb.from('users').select('balance').eq('telegram_id', ME.id).single();
        return data ? Number(data.balance) : null;
    },

    // ================= МАРКЕТПЛЕЙС УЛУЧШЕННЫХ ПОДАРКОВ =================
    async upgradeGiftServer(gift, cost, baseRarity) {
        const { data, error } = await sb.rpc('upgrade_gift_server', {
            p_telegram_id: ME.id, p_username: ME.username,
            p_gift_id: gift.id, p_gift_name: gift.name, p_gift_emoji: gift.emoji, p_base_rarity: baseRarity
        });
        if (error || !data || !data[0].success) {
            window.App.toast((data && data[0] && data[0].message) || 'Ошибка апгрейда', 'error');
            return null;
        }
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        // забираем id только что созданного NFT (последний по времени у этого владельца с такими же трейтами)
        const { data: mine } = await sb.from('user_nfts').select('*').eq('owner_telegram_id', ME.id).order('id', { ascending: false }).limit(1);
        const created = mine && mine[0];
        return {
            nftId: created ? created.id : ('tmp_' + Date.now()),
            model: data[0].model, modelFilter: created ? created.model_filter : null, modelGlow: created ? created.model_glow : null,
            backdrop: data[0].backdrop, backdropGrad: data[0].backdrop_grad,
            pattern: data[0].pattern, patternSym: data[0].pattern_sym, tier: data[0].tier
        };
    },
    async refreshMyNfts() {
        const { data } = await sb.from('user_nfts').select('*').eq('owner_telegram_id', ME.id).order('id', { ascending: false });
        if (!data) return;
        window.Gifts.nftCollection = data.map(n => ({
            uid: n.id, giftId: n.gift_id, model: n.model, modelFilter: n.model_filter, modelGlow: n.model_glow,
            backdrop: n.backdrop, backdropGrad: n.backdrop_grad, pattern: n.pattern, patternSym: n.pattern_sym,
            tier: n.tier, ts: new Date(n.created_at).getTime()
        }));
        window.Gifts.render();
    },
    async refreshMarketListings() {
        const { data } = await sb.from('market_listings')
            .select('*, user_nfts(gift_name, gift_emoji, model, model_filter, backdrop, backdrop_grad, pattern, pattern_sym, tier)')
            .eq('status', 'active').order('created_at', { ascending: false });
        if (!data) return;
        const flat = data.map(l => ({
            id: l.id, seller_telegram_id: l.seller_telegram_id, seller_username: l.seller_username, price: l.price, status: l.status,
            gift_name: l.user_nfts ? l.user_nfts.gift_name : '?', gift_emoji: l.user_nfts ? l.user_nfts.gift_emoji : '🎁',
            model: l.user_nfts ? l.user_nfts.model : '', model_filter: l.user_nfts ? l.user_nfts.model_filter : 'none',
            backdrop: l.user_nfts ? l.user_nfts.backdrop : '', backdrop_grad: l.user_nfts ? l.user_nfts.backdrop_grad : '',
            pattern_sym: l.user_nfts ? l.user_nfts.pattern_sym : '', tier: l.user_nfts ? l.user_nfts.tier : 'common'
        }));
        if (window.MarketUI) window.MarketUI.setListings(flat);
    },
    async listNft(nftId, price) {
        const { data, error } = await sb.rpc('list_nft', { p_telegram_id: ME.id, p_nft_id: nftId, p_price: price });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast(data[0].message, 'success');
        this.refreshMyNfts(); this.refreshMarketListings();
    },
    async cancelListing(listingId) {
        const { data, error } = await sb.rpc('cancel_listing', { p_telegram_id: ME.id, p_listing_id: listingId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast(data[0].message, 'success');
        this.refreshMarketListings();
    },
    async buyNft(listingId) {
        const { data, error } = await sb.rpc('buy_nft', { p_telegram_id: ME.id, p_username: ME.username, p_listing_id: listingId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast(data[0].message, 'success');
        const bal = await this.getBalance(); if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }
        this.refreshMyNfts(); this.refreshMarketListings();
    }
};

window.addEventListener('load', () => window.Multiplayer.init());
