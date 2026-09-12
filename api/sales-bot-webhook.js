// Webhook du bot conversationnel de vente Telegram (bot dédié, distinct de
// Postiz et du bot de parrainage — Telegram interdit d'avoir un webhook ET
// un polling actifs sur le même bot).
//
// Guide un client Telegram (avec ou sans compte sur l'app) à travers le
// choix d'un pack, puis une confirmation d'adhésion, jusqu'à la prise en
// charge par un admin qui gère lui-même le paiement en message privé.
// Rien n'est validé/payé automatiquement : tout part en notification
// Telegram privée (telegram_queue) pour une prise en charge manuelle.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SALES_BOT_TOKEN = process.env.SALES_BOT_TOKEN;
const SALES_BOT_WEBHOOK_SECRET = process.env.SALES_BOT_WEBHOOK_SECRET;

const PACKS = {
    journalier: { label: 'SM Score Exact Journalier', price: 50, emoji: '⚡' },
    vip: { label: 'SM VIP+ (à vie)', price: 99.99, emoji: '👑' },
    hebdo: { label: 'SM Combiné Hebdo', price: 69.99, emoji: '🔥' }
};

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function tg(method, payload) {
    const res = await fetch(`https://api.telegram.org/bot${SALES_BOT_TOKEN}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!data.ok) console.error(`Telegram ${method} -> `, data);
    return data;
}

function sendMessage(chatId, text, keyboard) {
    return tg('sendMessage', Object.assign({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
    }, keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}));
}

function generateOrderRef() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 6; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return `SMB-${out}`;
}

async function getConversation(chatId) {
    const rows = await sbFetch(`bot_conversations?chat_id=eq.${chatId}&select=*`);
    return (rows && rows[0]) || null;
}

async function upsertConversation(chatId, patch) {
    const existing = await getConversation(chatId);
    const withTimestamp = Object.assign({}, patch, { updated_at: new Date().toISOString() });
    if (existing) {
        await sbFetch(`bot_conversations?chat_id=eq.${chatId}`, { method: 'PATCH', body: JSON.stringify(withTimestamp) });
    } else {
        const body = Object.assign({ chat_id: chatId }, withTimestamp);
        await sbFetch('bot_conversations', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([body]) });
    }
}

async function notifyAdmin(text) {
    await sbFetch('telegram_queue', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{ message: text }])
    });
}

function packKeyboard() {
    return Object.keys(PACKS).map(function (key) {
        var p = PACKS[key];
        return [{ text: `${p.emoji} ${p.label} — ${p.price}€`, callback_data: `pack:${key}` }];
    });
}

function joinKeyboard() {
    return [[{ text: '✅ J\'adhère maintenant !', callback_data: 'join' }]];
}

function relaunchKeyboard() {
    return [[{ text: '🔔 Relancer l\'admin', callback_data: 'relaunch' }]];
}

function platformKeyboard() {
    return [
        [{ text: 'Winamax', callback_data: 'platform:winamax' }, { text: 'Unibet', callback_data: 'platform:unibet' }],
        [{ text: 'Betclic', callback_data: 'platform:betclic' }, { text: 'PMU', callback_data: 'platform:pmu' }],
        [{ text: 'Bureau de tabac', callback_data: 'platform:tabac' }],
        [{ text: 'Autre / Aucune', callback_data: 'platform:autre' }]
    ];
}

function sportKeyboard() {
    return [
        [{ text: '⚽ Football', callback_data: 'sport:football' }, { text: '🏀 Basket', callback_data: 'sport:basket' }],
        [{ text: '🎾 Tennis', callback_data: 'sport:tennis' }, { text: '🥊 Autre sport', callback_data: 'sport:autre' }]
    ];
}

const PLATFORM_LABELS = {
    winamax: 'Winamax', unibet: 'Unibet', betclic: 'Betclic', pmu: 'PMU', tabac: 'Bureau de tabac', autre: 'Autre / Aucune'
};
const PLATFORM_REPLIES = {
    winamax: `Winamax, excellent choix ! 📈 Les cotes y sont généralement parmi les plus élevées du marché, tu as l'œil !`,
    unibet: `Unibet, un classique fiable et sérieux 👌, tu ne peux pas te tromper avec ça.`,
    betclic: `Betclic propose souvent de bons bonus de bienvenue 🎁, ça peut vite faire la différence sur la durée.`,
    pmu: `Le PMU, une valeur sûre pour les turfistes 🐎 ! Sache juste que les cotes foot y sont parfois un peu plus basses qu'ailleurs.`,
    tabac: `Le bureau de tabac, c'est pratique, mais tu passes souvent à côté des meilleures cotes en ligne. Si un jour tu veux te créer un compte sur une plateforme en ligne, n'hésite pas à demander, je peux te conseiller ! 😉`,
    autre: `Peu importe la plateforme, l'essentiel c'est d'avoir les bonnes infos avant de miser 💪`
};

const SPORT_LABELS = {
    football: 'Football', basket: 'Basket', tennis: 'Tennis', autre: 'Autre sport'
};
const SPORT_REPLIES = {
    football: `Le football, c'est justement notre spécialité chez Score Master ⚽🔥, tu es exactement au bon endroit !`,
    basket: `Le basket (NBA, Euroligue...) peut être très rentable avec la bonne analyse, on couvre aussi ce sport de près 🏀`,
    tennis: `Le tennis demande une vraie lecture fine des surfaces et de la forme du moment, un sport qu'on adore analyser aussi 🎾`,
    autre: `Peu importe le sport, l'important c'est la rigueur de l'analyse avant de miser 💪`
};

function hypeMessage(pack) {
    return `Tu as enfin décidé de passer au niveau supérieur, très bon choix ! 🔥\n\n`
        + `Chaque jour, des dizaines de membres de notre communauté <b>Score Master</b> encaissent grâce à nos analyses 📈💰. On ne te promet pas la lune : on te donne les tickets préparés par une équipe qui cumule plus de 20 ans d'expérience dans l'analyse sportive, avec une rigueur et une transparence qui font notre réputation depuis le début.\n\n`
        + `Tu es sur le point de rejoindre les centaines de membres qui nous font confiance au quotidien et qui vivent l'expérience Score Master de l'intérieur. 🙌\n\n`
        + `Pack sélectionné : <b>${pack.label}</b> (${pack.price}€)`;
}

async function handleStart(chatId, from, startParam) {
    const preselectedKey = startParam && startParam.startsWith('pack_') ? startParam.slice(5) : null;
    const preselectedPack = preselectedKey && PACKS[preselectedKey] ? preselectedKey : null;

    await upsertConversation(chatId, {
        state: preselectedPack ? 'awaiting_join' : 'awaiting_pack',
        pack_type: preselectedPack,
        telegram_username: from.username || null,
        telegram_name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null
    });

    if (preselectedPack) {
        await sendMessage(chatId, hypeMessage(PACKS[preselectedPack]), joinKeyboard());
    } else {
        await sendMessage(chatId,
            `Bonjour et bienvenue chez <b>Score Master</b> ! 👋😊\n\nRavi de vous accueillir. Quel pack vous intéresse aujourd'hui ?`,
            packKeyboard()
        );
    }
}

async function handlePackChoice(chatId, packKey) {
    const pack = PACKS[packKey];
    if (!pack) return;
    await upsertConversation(chatId, { state: 'awaiting_join', pack_type: packKey });
    await sendMessage(chatId, hypeMessage(pack), joinKeyboard());
}

async function safeUpsertConversation(chatId, patch) {
    try {
        await upsertConversation(chatId, patch);
    } catch (e) {
        console.error('upsertConversation failed (colonnes manquantes en base ?):', e);
    }
}

async function handleJoinConfirm(chatId, convo) {
    const pack = PACKS[convo.pack_type];
    const orderRef = generateOrderRef();
    await sendMessage(chatId,
        `Top ! Hâte de te voir parmi nous. 🙌\n\nUn admin se libère pour toi dans quelques instants. En attendant, j'ai deux petites questions pour mieux te connaître et t'orienter au mieux 😊\n\nSur quelle plateforme paries-tu d'habitude ? <i>(ça nous permet d'adapter nos conseils aux meilleures cotes disponibles chez toi)</i>`,
        platformKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_platform', order_ref: orderRef });
    await notifyAdmin(
        `💰 NOUVELLE DEMANDE (Bot Telegram)\n\nRéférence : ${orderRef}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n\n➡️ Le client vient de confirmer, il répond encore à quelques questions avant que je te notifie à nouveau avec plus de détails.`
    );
}

async function handlePlatformChoice(chatId, platformKey, convo) {
    const reply = PLATFORM_REPLIES[platformKey] || PLATFORM_REPLIES.autre;
    await sendMessage(chatId,
        `${reply}\n\nEt sinon, sur quel type de sport paries-tu le plus ? <i>(ça nous aide à te proposer des analyses bien plus pertinentes et ciblées, avec de meilleures cotes sur ton sport de prédilection)</i>`,
        sportKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_sport', betting_platform: PLATFORM_LABELS[platformKey] || platformKey });
}

async function handleSportChoice(chatId, sportKey, convo) {
    const pack = PACKS[convo.pack_type];
    const reply = SPORT_REPLIES[sportKey] || SPORT_REPLIES.autre;
    await sendMessage(chatId,
        `${reply}\n\nMerci pour ces questions et réponses aussi rapides ! 🙏 Je relance l'admin de mon côté !`,
        relaunchKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_admin', betting_sport: SPORT_LABELS[sportKey] || sportKey });
    await notifyAdmin(
        `✅ COMPLÉMENT DE DEMANDE (Bot Telegram)\n\nRéférence : ${convo.order_ref || '?'}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n\n🎯 Plateforme habituelle : ${convo.betting_platform || '?'}\n🏅 Sport favori : ${SPORT_LABELS[sportKey] || sportKey}\n\n➡️ Contacte le client sur Telegram pour finaliser le paiement.`
    );
}

async function handleRelaunch(chatId, convo) {
    const pack = PACKS[convo.pack_type];
    const count = convo.relaunch_count || 0;

    if (count >= 3) {
        await sendMessage(chatId, `Un membre de notre équipe va vous répondre très prochainement, merci de votre patience 🙏😊`);
        return;
    }

    if (convo.last_relaunch_at) {
        const elapsed = Date.now() - new Date(convo.last_relaunch_at).getTime();
        if (elapsed < 30000) {
            const remaining = Math.ceil((30000 - elapsed) / 1000);
            await sendMessage(chatId, `Merci de patienter encore ${remaining}s avant de relancer à nouveau 😊`);
            return;
        }
    }

    const newCount = count + 1;
    await upsertConversation(chatId, { relaunch_count: newCount, last_relaunch_at: new Date().toISOString() });
    await sendMessage(chatId, `C'est noté ! Un admin va vous contacter très vite. Merci de votre patience 🙏 (${newCount}/3)`);
    await notifyAdmin(
        `🔔 RELANCE (${newCount}/3) — Bot Telegram\n\nRéférence : ${convo.order_ref || '?'}\nPack : ${pack ? pack.label : convo.pack_type}\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n${convo.betting_platform ? `🎯 Plateforme habituelle : ${convo.betting_platform}\n` : ''}${convo.betting_sport ? `🏅 Sport favori : ${convo.betting_sport}\n` : ''}\n➡️ Le client attend toujours ton contact.`
    );
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(200).json({ ok: true });
    if (!SUPABASE_SERVICE_ROLE_KEY || !SALES_BOT_TOKEN) {
        console.error('Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, SALES_BOT_TOKEN).');
        return res.status(200).json({ ok: true });
    }
    if (SALES_BOT_WEBHOOK_SECRET) {
        const headerSecret = req.headers['x-telegram-bot-api-secret-token'];
        if (headerSecret !== SALES_BOT_WEBHOOK_SECRET) return res.status(401).json({ error: 'Secret invalide' });
    }

    try {
        const update = req.body || {};

        if (update.callback_query) {
            const cq = update.callback_query;
            const chatId = cq.message.chat.id;
            const data = cq.data || '';
            await tg('answerCallbackQuery', { callback_query_id: cq.id });

            if (data.startsWith('pack:')) {
                await handlePackChoice(chatId, data.slice(5));
            } else if (data === 'join') {
                const convo = await getConversation(chatId);
                if (convo && convo.state === 'awaiting_join') {
                    await handleJoinConfirm(chatId, convo);
                }
            } else if (data.startsWith('platform:')) {
                // Pas de vérification stricte de state ici : si l'écriture en base d'une
                // étape précédente a échoué (ex: colonnes manquantes), le state peut ne
                // pas avoir avancé alors que l'utilisateur, lui, a bien progressé dans le
                // fil de discussion — on se fie donc juste à l'existence de la conversation.
                const convo = await getConversation(chatId);
                if (convo) {
                    await handlePlatformChoice(chatId, data.slice(9), convo);
                }
            } else if (data.startsWith('sport:')) {
                const convo = await getConversation(chatId);
                if (convo) {
                    await handleSportChoice(chatId, data.slice(6), convo);
                }
            } else if (data === 'relaunch') {
                const convo = await getConversation(chatId);
                if (convo) {
                    await handleRelaunch(chatId, convo);
                }
            }
            return res.status(200).json({ ok: true });
        }

        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = (msg.text || '').trim();

            if (text === '/start' || text.startsWith('/start ')) {
                const startParam = text.startsWith('/start ') ? text.slice(7).trim() : null;
                await handleStart(chatId, msg.from, startParam);
                return res.status(200).json({ ok: true });
            }

            const convo = await getConversation(chatId);
            if (!convo) {
                await handleStart(chatId, msg.from);
            } else if (convo.state === 'awaiting_admin') {
                await sendMessage(chatId, `Un membre de notre équipe va vous répondre très vite, merci de patienter un instant 🙏😊`);
            } else {
                await sendMessage(chatId, `Merci de choisir une option ci-dessus 👆 pour continuer.`);
            }
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Erreur webhook sales bot:', error);
        res.status(200).json({ ok: true });
    }
};
