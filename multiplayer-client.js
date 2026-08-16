// =========================================================
// dy/dx МУЛЬТИПЛЕЕР — клиентская интеграция с Supabase (полная версия)
// Подключите ПОСЛЕ основного game-скрипта, перед </body>:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="multiplayer-client.js"></script>
// =========================================================

const SUPABASE_URL = 'https://kgtheatplbbknrddlqsq.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtndGhlYXRwbGJia25yZGRscXNxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxOTA4MjcsImV4cCI6MjEwMTc2NjgyN30.cklnXKo9SzIsNKLSqjztABKRnAtF6aMRnlxfM0w_S8s';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sb = sb; // доступ из index.html (например, для модалки соглашения)

function getTelegramUser() {
    try {
        const tg = window.Telegram.WebApp;
        if (tg.initDataUnsafe && tg.initDataUnsafe.user) {
            const u = tg.initDataUnsafe.user;
            // Показываем НИК (имя из профиля Telegram), а не @username — так игроков
            // видно так же, как в самом Telegram, а не по техническому логину,
            // который у многих вообще не задан.
            let nick = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
            return { id: String(u.id), username: nick || u.username || 'Игрок', avatar_url: u.photo_url || null };
        }
    } catch (e) {}
    let id = localStorage.getItem('dydx_fallback_id');
    if (!id) { id = 'guest_' + Math.floor(Math.random() * 1000000); localStorage.setItem('dydx_fallback_id', id); }
    return { id, username: 'Гость', avatar_url: null };
}

const ME = getTelegramUser();
window.ME = ME; // доступ из index.html (например, чтобы Арена знала, участвует ли уже этот игрок)

window.Multiplayer = {
    ME, channel: null, advanceTimer: null,
    roundState: null,          // crash
    arenaState: null, arenaBets: [],
    rouletteState: null,
    durakRoomsChannel: null, durakRoomChannel: null, myDurakRoomId: null,
    dailyCd: null,

    async init() {
        // Только СОЗДАНИЕ новой записи — таблица users защищена от прямого UPDATE
        // с клиента (см. "revoke update on users" в схеме), это намеренно, чтобы
        // никто не мог накрутить себе баланс. Поэтому обновление ника/аватара для
        // уже существующих игроков идёт отдельным вызовом через защищённую
        // функцию update_profile() ниже — она меняет только username/avatar_url,
        // баланс не трогает вообще.
        await sb.from('users').upsert(
            { telegram_id: ME.id, username: ME.username, avatar_url: ME.avatar_url },
            { onConflict: 'telegram_id', ignoreDuplicates: true }
        );
        await sb.rpc('update_profile', { p_telegram_id: ME.id, p_username: ME.username, p_avatar_url: ME.avatar_url });

        // Реферальная система: если игру открыли по ссылке вида t.me/бот?start=12345,
        // Telegram сам подставляет "12345" сюда — это telegram_id того, кто позвал.
        // set_referrer() внутри сама следит, чтобы это сработало только один раз
        // за всю жизнь аккаунта (второй вызов просто вернёт "уже установлен").
        try {
            const tgApp = window.Telegram.WebApp;
            const startParam = tgApp.initDataUnsafe && tgApp.initDataUnsafe.start_param;
            if (startParam && /^\d+$/.test(startParam) && startParam !== ME.id) {
                await sb.rpc('set_referrer', { p_telegram_id: ME.id, p_referrer_id: startParam });
            }
        } catch (e) {}

        // Бан и соглашение — до старта остальной инициализации, чтобы никто не
        // успел поиграть в обход. Если колонки banned/tos_accepted_at ещё не
        // созданы (SQL не применён), select вернёт null вместо ошибки — тогда
        // просто пропускаем проверку, чтобы не сломать игру тем, кто ещё не
        // накатил файлы 11/12.
        try {
            const { data: urow } = await sb.from('users').select('banned, tos_accepted_at').eq('telegram_id', ME.id).single();
            if (urow && urow.banned) {
                document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#e74c3c;font-weight:700;text-align:center;padding:20px;">Аккаунт заблокирован администрацией</div>';
                return;
            }
            if (urow && !urow.tos_accepted_at) {
                const modal = document.getElementById('tos-modal');
                if (modal) modal.classList.add('active');
            }
        } catch (e) { /* колонки ещё не созданы — не блокируем игру */ }

        await this.flushPendingBalance();
        const bal = await this.getBalance();
        if (bal !== null) { window.App.balance = bal; window.App.updBalUI(); }

        // Раунды двигает СЕРВЕР (pg_cron -> процедура game_engine_tick), а не браузер.
        // Клиент теперь только ЧИТАЕТ состояние. Раунд идёт даже если не открыта
        // ни одна вкладка и ни одно приложение.
        // ВАЖНО: crash_state/arena_state/roulette_state — закрытые таблицы (чтобы никто не подсмотрел
        // исход заранее), поэтому Realtime на них подписаться нельзя — вместо этого опрашиваем
        // "_public" представления, где скрытые поля видны только после завершения раунда.
        this.advanceTimer = setInterval(() => this.pollGameState(), 500);

        this.channel = sb.channel('game-sync')
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'crash_bets' }, (p) => this.onCrashBet(p.new))
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'crash_bets' }, (p) => this.onCrashCashout(p.new))
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'arena_bets' }, () => this.refreshArenaBets())
            .on('postgres_changes', { event: '*', schema: 'public', table: 'durak_rooms' }, (p) => this.onDurakRoomsChange(p))
            .subscribe();

        await this.pollGameState();

        this.refreshDailyStatus();
        this.refreshDurakRoomList();
        this.startDurakLobbyPolling();
        this.refreshMyNfts();
        this.refreshMarketListings();
        this.refreshTycoon();
        this.refreshCrypto();
        this.refreshDrawBank();
        setInterval(() => this.refreshMarketListings(), 5000); // лента лотов обновляется каждые 5с
        setInterval(() => this.refreshTycoon(), 5000); // доход Империи — тоже раз в 5с
        setInterval(() => this.refreshCrypto(), 3000); // курс крипты — почаще, тик бота каждые 2с
        setInterval(() => this.refreshDrawBank(), 5000);
        // Раньше баланс сверялся с сервером ровно один раз при запуске и больше
        // никогда — если этот единственный запрос не проходил (например, сеть
        // моргнула при сворачивании приложения), рассинхрон с сервером мог
        // остаться навсегда. Теперь досверяемся регулярно — если что-то разошлось,
        // само себя поправит в течение нескольких секунд, а не будет висеть сломанным.
        setInterval(() => this.syncBalanceFromServer(), 8000);
    },

    // ================= ОПРОС СОСТОЯНИЯ =================
    // Один запрос вместо шести. Если функция get_game_state() ещё не создана
    // в базе (SQL не применён) — автоматически откатываемся на старый способ,
    // чтобы игра продолжала работать в любом случае.
    useCombinedState: true,

    // Разница между часами СЕРВЕРА и часами БРАУЗЕРА, в миллисекундах.
    // Нужна потому, что часы устройства (особенно в Telegram WebView,
    // эмуляторах, некоторых Android-прошивках) могут отставать или спешить
    // на несколько секунд. Ракета считает множитель как разницу между
    // "сейчас" и временем старта, полученным от сервера — если часы
    // браузера не совпадают с сервером, множитель посчитается неверно
    // (например, покажет 0.23x вместо честного 1.00x+ в первые доли секунды
    // полёта). serverNow() — это Date.now(), скорректированный на эту
    // разницу, и его нужно использовать вместо Date.now() везде, где время
    // сравнивается с временем от сервера (start_at, crash_at, next_round_at
    // и т.п.).
    clockOffsetMs: 0,
    serverNow() { return Date.now() + this.clockOffsetMs; },

    async pollGameState() {
        if (this.useCombinedState) {
            const { data: st, error } = await sb.rpc('get_game_state');
            if (!error && st) {
                if (st.server_now) this.clockOffsetMs = new Date(st.server_now).getTime() - Date.now();
                if (st.crash)    this.onCrashUpdate(st.crash);
                if (st.arena)    await this.onArenaUpdate(st.arena);
                if (st.roulette) this.onRouletteUpdate(st.roulette);
                return;
            }
            // функции нет — больше не пытаемся, работаем по-старому
            this.useCombinedState = false;
            console.warn('[dydx] get_game_state() недоступна, работаю по старой схеме. Примените 1-ДВИЖОК.sql');
        }
        const { data: csArr } = await sb.rpc('get_crash_state'); const cs = csArr && csArr[0];
        if (cs) this.onCrashUpdate(cs);
        const { data: asArr } = await sb.rpc('get_arena_state'); const as = asArr && asArr[0];
        if (as) await this.onArenaUpdate(as);
        const { data: rsArr } = await sb.rpc('get_roulette_state'); const rs = rsArr && rsArr[0];
        if (rs) this.onRouletteUpdate(rs);
    },

    // ================= КРАШ (РАКЕТА) =================
    lastCrashSig: null, lastArenaSig: null, lastRouletteSig: null,

    // Ключ текущего раунда Ракеты. round_key появляется после применения
    // 2-ФИКС-СТАВОК.sql; до этого откатываемся на start_at (старое поведение).
    crashRoundKey() {
        if (!this.roundState) return null;
        return this.roundState.round_key || this.roundState.start_at || null;
    },
    onCrashUpdate(state) {
        this.roundState = state;
        const C = window.Crash; if (!C) return;
        // Лента "ставки других игроков" раньше обновлялась ТОЛЬКО через Realtime-подписку,
        // а нужные таблицы никогда не были включены в публикацию realtime — подписка
        // тихо не срабатывала вообще ни у кого. Теперь дёргаем ленту на каждом обычном
        // опросе (2 раза в секунду) — это не зависит от настроек Realtime и работает
        // гарантированно. Вызываем ДО проверки dedup ниже, потому что новая ставка
        // может появиться, даже когда статус/start_at раунда не изменились.
        this.renderCrashFeed();
        let sig = `${state.status}|${state.start_at}|${state.next_round_at}`;
        if (sig === this.lastCrashSig) return; // анимацию заново не дёргаем — она уже идёт
        this.lastCrashSig = sig;
        if (state.status === 'waiting') C.syncWaiting(state.next_round_at);
        else if (state.status === 'flying') C.syncFlying(state.start_at);
        else if (state.status === 'crashed') C.syncCrashed(state.target_multiplier);
    },
    // Аварийный принудительный опрос — используется watchdog'ом в самой игре, если экран
    // залип (например вкладка была в фоне и браузер придержал таймеры). Сбрасывает дедупликацию,
    // чтобы новое состояние применилось гарантированно, даже если формально "не изменилось".
    async forceRefreshCrash() {
        // Раунд двигать не нужно — этим занят сервер. Просто перечитываем состояние.
        this.lastCrashSig = null;
        await this.pollGameState();
    },
    onCrashBet(bet) { window.App && window.App.toast(`${bet.username || 'Игрок'}: ставка ${bet.amount}`, ''); this.renderCrashFeed(); },
    onCrashCashout(bet) {
        if (bet.cashed_out_multiplier) window.App && window.App.toast(`${bet.username || 'Игрок'} забрал на ${Number(bet.cashed_out_multiplier).toFixed(2)}x`, 'success');
        this.renderCrashFeed();
    },
    async renderCrashFeed() {
        const key = this.crashRoundKey();
        if (!key) return;
        const { data } = await sb.from('crash_bets').select('*').eq('round_started_at', key).order('id', { ascending: false }).limit(20);
        const el = document.getElementById('crash-live-feed'); if (!el || !data) return;
        el.innerHTML = data.map(b => `<div class="live-bet-row">
            <span>${b.username || 'Игрок'}</span><span>${b.amount}</span>
            <span style="color:${b.cashed_out_multiplier ? 'var(--green)' : 'var(--text-muted)'}">${b.cashed_out_multiplier ? Number(b.cashed_out_multiplier).toFixed(2)+'x' : '...'}</span>
        </div>`).join('');
        // Мини-фича: бейдж самой крупной ставки раунда — считаем из уже
        // загруженных данных, отдельный запрос к серверу не нужен.
        const topEl = document.getElementById('crash-feed-top');
        if (topEl) {
            if (data.length) {
                const top = data.reduce((a, b) => Number(b.amount) > Number(a.amount) ? b : a, data[0]);
                topEl.innerText = `🔥 Топ ставка: ${top.username || 'Игрок'} — ${top.amount}`;
                topEl.style.display = '';
            } else {
                topEl.style.display = 'none';
            }
        }
    },
    async placeBet(amount) {
        const { data, error } = await sb.rpc('place_bet', { p_telegram_id: ME.id, p_username: ME.username, p_amount: amount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка ставки', 'error'); return false; }
        await this.syncBalanceFromServer();
        return true;
    },
    async cashOut() {
        const key = this.crashRoundKey();
        if (!key) return null;
        const { data, error } = await sb.rpc('cash_out', { p_telegram_id: ME.id, p_round_started_at: key });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Не удалось забрать', 'error'); return null; }
        await this.syncBalanceFromServer();
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
            await this.syncBalanceFromServer();
            let iWon = state.winner_telegram_id === ME.id;
            let winnerBet = this.arenaBets.find(b => b.telegram_id === state.winner_telegram_id);
            let winnerName = winnerBet ? (winnerBet.username || 'Игрок') : 'Игрок';
            window.App.toast(iWon ? '🎉 Вы выиграли банк на Арене!' : `Арена: банк забрал ${winnerName}`, iWon ? 'success' : '');
        }
    },
    async refreshArenaBets() {
        // round_key существует всегда (с момента открытия раунда), в отличие
        // от join_deadline — тот может быть null, пока не набралось 2 игрока.
        if (!this.arenaState || !this.arenaState.round_key) { this.arenaBets = []; return; }
        const { data } = await sb.from('arena_bets').select('*').eq('round_key', this.arenaState.round_key).order('id');
        this.arenaBets = data || [];
        if (window.ArenaUI) window.ArenaUI.render(this.arenaState, this.arenaBets);
    },
    _arenaJoinInFlight: false,
    async arenaJoin(amount) {
        // Доп. защита на уровне клиента модуля: даже если ArenaUI.join() будет
        // вызван откуда-то ещё в обход своего замка, второй параллельный вызов
        // arenaJoin() всё равно не уйдёт на сервер, пока первый не завершился.
        if (this._arenaJoinInFlight) return false;
        this._arenaJoinInFlight = true;
        try {
            const { data, error } = await sb.rpc('arena_join', { p_telegram_id: ME.id, p_username: ME.username, p_avatar_url: ME.avatar_url, p_amount: amount });
            if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return false; }
            window.App.toast(data[0].message, 'success');
            await this.syncBalanceFromServer();
            return true;
        } finally {
            this._arenaJoinInFlight = false;
        }
    },

    // ================= МУЛЬТИПЛЕЕРНАЯ РУЛЕТКА =================
    onRouletteUpdate(state) {
        this.rouletteState = state;
        const R = window.Roulette; if (!R) return;
        // Список ставок этого раунда — обновляем на каждом опросе (не только при
        // смене статуса), чтобы новые ставки других игроков появлялись сразу.
        this.renderRouletteBets(state.join_deadline);
        let sig = `${state.status}|${state.join_deadline}|${state.winning_color}`;
        if (sig === this.lastRouletteSig) return;
        this.lastRouletteSig = sig;
        if (state.status === 'waiting') R.syncWaiting(state.join_deadline);
        else if (state.status === 'spinning') R.syncSpinning(state.winning_color);
        else if (state.status === 'finished') R.syncFinished(state.winning_color);
    },
    async renderRouletteBets(roundKey) {
        if (!roundKey) return;
        const { data } = await sb.from('roulette_bets').select('*').eq('round_key', roundKey).order('id', { ascending: false }).limit(30);
        const el = document.getElementById('roulette-bets-list'); if (!el || !data) return;
        const colorRu = { red: 'красное', black: 'чёрное', green: 'зеро' };
        el.innerHTML = data.map(b => `<div class="live-bet-row">
            <span>${b.username || 'Игрок'}</span>
            <span style="color:${b.color === 'red' ? '#e74c3c' : b.color === 'black' ? '#ccc' : '#2ecc71'}">${colorRu[b.color] || b.color}</span>
            <span>${b.amount}</span>
        </div>`).join('');
    },
    async rouletteBet(color, amount) {
        const { data, error } = await sb.rpc('roulette_bet', { p_telegram_id: ME.id, p_username: ME.username, p_color: color, p_amount: amount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка ставки', 'error'); return false; }
        await this.syncBalanceFromServer();
        return true;
    },

    // ================= ДУРАК =================
    async refreshDurakRoomList() {
        const { data } = await sb.from('durak_rooms').select('id, status, bet, host_username').eq('status', 'waiting').order('created_at', { ascending: false });
        if (window.DurakUI) window.DurakUI.renderRoomList(data || []);
    },
    // Страховка: список комнат и сама партия раньше обновлялись ТОЛЬКО через
    // Realtime-подписку на durak_rooms, а эта таблица никогда не была включена
    // в публикацию realtime — то есть у Дурака в принципе не было способа узнать
    // о ходах соперника или новых комнатах. Включаем публикацию (см. SQL), и
    // ДОПОЛНИТЕЛЬНО держим лёгкий опрос как страховку — так игра работает,
    // даже если с realtime что-то не так на конкретном проекте.
    durakLobbyPollTimer: null,
    durakRoomPollTimer: null,
    startDurakLobbyPolling() {
        if (this.durakLobbyPollTimer) return;
        this.durakLobbyPollTimer = setInterval(() => this.refreshDurakRoomList(), 3000);
    },
    stopDurakRoomPolling() {
        if (this.durakRoomPollTimer) { clearInterval(this.durakRoomPollTimer); this.durakRoomPollTimer = null; }
        if (this.durakRoomChannel) { sb.removeChannel(this.durakRoomChannel); this.durakRoomChannel = null; }
        this.myDurakRoomId = null;
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
        await this.syncBalanceFromServer();
        this.myDurakRoomId = data[0].room_id;
        this.subscribeDurakRoom(data[0].room_id);
    },
    async durakJoinRoom(roomId) {
        const { data, error } = await sb.rpc('durak_join_room', { p_room_id: roomId, p_guest_id: ME.id, p_guest_username: ME.username });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Не удалось войти', 'error'); return; }
        window.App.toast('Игра началась!', 'success');
        await this.syncBalanceFromServer();
        this.myDurakRoomId = roomId;
        this.subscribeDurakRoom(roomId);
    },
    async subscribeDurakRoom(roomId, silent) {
        if (this.durakRoomChannel) sb.removeChannel(this.durakRoomChannel);
        if (this.durakRoomPollTimer) { clearInterval(this.durakRoomPollTimer); this.durakRoomPollTimer = null; }
        this.durakRoomLastUpdatedAt = null;
        const { data: room } = await sb.from('durak_rooms').select('*').eq('id', roomId).single();
        if (!room) return;
        const role = room.host_telegram_id === ME.id ? 'host' : room.guest_telegram_id === ME.id ? 'guest' : null;
        if (!role) return;
        if (!silent && window.DurakUI) window.DurakUI.enterTable(roomId, role);
        if (window.DurakUI) window.DurakUI.render(room);
        this.durakRoomLastUpdatedAt = room.updated_at;
        this.durakRoomChannel = sb.channel('durak-room-' + roomId)
            .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'durak_rooms', filter: `id=eq.${roomId}` }, (p) => {
                this.durakRoomLastUpdatedAt = p.new.updated_at;
                if (window.DurakUI) window.DurakUI.render(p.new);
            })
            .subscribe();
        // Страховка на случай, если Realtime по какой-то причине не доставит событие —
        // раз в секунду проверяем, не сменился ли updated_at, и если да, перерисовываем стол.
        this.durakRoomPollTimer = setInterval(async () => {
            const { data: r } = await sb.from('durak_rooms').select('*').eq('id', roomId).single();
            if (!r) return;
            if (r.updated_at === this.durakRoomLastUpdatedAt) return;
            this.durakRoomLastUpdatedAt = r.updated_at;
            if (window.DurakUI) window.DurakUI.render(r);
        }, 1000);
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
        await this.syncBalanceFromServer();
    },
    async durakPass(roomId) {
        const { data, error } = await sb.rpc('durak_pass', { p_room_id: roomId, p_telegram_id: ME.id });
        if (error || !data || !data[0].success) window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error');
        await this.syncBalanceFromServer();
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
        this.refreshDailyStatus();
    },
    // Раньше эта функция всё ещё считала по СТАРОЙ схеме "раз в 4 часа", хотя сама
    // логика начисления (claim_daily_bonus) давно работает по-новому — "300 фишек,
    // до 10 раз в день". Из-за этого кнопка блокировалась на 4 часа после первого
    // же клика, хотя на самом деле оставалось ещё 9 попыток — выглядело как "не
    // работает". Переписано под актуальную схему, без фейкового таймера.
    async refreshDailyStatus() {
        const { data } = await sb.from('daily_claims').select('claims_count, day_key').eq('telegram_id', ME.id).maybeSingle();
        let claimsLeft = 10;
        if (data && data.day_key) {
            const todayStr = new Date().toISOString().slice(0, 10);
            if (String(data.day_key).slice(0, 10) === todayStr) claimsLeft = Math.max(0, 10 - (data.claims_count || 0));
        }
        const btn = document.getElementById('daily-bonus-btn');
        const fab = document.getElementById('daily-bonus-fab');
        if (btn) {
            btn.disabled = claimsLeft <= 0;
            btn.innerText = claimsLeft > 0 ? `🎁 Забрать бонус (20) — ${claimsLeft}/10 сегодня` : '✅ На сегодня всё забрано';
        }
        if (fab) {
            fab.style.display = claimsLeft > 0 ? '' : 'none';
            fab.innerText = `🎁 +20 · ${claimsLeft}`;
        }
    },

    // Если предыдущий запуск приложения закрылся/обновился ДО того, как фоновая
    // отправка баланса (из App.syncDelta) успела долететь до сервера — сумма
    // осталась висеть в localStorage. Довысылаем её здесь, ДО того, как вообще
    // начинаем доверять ответу сервера — иначе баланс откатится к устаревшему
    // числу (та самая жалоба "при обновлении балик возвращается").
    async flushPendingBalance() {
        let pending = parseInt(localStorage.getItem('dydx_pending_delta') || '0', 10); if (isNaN(pending)) pending = 0;
        if (pending === 0) return;
        try {
            await sb.rpc('apply_balance_delta', { p_telegram_id: ME.id, p_delta: pending });
            localStorage.setItem('dydx_pending_delta', 0);
        } catch (e) { /* снова не долетело — останется в pending, попробуем при следующем запуске */ }
    },
    // Единая точка для "подтянуть баланс с сервера и показать" — раньше это было
    // разбросано по ~14 местам файла как отдельные копии одного и того же кода,
    // и только 2 из них проверяли, не летит ли ещё неподтверждённая фоновая
    // отправка (см. App.syncDelta) — остальные 12 могли перебить свежий локальный
    // выигрыш устаревшим серверным числом, пока отправка ещё в пути. Теперь
    // проверка в одном месте, и её точно не забудут в новом коде.
    async syncBalanceFromServer() {
        if (window.App && window.App._pendingSyncCount > 0) return null; // не перебиваем ещё не долетевшую отправку
        const bal = await this.getBalance();
        if (bal !== null && window.App) { window.App.balance = bal; window.App.updBalUI(); }
        return bal;
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
        await this.syncBalanceFromServer();
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
    async refreshDrawBank() {
        const { data, error } = await sb.from('draw_bank').select('balance').eq('id', 1).single();
        const el = document.getElementById('hub-draw-bank'); if (!el) return;
        el.innerText = (!error && data) ? data.balance.toLocaleString() + ' звёзд' : '—';
    },
    async refreshCrypto() {
        const { data, error } = await sb.rpc('crypto_get_state', { p_telegram_id: ME.id });
        if (error || !data) return;
        if (window.CryptoUI) window.CryptoUI.render(data);
    },
    _marketShopRequestId: 0,
    async refreshMarketShop() {
        const myRequestId = ++this._marketShopRequestId;
        const { data, error } = await sb.rpc('get_market_state', { p_telegram_id: ME.id });
        // Если за время ожидания ответа успел уйти ещё один (более новый) запрос —
        // этот ответ устарел, применять его нельзя (иначе иногда "теряются" гифты,
        // если ответы приходят не в том порядке, в котором ушли запросы).
        if (myRequestId !== this._marketShopRequestId) return;
        if (error || !data) return;
        if (window.Showcase) window.Showcase.setState(data);
        if (window.ProfileGifts) window.ProfileGifts.setState(data);
    },
    async refreshReferrals() {
        const { data, error } = await sb.rpc('get_referral_stats', { p_telegram_id: ME.id });
        if (error || !data) return;
        if (window.Referrals) window.Referrals.setState(data);
    },
    async buyMarketGift(catalogId) {
        const { data, error } = await sb.rpc('buy_market_gift', { p_telegram_id: ME.id, p_catalog_id: catalogId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return false; }
        window.App.toast(data[0].message, 'success');
        await this.syncBalanceFromServer();
        this.refreshMarketShop();
        return true;
    },
    async sellGift(inventoryId) {
        const { data, error } = await sb.rpc('sell_gift', { p_telegram_id: ME.id, p_inventory_id: inventoryId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return null; }
        window.App.toast(data[0].message, 'success');
        await this.syncBalanceFromServer();
        this.refreshMarketShop();
        return data[0];
    },
    async upgradeGiftModel(inventoryId) {
        const { data, error } = await sb.rpc('upgrade_gift_model', { p_telegram_id: ME.id, p_inventory_id: inventoryId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return null; }
        // Никакого toast с результатом тут — иначе апгрейд "спойлерится" текстом
        // ДО того, как отыграет анимация барабана. Сам результат уже пришёл в
        // data[0], им распорядится playSpinReveal после прокрутки.
        await this.syncBalanceFromServer();
        this.refreshMarketShop();
        return data[0];
    },
    async cryptoBuy(coinId, chipsAmount) {
        const { data, error } = await sb.rpc('crypto_buy', { p_telegram_id: ME.id, p_coin_id: coinId, p_chips_amount: chipsAmount });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast('Куплено!', 'success');
        await this.syncBalanceFromServer();
        this.refreshCrypto();
    },
    async cryptoSell(coinId, qty) {
        const { data, error } = await sb.rpc('crypto_sell', { p_telegram_id: ME.id, p_coin_id: coinId, p_qty: qty });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast(`Продано за ${data[0].proceeds} звёзд`, 'success');
        await this.syncBalanceFromServer();
        this.refreshCrypto();
    },
    async cryptoGetMyTrades() {
        const { data, error } = await sb.rpc('crypto_get_my_trades', { p_telegram_id: ME.id, p_limit: 30 });
        return (!error && data) ? data : [];
    },
    async refreshTycoon() {
        const { data, error } = await sb.rpc('tycoon_get_state', { p_telegram_id: ME.id });
        if (error || !data) return;
        if (window.TycoonUI) window.TycoonUI.render(data);
    },
    async tycoonBuy(buildingId) {
        const { data, error } = await sb.rpc('tycoon_buy', { p_telegram_id: ME.id, p_building_id: buildingId });
        if (error || !data || !data[0].success) { window.App.toast((data && data[0] && data[0].message) || 'Ошибка', 'error'); return; }
        window.App.toast(data[0].message, 'success');
        await this.syncBalanceFromServer();
        this.refreshTycoon();
    },
    async tycoonCollect() {
        const { data, error } = await sb.rpc('tycoon_collect', { p_telegram_id: ME.id });
        if (error || !data) { window.App.toast('Ошибка', 'error'); return; }
        if (!data[0].success) { window.App.toast(data[0].message || 'Пока нечего собирать', ''); return; }
        window.App.toast(`+${data[0].collected} звёзд!`, 'success');
        if (data[0].new_balance !== null) { window.App.balance = data[0].new_balance; window.App.updBalUI(); }
        this.refreshTycoon();
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
        await this.syncBalanceFromServer();
        this.refreshMyNfts(); this.refreshMarketListings();
    }
};

window.addEventListener('load', () => window.Multiplayer.init());

// Когда вкладка возвращается в фокус после того, как была скрыта (переключились в другое
// окно/приложение), браузер мог придержать таймеры — принудительно сверяемся с сервером сразу,
// не дожидаясь обычного цикла опроса.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && window.Multiplayer) {
        if (window.Multiplayer.forceRefreshCrash) window.Multiplayer.forceRefreshCrash();
        // Баланс тоже сверяем сразу — раньше это не делалось вообще, отсюда и была
        // жалоба "при сворачивании баланс обнулился до старого значения".
        window.Multiplayer.syncBalanceFromServer();
    }
});
