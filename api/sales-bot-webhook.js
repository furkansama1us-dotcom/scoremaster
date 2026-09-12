// Webhook du bot conversationnel de vente Telegram (bot dédié, distinct de
// Postiz et du bot de parrainage — Telegram interdit d'avoir un webhook ET
// un polling actifs sur le même bot).
//
// Guide un client Telegram (avec ou sans compte sur l'app) à travers le
// choix d'un pack puis du mode de paiement (PayPal ou recharge PCS),
// jusqu'à la prise en charge par un admin. Rien n'est validé/payé
// automatiquement : tout part en notification Telegram privée
// (telegram_queue) pour une vérification manuelle, comme pour les
// commandes classiques du panier.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SALES_BOT_TOKEN = process.env.SALES_BOT_TOKEN;
const SALES_BOT_WEBHOOK_SECRET = process.env.SALES_BOT_WEBHOOK_SECRET;

const PACKS = {
    journalier: { label: 'SM Score Exact Journalier', price: 50, emoji: '⚡', pcsCards: '1 carte de 50€' },
    vip: { label: 'SM VIP+ (à vie)', price: 99.99, emoji: '👑', pcsCards: '1 carte de 100€' },
    hebdo: { label: 'SM Combiné Hebdo', price: 69.99, emoji: '🔥', pcsCards: '1 carte de 50€ + 1 carte de 20€ (total 70€)' }
};

const PCS_PURCHASE_LINK = 'https://dundle.com/fr/pcs/';

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

function paymentKeyboard() {
    return [
        [{ text: '💳 PayPal', callback_data: 'pay:paypal' }],
        [{ text: '🎫 Recharge PCS', callback_data: 'pay:pcs' }]
    ];
}

async function handleStart(chatId, from, startParam) {
    const preselectedKey = startParam && startParam.startsWith('pack_') ? startParam.slice(5) : null;
    const preselectedPack = preselectedKey && PACKS[preselectedKey] ? preselectedKey : null;

    await upsertConversation(chatId, {
        state: preselectedPack ? 'awaiting_payment' : 'awaiting_pack',
        pack_type: preselectedPack,
        telegram_username: from.username || null,
        telegram_name: [from.first_name, from.last_name].filter(Boolean).join(' ') || null
    });

    if (preselectedPack) {
        const pack = PACKS[preselectedPack];
        await sendMessage(chatId,
            `Bonjour et bienvenue chez <b>Score Master</b> ! 👋😊\n\nVous avez sélectionné le pack <b>${pack.label}</b> (${pack.price}€). Excellent choix ! 🎉\n\nComment souhaitez-vous régler ?`,
            paymentKeyboard()
        );
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
    await upsertConversation(chatId, { state: 'awaiting_payment', pack_type: packKey });
    await sendMessage(chatId,
        `Excellent choix ! 🎉 Le pack <b>${pack.label}</b> (${pack.price}€) va vous ouvrir les portes de nos meilleures analyses.\n\nComment souhaitez-vous régler ?`,
        paymentKeyboard()
    );
}

async function handlePaymentChoice(chatId, method, convo) {
    const pack = PACKS[convo.pack_type];
    const orderRef = generateOrderRef();

    if (method === 'paypal') {
        await upsertConversation(chatId, { state: 'done', payment_method: 'paypal', order_ref: orderRef });
        await sendMessage(chatId,
            `Parfait, merci ! 💳\n\nUn membre de notre équipe Score Master va vous contacter très rapidement pour finaliser le paiement PayPal.\n\nMerci pour votre confiance, à très vite ! 🙏`
        );
        await notifyAdmin(
            `💰 NOUVELLE DEMANDE (Bot Telegram)\n\nRéférence : ${orderRef}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\nPaiement : PayPal\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n\n➡️ Contacte le client sur Telegram pour finaliser.`
        );
    } else if (method === 'pcs') {
        await upsertConversation(chatId, { state: 'pcs_awaiting_admin', payment_method: 'pcs', order_ref: orderRef });
        const cardsAdvice = pack && pack.pcsCards ? `\n\nPour votre pack (${pack.price}€), prenez : <b>${pack.pcsCards}</b>.` : '';
        await sendMessage(chatId,
            `Très bon choix ! 🎫\n\nSi vous n'avez pas encore de carte de recharge PCS, vous pouvez en acheter une ici :\n${PCS_PURCHASE_LINK}${cardsAdvice}\n\nUne fois votre/vos carte(s) en main, un membre de notre équipe vous contactera directement pour finaliser et vérifier votre code ensemble. 😊`,
            [[{ text: '🔔 Relancer l\'admin', callback_data: 'pcs:relaunch' }]]
        );
        await notifyAdmin(
            `💰 NOUVELLE DEMANDE (Bot Telegram)\n\nRéférence : ${orderRef}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\nPaiement : Recharge PCS\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n\n➡️ Contacte le client sur Telegram pour vérifier son code ensemble et valider.`
        );
    }
}

async function handlePcsRelaunch(chatId, convo) {
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
        `🔔 RELANCE (${newCount}/3) — Bot Telegram\n\nRéférence : ${convo.order_ref || '?'}\nPack : ${pack ? pack.label : convo.pack_type}\nPaiement : Recharge PCS\n\n👤 ${convo.telegram_name || 'Sans nom'}${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''}\n💬 Chat ID : ${chatId}\n\n➡️ Le client attend toujours ton contact.`
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
            } else if (data.startsWith('pay:')) {
                const convo = await getConversation(chatId);
                if (convo && convo.state === 'awaiting_payment') {
                    await handlePaymentChoice(chatId, data.slice(4), convo);
                }
            } else if (data === 'pcs:relaunch') {
                const convo = await getConversation(chatId);
                if (convo && convo.state === 'pcs_awaiting_admin') {
                    await handlePcsRelaunch(chatId, convo);
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
            } else if (convo.state === 'done' || convo.state === 'pcs_awaiting_admin') {
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
