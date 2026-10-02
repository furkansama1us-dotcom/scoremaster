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
// Chat Telegram personnel de l'admin AVEC CE BOT (pas le canal, pas un autre
// bot) -- récupéré via @userinfobot après avoir démarré une conversation avec
// le bot de vente. Permet un vrai aller-retour DANS Telegram : chaque message
// d'un lead est transféré ici, et répondre directement à ce message (fonction
// "Répondre" de Telegram) relaie la réponse au lead, sans jamais ouvrir l'app.
const SALES_ADMIN_CHAT_ID = process.env.SALES_ADMIN_CHAT_ID;

// Contenu des packs : identique aux cartes et au tableau comparatif de la page
// « Nos packs » de l'app. À tenir à jour ensemble.
const PACKS = {
    journalier: { label: 'SM Score Exact Journalier', price: 50, emoji: '⚡',
        features: ['1 score exact', 'Analyse détaillée', 'Support 7j/7', 'Annonce sur Telegram'] },
    vip: { label: 'SM VIP+ (à vie)', price: 99.99, emoji: '👑',
        features: ['Accès à vie', '1 combiné score exact chaque soir de match', 'Espace membre VIP+', 'Canal Telegram VIP', 'Priorité support',
            'Paris du jour SMVIP+ 🆕', 'Analyses IA des matchs 🆕', 'Suivi LIVE du combiné 🆕', 'Accès fondateurs ⭐'] },
    hebdo: { label: 'SM Combiné Hebdo', price: 69.99, emoji: '🔥',
        features: ['5 combinés score exact / semaine', 'Cotes élevées', 'Suivi LIVE du combiné 🆕', 'Canal Telegram', 'Support prioritaire', 'Récap hebdomadaire', 'Accès 7 jours'] }
};

// Informations consultables à tout moment depuis le menu du bot.
const INFOS = {
    comparer: `🔎 <b>Ce qui est inclus dans chaque pack</b>\n\n`
        + `⚡ <b>Journalier</b>\n• 1 score exact du jour\n• Analyse détaillée\n• Support 7j/7\n\n`
        + `🔥 <b>Hebdo</b> (7 jours)\n• 5 combinés score exact par semaine\n• Canal Telegram\n• Support prioritaire\n• Suivi LIVE du combiné 🆕\n\n`
        + `👑 <b>SM VIP+</b> (à vie)\n• 1 combiné score exact chaque soir de match\n• Canal Telegram VIP + priorité support\n• Suivi LIVE du combiné 🆕\n• Espace membre VIP+\n• Paris du jour SMVIP+ 🆕\n• Analyses IA des matchs 🆕\n• Accès fondateurs ⭐\n\n`
        + `👉 Le VIP+ est le seul pack qui réunit <b>toutes</b> les fonctionnalités, et il est valable à vie.`,
    nouveau: `🆕 <b>Les nouveautés Score Master</b>\n\n`
        + `🎯 <b>Paris du jour SMVIP+</b> <i>(VIP+)</i>\nChaque matin à partir de 9 h, notre IA sélectionne jusqu'à 3 paris du jour, validés par l'équipe. Ils s'affichent dans l'app (bouton doré en bas à droite), avec un historique où chaque résultat reste visible.\n\n`
        + `🧠 <b>Analyses IA des matchs</b> <i>(VIP+)</i>\nAprès les matchs : probabilités d'avant-match, prédiction de l'IA face au score réel, forces et faiblesses de chaque équipe.\n\n`
        + `📡 <b>Suivi LIVE du combiné</b> <i>(Hebdo et VIP+)</i>\nLe score de chaque match de ton combiné en direct, dans l'app.\n\n`
        + `🆓 <b>Pronostics AI</b> <i>(gratuit)</i>\nDes analyses automatiques des prochains matchs, ouvertes à tous dans l'app.`,
    faq: `❓ <b>Questions fréquentes</b>\n\nChoisis ta question ci-dessous 👇`
};

const FAQ = {
    paiement: { q: '💳 Comment se passe le paiement ?', r: `💳 Une fois ta demande confirmée ici, un admin te contacte en privé sur Telegram et te guide pour le paiement (PayPal ou PCS). Rien n'est prélevé automatiquement.` },
    acces: { q: '🔑 Comment j\'accède à mon pack ?', r: `🔑 Après le paiement, tu reçois ton accès : tu le débloques dans l'app, rubrique <b>« Débloquer mon accès »</b>, et tout s'ouvre immédiatement sur ton compte.` },
    parisjour: { q: '🎯 C\'est quoi les Paris du jour SMVIP+ ?', r: INFOS.nouveau.split('\n\n')[1] },
    analyses: { q: '🧠 Que contiennent les Analyses IA ?', r: INFOS.nouveau.split('\n\n')[2] },
    gratuit: { q: '🆓 Il y a quelque chose de gratuit ?', r: `🆓 Oui ! Dans l'app, l'onglet <b>Pronostics AI</b> te donne gratuitement des analyses automatiques des prochains matchs. Idéal pour découvrir notre approche avant de choisir un pack.` },
    garantie: { q: '⚠️ Les pronostics sont-ils garantis ?', r: `⚠️ Non, et personne de sérieux ne peut te le promettre : un pari comporte toujours un risque. Notre engagement, c'est la rigueur de l'analyse et la transparence (les résultats, gagnés comme perdus, restent visibles dans l'historique). Mise uniquement ce que tu peux te permettre de perdre. Réservé aux plus de 18 ans.` }
};

// Réponses rapides de l'admin : boutons sous chaque alerte reçue dans son chat
// avec le bot. Un clic envoie le message au client via le bot. Les coordonnées
// de paiement viennent de variables Vercel (jamais écrites dans le code).
const SALES_PAYPAL_INFO = process.env.SALES_PAYPAL_INFO || '';
const SALES_PCS_INFO = process.env.SALES_PCS_INFO || '';
const REPONSES_ADMIN = {
    bonjour: { bouton: '👋 Prise en charge', texte: (c, p) => `Salut${c.prenom ? ' ' + c.prenom : ''} ! 😊 Merci pour ta confiance, ravi de t'accueillir chez Score Master ! Je m'occupe personnellement de ta demande${p ? ' pour le pack <b>' + p.label + '</b>' : ''}.` },
    attente: { bouton: '⏳ J\'arrive', texte: () => `Je suis à toi dans quelques minutes, merci pour ta patience 🙏` },
    paiement: { bouton: '💳 Modes de paiement', texte: (c, p) => `Pour finaliser ton accès${p ? ' <b>' + p.label + '</b> (' + p.price + '€)' : ''}, tu peux régler par :\n\n`
        + `💙 <b>PayPal</b>${SALES_PAYPAL_INFO ? ' : ' + SALES_PAYPAL_INFO : ''}\n💳 <b>PCS</b>${SALES_PCS_INFO ? ' : ' + SALES_PCS_INFO : ''}\n\n`
        + (SALES_PAYPAL_INFO || SALES_PCS_INFO ? `Envoie-moi une capture une fois le paiement fait et j'active ton accès aussitôt ✅` : `Dis-moi lequel tu préfères et je t'envoie les infos tout de suite 😊`) },
    paypal: { bouton: '💙 Infos PayPal', texte: (c, p) => SALES_PAYPAL_INFO
        ? `💙 Paiement PayPal${p ? ' (' + p.price + '€)' : ''} : ${SALES_PAYPAL_INFO}\n\nPense à choisir « Entre proches » si possible, puis envoie-moi une capture ✅`
        : `💙 Je t'envoie l'adresse PayPal juste en dessous 👇` },
    pcs: { bouton: '💳 Infos PCS', texte: (c, p) => SALES_PCS_INFO
        ? `💳 Paiement PCS${p ? ' (' + p.price + '€)' : ''} : ${SALES_PCS_INFO}\n\nEnvoie-moi le code du recharge PCS ici, j'active ton accès dès réception ✅`
        : `💳 Pour PCS, envoie-moi directement ici le code de ta recharge${p ? ' de ' + p.price + '€' : ''}, j'active ton accès dès réception ✅` },
    recu: { bouton: '✅ Paiement reçu', texte: () => `✅ Paiement bien reçu, merci ! Je prépare ton accès, tu l'auras dans quelques instants 🚀` },
    activer: { bouton: '🔑 Comment activer', texte: () => `🔑 Pour activer ton accès :\n1. Ouvre l'app 👉 https://scoremaster.fr\n2. Connecte-toi (ou crée ton compte)\n3. Rubrique <b>« Débloquer mon accès »</b> sur l'accueil\n4. Saisis le code que je t'envoie juste après 👇` },
    bienvenue: { bouton: '🎉 Bienvenue membre', texte: (c, p) => `🎉 Ton accès${p ? ' <b>' + p.label + '</b>' : ''} est activé, bienvenue dans la team Score Master !\n\n`
        + (c.pack === 'vip' ? `👑 Ce qui t'attend :\n• ton combiné score exact chaque soir de match\n• tes <b>Paris du jour SMVIP+</b> chaque matin dès 9 h (bouton doré en bas à droite de l'app)\n• les <b>Analyses IA</b> des matchs\n• le <b>Suivi LIVE</b> de ton combiné\n\n` : '')
        + `Si tu as la moindre question, écris-moi ici 😊` },
    relance: { bouton: '🔁 Relancer le client', texte: (c) => `Coucou${c.prenom ? ' ' + c.prenom : ''} 😊 Tu es toujours partant pour nous rejoindre ? Je suis dispo maintenant si tu veux finaliser ton accès.` },
    app: { bouton: '📲 Lien de l\'app', texte: () => `📲 L'app Score Master : https://scoremaster.fr\n(Astuce : ajoute-la à ton écran d'accueil pour l'ouvrir en un geste.)` }
};

function adminKeyboard(leadChatId, pseudo, nom) {
    const k = Object.keys(REPONSES_ADMIN), rows = [];
    for (let i = 0; i < k.length; i += 2) rows.push(k.slice(i, i + 2).map(id => ({ text: REPONSES_ADMIN[id].bouton, callback_data: 'adm:' + id + ':' + leadChatId })));
    if (pseudo) rows.push([{ text: '💬 Écrire à ' + nom, url: 'https://t.me/' + pseudo }]);
    return rows;
}

async function handleAdminReponse(cq, id, leadChatId) {
    const r = REPONSES_ADMIN[id];
    if (!r || !leadChatId) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Réponse inconnue' });
    const convo = await getConversation(leadChatId) || {};
    const pack = PACKS[convo.pack_type] || null;
    const texte = r.texte({ prenom: (convo.telegram_name || '').split(' ')[0] || '', pack: convo.pack_type }, pack);
    const envoi = await sendMessage(leadChatId, texte);
    if (!envoi || !envoi.ok) return tg('answerCallbackQuery', { callback_query_id: cq.id, text: '❌ Échec de l\'envoi', show_alert: true });
    await safeUpsertConversation(leadChatId, {
        messages: (convo.messages || []).concat([{ from: 'admin', text: texte.replace(/<[^>]+>/g, ''), at: new Date().toISOString() }]),
        lead_resolved: false,
        admin_contacted_at: new Date().toISOString()
    });
    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Envoyé : ' + r.bouton });
}

// Mots-clés d'un message libre -> réponse de la FAQ
const FAQ_MOTS = [
    [/pai|pay|r[eè]gl|pcs|carte|virement|prix|tarif|combien/i, 'paiement'],
    [/code|acc[eè]s|d[ée]bloqu|activer/i, 'acces'],
    [/paris? du jour|smvip/i, 'parisjour'],
    [/analys/i, 'analyses'],
    [/gratuit|free|essai|tester/i, 'gratuit'],
    [/garanti|s[uû]r ?[àa] ?100|rembours|perdre|risque/i, 'garantie']
];

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

// Retire les boutons du message déjà répondu, pour empêcher le client de revenir
// en arrière sur un choix (et de redéclencher la réponse + la notif admin en boucle).
function clearKeyboard(chatId, messageId) {
    return tg('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
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

function escapeHtml(v) {
    return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Alerte admin liée à un client. Le texte contient le repère {{CLIENT}} à la
// place du nom. Envoyée directement par le bot de vente (HTML) pour que le nom
// soit cliquable, avec un bouton vers le chat quand le client a un pseudo, et
// enregistrée dans bot_relay_map : répondre à l'alerte écrit au client via le
// bot, même s'il n'a pas de pseudo. Repli sur telegram_queue en cas d'échec.
async function notifyAdminLead(text, chatId, convo) {
    const nom = convo.telegram_name || convo.telegram_username || 'Sans nom';
    const pseudo = convo.telegram_username || null;
    const clientTexte = nom + (pseudo ? ' (@' + pseudo + ')' : '');
    if (SALES_ADMIN_CHAT_ID) {
        const clientHtml = '<a href="tg://user?id=' + encodeURIComponent(chatId) + '"><b>' + escapeHtml(nom) + '</b></a>'
            + (pseudo ? ' (@' + escapeHtml(pseudo) + ')' : ' <i>(pas de pseudo)</i>');
        const html = escapeHtml(text).replace('{{CLIENT}}', clientHtml)
            + '\n\n<i>↩️ Réponds à ce message : ta réponse lui sera envoyée par le bot.</i>';
        const sent = await sendMessage(SALES_ADMIN_CHAT_ID, html + '\n<i>⚡ Ou utilise une réponse rapide ci-dessous.</i>', adminKeyboard(chatId, pseudo, nom));
        if (sent && sent.ok && sent.result && sent.result.message_id) {
            await sbFetch('bot_relay_map', {
                method: 'POST',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify([{ relay_message_id: sent.result.message_id, lead_chat_id: chatId }])
            }).catch(function (e) { console.error('Erreur enregistrement relay map:', e); });
            return;
        }
    }
    await notifyAdmin(text.replace('{{CLIENT}}', clientTexte));
}

function packKeyboard() {
    return Object.keys(PACKS).map(function (key) {
        var p = PACKS[key];
        return [{ text: `${p.emoji} ${p.label} — ${p.price}€`, callback_data: `pack:${key}` }];
    });
}

function menuKeyboard() {
    return packKeyboard().concat([
        [{ text: '🔎 Comparer les packs', callback_data: 'info:comparer' }, { text: '🆕 Nouveautés', callback_data: 'info:nouveau' }],
        [{ text: '❓ Questions fréquentes', callback_data: 'info:faq' }]
    ]);
}

function retourKeyboard() {
    return [
        [{ text: '👑 Choisir mon pack', callback_data: 'info:packs' }],
        [{ text: '🔎 Comparer', callback_data: 'info:comparer' }, { text: '❓ Autres questions', callback_data: 'info:faq' }]
    ];
}

function faqKeyboard() {
    return Object.keys(FAQ).map(function (k) { return [{ text: FAQ[k].q, callback_data: 'faq:' + k }]; })
        .concat([[{ text: '👑 Choisir mon pack', callback_data: 'info:packs' }]]);
}

// Le VIP+ est proposé en alternative quand un pack plus court est choisi.
function joinKeyboard(packKey) {
    const rows = [[{ text: '✅ J\'adhère maintenant !', callback_data: 'join' }]];
    if (packKey && packKey !== 'vip') rows.push([{ text: '👑 Voir plutôt le VIP+ (à vie)', callback_data: 'pack:vip' }]);
    rows.push([{ text: '🔎 Comparer les packs', callback_data: 'info:comparer' }]);
    return rows;
}

function packDetails(pack) {
    return `${pack.emoji} <b>${pack.label}</b>\n\nCe qui est inclus :\n` + pack.features.map(f => '✅ ' + f).join('\n');
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

function experienceKeyboard() {
    return [
        [{ text: 'Je débute', callback_data: 'exp:debutant' }, { text: "Moins d'1 an", callback_data: 'exp:moins1an' }],
        [{ text: '1 à 3 ans', callback_data: 'exp:1a3ans' }, { text: 'Plus de 3 ans', callback_data: 'exp:plus3ans' }]
    ];
}

const EXPERIENCE_LABELS = {
    debutant: 'Débutant', moins1an: "Moins d'1 an", '1a3ans': '1 à 3 ans', plus3ans: 'Plus de 3 ans'
};
const EXPERIENCE_REPLIES = {
    debutant: `Parfait, on va t'accompagner pas à pas dès le début, tu es au bon endroit pour bien démarrer 🙌`,
    moins1an: `Nickel, tu commences à avoir de bons repères alors, on va t'aider à passer un cap 📈`,
    '1a3ans': `Top, tu as déjà de l'expérience, tu vas vite voir la différence avec nos analyses 💪`,
    plus3ans: `Un vrai vétéran alors ! Tu sauras d'autant mieux apprécier la qualité de nos tickets 🔥`
};

function luckKeyboard() {
    return [
        [{ text: 'Plutôt de bonnes séries 📈', callback_data: 'luck:bonnes' }],
        [{ text: 'Plutôt en dents de scie 📉', callback_data: 'luck:dents' }],
        [{ text: 'Je débute, pas encore testé', callback_data: 'luck:debut' }]
    ];
}

const LUCK_LABELS = {
    bonnes: 'Plutôt de bonnes séries', dents: 'Plutôt en dents de scie', debut: 'Pas encore testé'
};
const LUCK_REPLIES = {
    bonnes: `Excellent ! On va t'aider à stabiliser ça sur la durée, plutôt qu'au coup par coup 🔥`,
    dents: `C'est justement pour casser cette irrégularité qu'on est là : nos analyses visent la régularité, pas le coup de chance 💪`,
    debut: `Alors on va faire en sorte que ta première expérience avec nous soit la bonne 😉`
};

function hypeMessage(pack) {
    return `Tu as enfin décidé de passer au niveau supérieur, très bon choix ! 🔥\n\n`
        + `Chaque jour, des dizaines de membres de notre communauté <b>Score Master</b> encaissent grâce à nos analyses 📈💰. On ne te promet pas la lune : on te donne les tickets préparés par une équipe qui cumule plus de 20 ans d'expérience dans l'analyse sportive, avec une rigueur et une transparence qui font notre réputation depuis le début.\n\n`
        + `Tu es sur le point de rejoindre les centaines de membres qui nous font confiance au quotidien et qui vivent l'expérience Score Master de l'intérieur. 🙌\n\n`
        + `Pack sélectionné : <b>${pack.label}</b> (${pack.price}€)`;
}

async function handleStart(chatId, from, startParam) {
    // Le lien depuis l'app encode aussi le pseudo du compte Score Master, sous la
    // forme "pack_<packKey>__u_<pseudo>" (le start param Telegram n'accepte que
    // [A-Za-z0-9_]). On préfère ce pseudo au prénom Telegram pour interpeller le
    // client de façon reconnaissable, comme sur son compte de l'app.
    const uIdx = startParam ? startParam.indexOf('__u_') : -1;
    const packPart = startParam ? (uIdx >= 0 ? startParam.slice(0, uIdx) : startParam) : null;
    const appPseudo = uIdx >= 0 ? startParam.slice(uIdx + 4) : null;

    const preselectedKey = packPart && packPart.startsWith('pack_') ? packPart.slice(5) : null;
    const preselectedPack = preselectedKey && PACKS[preselectedKey] ? preselectedKey : null;

    await upsertConversation(chatId, {
        state: preselectedPack ? 'awaiting_join' : 'awaiting_pack',
        pack_type: preselectedPack,
        telegram_username: from.username || null,
        telegram_name: appPseudo || [from.first_name, from.last_name].filter(Boolean).join(' ') || null
    });

    if (preselectedPack) {
        await sendMessage(chatId, packDetails(PACKS[preselectedPack]) + '\n\n' + hypeMessage(PACKS[preselectedPack]), joinKeyboard());
    } else {
        const depuisApp = packPart === 'app';
        await sendMessage(chatId,
            `Bonjour${appPseudo ? ' ' + escapeHtml(appPseudo) : ''}, ici Master Gon ! 👋😊 Bienvenue chez <b>Score Master</b> !\n\n`
            + (depuisApp ? `Ravi de te voir arriver depuis l'app 📲. ` : `Ravi de t'accueillir. `)
            + `Je peux te présenter nos packs, te montrer les nouveautés (Paris du jour SMVIP+, Analyses IA, Suivi LIVE…) ou répondre à tes questions.\n\nQuel pack t'intéresse aujourd'hui ?`,
            menuKeyboard()
        );
    }
}

async function handlePackChoice(chatId, packKey) {
    const pack = PACKS[packKey];
    if (!pack) return;
    await upsertConversation(chatId, { state: 'awaiting_join', pack_type: packKey });
    await sendMessage(chatId, packDetails(pack) + '\n\n' + hypeMessage(pack), joinKeyboard(packKey));
}

// Menu d'information (comparatif, nouveautés, FAQ) : consultable à toute étape,
// ne modifie pas l'avancement de la demande.
async function handleInfo(chatId, key) {
    if (key === 'faq') return sendMessage(chatId, INFOS.faq, faqKeyboard());
    if (INFOS[key]) return sendMessage(chatId, INFOS[key], retourKeyboard());
}
async function handleFaq(chatId, key) {
    const f = FAQ[key];
    if (f) await sendMessage(chatId, f.r, retourKeyboard());
}

async function safeUpsertConversation(chatId, patch) {
    try {
        await upsertConversation(chatId, patch);
    } catch (e) {
        console.error('upsertConversation failed (colonnes manquantes en base ?):', e);
    }
}

// Transfère un message de lead dans le chat perso de l'admin avec le bot, et
// mémorise quel message Telegram (son id) correspond à quel lead (chat_id) --
// nécessaire pour retrouver le bon destinataire quand l'admin y répondra.
async function relayLeadMessageToAdmin(leadChatId, convo, text) {
    if (!SALES_ADMIN_CHAT_ID) return;
    const leadName = convo.telegram_name || convo.telegram_username || ('Chat ' + leadChatId);
    const packLabel = convo.pack_type && PACKS[convo.pack_type] ? PACKS[convo.pack_type].label : (convo.pack_type || '?');
    const relayText = `💬 <b>${escapeHtml(leadName)}</b>${convo.telegram_username ? ' (@' + convo.telegram_username + ')' : ''} — ${packLabel}\n\n${escapeHtml(text)}\n\n<i>Réponds directement à ce message pour lui répondre sur Telegram, ou utilise une réponse rapide.</i>`;
    const sent = await sendMessage(SALES_ADMIN_CHAT_ID, relayText, adminKeyboard(leadChatId, convo.telegram_username, leadName));
    if (sent && sent.ok && sent.result && sent.result.message_id) {
        await sbFetch('bot_relay_map', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{ relay_message_id: sent.result.message_id, lead_chat_id: leadChatId }])
        }).catch(function (e) { console.error('Erreur enregistrement relay map:', e); });
    }
}

async function handleJoinConfirm(chatId, convo) {
    const pack = PACKS[convo.pack_type];
    const orderRef = generateOrderRef();
    await sendMessage(chatId,
        `Top ! Hâte de te voir parmi nous. 🙌\n\nUn admin se libère pour toi dans quelques instants. En attendant, j'ai quelques petites questions pour mieux te connaître et t'orienter au mieux 😊\n\nSur quelle plateforme paries-tu d'habitude ? <i>(ça nous permet d'adapter nos conseils aux meilleures cotes disponibles chez toi)</i>`,
        platformKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_platform', order_ref: orderRef });
    const firstName = (convo.telegram_name || '').split(' ')[0] || '';
    await notifyAdminLead(
        `💰 NOUVELLE DEMANDE (Bot Telegram)\n\nRéférence : ${orderRef}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\n\n👤 {{CLIENT}}\n💬 Chat ID : ${chatId}\n\n➡️ Le client vient de confirmer, il répond encore à quelques questions avant que je te notifie à nouveau avec plus de détails.\n\n📋 Message suggéré à lui envoyer dès maintenant (copier-coller) :\n« Salut${firstName ? ' ' + firstName : ''} ! 😊 Un grand merci pour ta confiance, ravi de t'accueillir chez Score Master ! Je m'occupe personnellement de toi pour la suite. Avant qu'on rentre dans le vif du sujet, dis-moi : ça fait longtemps que tu paries ou tu débutes tout juste ? »\n\n⚠️ Le paiement (PayPal/PCS) reste à toi de l'aborder plus tard, une fois le contact établi.`,
        chatId, convo
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
    const reply = SPORT_REPLIES[sportKey] || SPORT_REPLIES.autre;
    await sendMessage(chatId,
        `${reply}\n\nDepuis combien de temps paries-tu ? <i>(ça nous aide à adapter le niveau de détail de nos analyses pour toi)</i>`,
        experienceKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_experience', betting_sport: SPORT_LABELS[sportKey] || sportKey });
}

async function handleExperienceChoice(chatId, expKey, convo) {
    const reply = EXPERIENCE_REPLIES[expKey] || '';
    await sendMessage(chatId,
        `${reply}\n\nEt sinon, plutôt de bonnes séries avec tes pronostics jusqu'ici, ou plutôt en dents de scie ?`,
        luckKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_luck', betting_experience: EXPERIENCE_LABELS[expKey] || expKey });
}

async function handleLuckChoice(chatId, luckKey, convo) {
    const pack = PACKS[convo.pack_type];
    const reply = LUCK_REPLIES[luckKey] || '';
    await sendMessage(chatId,
        `${reply}\n\nEn tout cas t'as fait le bon choix de nous rejoindre, l'équipe est hyper rigoureuse sur l'analyse, on ne sort un ticket que quand on est vraiment confiants dessus. Merci pour ces questions et réponses aussi rapides ! 🙏 Je relance l'admin de mon côté !\n\n💡 En attendant, tu peux déjà découvrir gratuitement nos <b>Pronostics AI</b> dans l'app 📲${convo.pack_type === 'vip' ? ', et dès ton accès VIP+ activé, tes <b>Paris du jour SMVIP+</b> t\'attendent chaque matin à partir de 9 h (bouton doré en bas à droite)' : ''}.`,
        relaunchKeyboard()
    );
    await safeUpsertConversation(chatId, { state: 'awaiting_admin', betting_luck: LUCK_LABELS[luckKey] || luckKey });
    const firstName = (convo.telegram_name || '').split(' ')[0] || '';
    const platformLabel = convo.betting_platform || '';
    const sportLabel = convo.betting_sport || '';
    const platformLine = platformLabel ? ` Vu que tu paries sur ${platformLabel}, garde en tête que` : ' Sache que';
    await notifyAdminLead(
        `✅ COMPLÉMENT DE DEMANDE (Bot Telegram)\n\nRéférence : ${convo.order_ref || '?'}\nPack : ${pack ? pack.label : convo.pack_type} (${pack ? pack.price : '?'}€)\n\n👤 {{CLIENT}}\n💬 Chat ID : ${chatId}\n\n🎯 Plateforme habituelle : ${convo.betting_platform || '?'}\n🏅 Sport favori : ${sportLabel || '?'}\n📅 Expérience : ${convo.betting_experience || '?'}\n🎲 Régularité : ${LUCK_LABELS[luckKey] || luckKey}\n\n➡️ Contacte le client sur Telegram pour poursuivre l'échange.\n\n📋 Message suggéré à lui envoyer (copier-coller) :\n« Ah top${firstName ? ', ' + firstName : ''} ! 😊${platformLine} nos pronostics ${sportLabel.toLowerCase()} sont particulièrement solides en ce moment 🔥. »\n\n⚠️ Le paiement (PayPal/PCS) reste à toi de l'aborder plus tard, une fois le contact établi.`,
        chatId, convo
    );
    // Message relayé (celui-ci, contrairement au précédent envoyé via
    // telegram_queue, est directement "répondable" pour engager la conversation).
    await relayLeadMessageToAdmin(chatId, convo, `Nouveau lead prêt à être contacté (${pack ? pack.label : convo.pack_type}). Réponds à ce message pour lui écrire directement.`);
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
            await sendMessage(chatId, `Merci de patienter encore ${remaining}s avant de relancer à nouveau 😊`, relaunchKeyboard());
            return;
        }
    }

    const newCount = count + 1;
    await upsertConversation(chatId, { relaunch_count: newCount, last_relaunch_at: new Date().toISOString() });
    await sendMessage(chatId, `C'est noté ! Un admin va vous contacter très vite. Merci de votre patience 🙏 (${newCount}/3)`, newCount < 3 ? relaunchKeyboard() : null);
    const firstName = (convo.telegram_name || '').split(' ')[0] || '';
    await notifyAdminLead(
        `🔔 RELANCE (${newCount}/3) — Bot Telegram\n\nRéférence : ${convo.order_ref || '?'}\nPack : ${pack ? pack.label : convo.pack_type}\n\n👤 {{CLIENT}}\n💬 Chat ID : ${chatId}\n${convo.betting_platform ? `🎯 Plateforme habituelle : ${convo.betting_platform}\n` : ''}${convo.betting_sport ? `🏅 Sport favori : ${convo.betting_sport}\n` : ''}${convo.betting_experience ? `📅 Expérience : ${convo.betting_experience}\n` : ''}${convo.betting_luck ? `🎲 Régularité : ${convo.betting_luck}\n` : ''}\n➡️ Le client attend toujours ton contact.\n\n📋 Message suggéré à lui envoyer (copier-coller) :\n« Salut${firstName ? ' ' + firstName : ''} ! 😊 Désolé pour l'attente, je m'occupe de toi tout de suite ! En tout cas t'as fait le bon choix de nous rejoindre, l'équipe est hyper rigoureuse sur l'analyse, on ne sort un ticket que quand on est vraiment confiants dessus. »\n\n⚠️ Le paiement (PayPal/PCS) reste à toi de l'aborder plus tard, une fois le contact établi.`,
        chatId, convo
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
            const messageId = cq.message.message_id;
            const data = cq.data || '';

            // Chaque étape n'accepte le clic que si le state en base correspond
            // exactement à l'étape attendue : un clic sur un bouton déjà répondu
            // (message pas encore retiré, double-tap, ancien message) est ignoré
            // et le client est prévenu au lieu de redéclencher la réponse/la notif admin.
            const STEP_STATES = {
                'join': 'awaiting_join',
                'platform:': 'awaiting_platform',
                'sport:': 'awaiting_sport',
                'exp:': 'awaiting_experience',
                'luck:': 'awaiting_luck'
            };
            const matchedPrefix = Object.keys(STEP_STATES).find(function (p) { return data === p || data.startsWith(p); });

            // Réponses rapides de l'admin (uniquement depuis son chat avec le bot)
            if (data.startsWith('adm:')) {
                const estAdmin = SALES_ADMIN_CHAT_ID && String(chatId) === String(SALES_ADMIN_CHAT_ID);
                if (!estAdmin) { await tg('answerCallbackQuery', { callback_query_id: cq.id }); return res.status(200).json({ ok: true }); }
                const [, id, lead] = data.split(':');
                await handleAdminReponse(cq, id, lead);
                return res.status(200).json({ ok: true });
            }
            if (data === 'info:packs') {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
                await clearKeyboard(chatId, messageId);
                await sendMessage(chatId, `Quel pack t'intéresse ? 👇`, packKeyboard());
            } else if (data.startsWith('info:')) {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
                await clearKeyboard(chatId, messageId);
                await handleInfo(chatId, data.slice(5));
            } else if (data.startsWith('faq:')) {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
                await clearKeyboard(chatId, messageId);
                await handleFaq(chatId, data.slice(4));
            } else if (data.startsWith('pack:')) {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
                await clearKeyboard(chatId, messageId);
                await handlePackChoice(chatId, data.slice(5));
            } else if (matchedPrefix) {
                const convo = await getConversation(chatId);
                const expectedState = STEP_STATES[matchedPrefix];
                if (convo && convo.state === expectedState) {
                    await tg('answerCallbackQuery', { callback_query_id: cq.id });
                    await clearKeyboard(chatId, messageId);
                    const value = matchedPrefix === 'join' ? null : data.slice(matchedPrefix.length);
                    if (matchedPrefix === 'join') await handleJoinConfirm(chatId, convo);
                    else if (matchedPrefix === 'platform:') await handlePlatformChoice(chatId, value, convo);
                    else if (matchedPrefix === 'sport:') await handleSportChoice(chatId, value, convo);
                    else if (matchedPrefix === 'exp:') await handleExperienceChoice(chatId, value, convo);
                    else if (matchedPrefix === 'luck:') await handleLuckChoice(chatId, value, convo);
                } else {
                    await tg('answerCallbackQuery', { callback_query_id: cq.id, text: 'Déjà répondu, merci ! 😊', show_alert: false });
                    await clearKeyboard(chatId, messageId);
                }
            } else if (data === 'relaunch') {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
                await clearKeyboard(chatId, messageId);
                const convo = await getConversation(chatId);
                if (convo) {
                    await handleRelaunch(chatId, convo);
                }
            } else {
                await tg('answerCallbackQuery', { callback_query_id: cq.id });
            }
            return res.status(200).json({ ok: true });
        }

        if (update.message) {
            const msg = update.message;
            const chatId = msg.chat.id;
            const text = (msg.text || '').trim();

            // Message envoyé par l'admin DANS SON PROPRE chat avec le bot, en
            // réponse ("Répondre") à un message relayé d'un lead -- on relaie
            // directement vers le lead concerné, retrouvé via le message_id
            // auquel l'admin a répondu. Traité en priorité, avant toute autre
            // logique (l'admin n'est jamais dans un des états de la conversation
            // de vente lui-même).
            if (SALES_ADMIN_CHAT_ID && String(chatId) === String(SALES_ADMIN_CHAT_ID) && msg.reply_to_message && text) {
                const mapRows = await sbFetch(`bot_relay_map?relay_message_id=eq.${msg.reply_to_message.message_id}&select=lead_chat_id`).catch(() => []);
                const leadChatId = mapRows && mapRows[0] && mapRows[0].lead_chat_id;
                if (leadChatId) {
                    await sendMessage(leadChatId, text);
                    const leadConvo = await getConversation(leadChatId);
                    const leadMessages = (leadConvo && leadConvo.messages) || [];
                    await safeUpsertConversation(leadChatId, {
                        messages: leadMessages.concat([{ from: 'admin', text, at: new Date().toISOString() }]),
                        lead_resolved: false,
                        admin_contacted_at: new Date().toISOString()
                    });
                    await tg('setMessageReaction', { chat_id: chatId, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji: '✅' }] }).catch(function () {});
                    return res.status(200).json({ ok: true });
                }
            }

            if (text === '/start' || text.startsWith('/start ')) {
                const startParam = text.startsWith('/start ') ? text.slice(7).trim() : null;
                await handleStart(chatId, msg.from, startParam);
                return res.status(200).json({ ok: true });
            }

            const convo = await getConversation(chatId);
            if (!convo) {
                await handleStart(chatId, msg.from);
            } else if (convo.state === 'awaiting_admin') {
                // On enregistre le message du lead pour qu'il apparaisse dans
                // l'historique du Panel Admin, ET on le transfère directement
                // dans le chat perso de l'admin avec le bot (répondre à ce
                // message relaie la réponse au lead -- voir plus haut).
                const existingMessages = convo.messages || [];
                const updatedMessages = existingMessages.concat([{ from: 'lead', text, at: new Date().toISOString() }]);
                await safeUpsertConversation(chatId, { messages: updatedMessages, lead_resolved: false });
                await relayLeadMessageToAdmin(chatId, convo, text);

                // Message d'attente au lead seulement s'il n'a encore rien eu
                // en retour, pour ne pas le répéter à chaque message.
                if (!existingMessages.length) {
                    await sendMessage(chatId, `Un membre de notre équipe va vous répondre très vite, merci de patienter un instant 🙏😊`);
                }
            } else {
                const trouve = FAQ_MOTS.find(([re]) => re.test(text));
                if (trouve) await handleFaq(chatId, trouve[1]);
                else await sendMessage(chatId, `Je n'ai pas bien compris 😅 Choisis une option ci-dessous, ou réponds à la question en cours plus haut 👆`, menuKeyboard());
            }
        }

        res.status(200).json({ ok: true });
    } catch (error) {
        console.error('Erreur webhook sales bot:', error);
        res.status(200).json({ ok: true });
    }
};
