// Fusion de publish-approved.js (cron) et publish-now.js (bouton admin),
// pour rester sous la limite de 12 fonctions serverless du plan Vercel
// Hobby. Deux façons d'appeler ce même endpoint :
//
// - GET /api/publish?secret=... (cron VPS, toutes les X min) : publie
//   TOUTES les publications "approved" en attente via Postiz.
// - POST /api/publish avec Authorization: Bearer <token admin> et
//   { id } dans le corps : force la publication immédiate d'UNE
//   publication déjà "approved", sans attendre le prochain passage cron —
//   utilisé par le bouton "Publier maintenant" du Panel Admin.
//
// - platform "instagram" -> publié immédiatement via l'API Postiz
// - platform "telegram"  -> publié immédiatement via l'API Postiz (canal
//   Telegram connecté)

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN || 'postiz.srv1960340.hstgr.cloud';
// Cette instance Postiz héberge PLUSIEURS comptes Instagram (Score Master +
// d'autres projets, ex: Hibou Empire), tous avec le même `identifier`
// technique ("instagram-standalone") -- un simple .find() sur l'identifier
// prenait donc le premier trouvé, potentiellement celui d'un autre projet
// (bug réel constaté : contenu Score Master publié sur le compte Hibou
// Empire). On cible désormais explicitement le compte par son id Postiz.
// Secret partagé avec la routine "Calendrier de contenu" (Claude Code), qui
// génère les 8 visuels d'un carrousel avec la mascotte puis dépose le brouillon
// ici. Sans ce secret, aucun dépôt possible : la clé anon ne peut pas écrire
// dans pending_publications (aucune policy d'insertion).
const CALENDAR_SECRET = process.env.CALENDAR_SECRET;
const POSTIZ_INSTAGRAM_INTEGRATION_ID = process.env.POSTIZ_INSTAGRAM_INTEGRATION_ID || 'cmtw09jnf0001no72az5xn74h'; // "Scores Meridian" = compte Instagram réel de Score Master

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${path} -> ${res.status}: ${text}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function verifyAdmin(accessToken) {
    if (!accessToken) return false;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) return false;
    const user = await res.json();
    if (!user || !user.id) return false;
    const rows = await sbFetch(`profiles?id=eq.${user.id}&select=is_admin`);
    return !!(rows && rows[0] && rows[0].is_admin);
}

async function postizFetch(path, options) {
    const res = await fetch(`https://${POSTIZ_DOMAIN}/api/public/v1${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'Authorization': POSTIZ_API_KEY,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(`Postiz ${path} -> ${res.status}: ${text}`);
    return data;
}

async function postizPublishInstagram(ig, item, imagePath, postType) {
    await postizFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({
            type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
            posts: [{
                integration: { id: ig.id },
                value: [{ content: item.caption, image: [{ id: item.id, path: imagePath }] }],
                settings: { __type: 'instagram', post_type: postType }
            }]
        })
    });
}

async function postizPublish(item, integrations) {
    if (item.platform === 'instagram') {
        const ig = (integrations || []).find(function (i) { return i.id === POSTIZ_INSTAGRAM_INTEGRATION_ID; });
        if (!ig) throw new Error('Compte Instagram Score Master introuvable sur Postiz (id attendu: ' + POSTIZ_INSTAGRAM_INTEGRATION_ID + ')');

        // Carrousel Story Time (plusieurs slides, voir image-bridge.js) : publié
        // comme un seul post multi-images, swipeable sur Instagram.
        if (Array.isArray(item.carousel_images) && item.carousel_images.length) {
            await postizFetch('/posts', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                    posts: [{
                        integration: { id: ig.id },
                        value: [{
                            content: item.caption,
                            image: item.carousel_images.map(function (url, i) { return { id: item.id + '-' + i, path: url }; })
                        }],
                        settings: { __type: 'instagram', post_type: 'post' }
                    }]
                })
            });
            return;
        }

        // Contenu généré en double format (Story 9:16 + Post 4:5, voir
        // image-bridge.js) : l'admin choisit au moment d'approuver lequel publier,
        // potentiellement les deux (deux appels Postiz distincts, une image
        // dédiée à chaque format plutôt qu'un recadrage).
        if (item.image_url_story || item.image_url_post) {
            const wantStory = item.publish_as_story !== false && item.image_url_story;
            const wantPost = item.publish_as_post === true && item.image_url_post;
            if (!wantStory && !wantPost) throw new Error('Aucun format sélectionné (Story/Post) pour cette publication');
            if (wantStory) await postizPublishInstagram(ig, item, item.image_url_story, 'story');
            if (wantPost) await postizPublishInstagram(ig, item, item.image_url_post, 'post');
            return;
        }

        await postizPublishInstagram(ig, item, item.image_url, 'post');
    } else if (item.platform === 'telegram') {
        const tg = (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('telegram') !== -1; });
        if (!tg) throw new Error('Aucune intégration Telegram trouvée sur Postiz');
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{
                    integration: { id: tg.id },
                    value: [{ content: item.caption, image: item.image_url ? [{ id: item.id, path: item.image_url }] : [] }],
                    settings: { __type: 'telegram' }
                }]
            })
        });
    } else {
        throw new Error(`Plateforme inconnue: ${item.platform}`);
    }
}

// Heure/date "maintenant" à Paris (pas le fuseau du serveur Vercel, qui
// tourne en UTC) — comparée à scheduled_for/scheduled_time pour ne publier
// une ligne "approved" qu'une fois son créneau réellement atteint.
// ------------------------------------------------------------
// Automatisation des publications (Content Planner > Réglages)
// ------------------------------------------------------------
async function lireReglagesAuto() {
    try {
        const rows = await sbFetch('automation_settings?id=eq.singleton&select=*');
        return (rows && rows[0]) || null;
    } catch (e) {
        return null; // table absente : automatisation considérée comme désactivée
    }
}

// Slides déjà assemblées par la routine (JPEG en base64) : stockées dans le
// bucket public, dans l'ordre du carrousel.
const BUCKET_IMAGES = 'content-images';
async function televerserSlides(idLigne, composees) {
    const urls = [];
    for (let i = 0; i < composees.length; i++) {
        const m = String(composees[i]).match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
        if (!m) throw new Error('Slide ' + (i + 1) + ' : format d\'image invalide');
        const ext = m[1] === 'image/png' ? 'png' : 'jpg';
        const chemin = 'carrousels/' + idLigne + '-slide' + i + '.' + ext;
        const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET_IMAGES + '/' + chemin, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': m[1],
                'x-upsert': 'true'
            },
            body: Buffer.from(m[2], 'base64')
        });
        if (!r.ok) throw new Error('Stockage slide ' + (i + 1) + ' -> ' + r.status + ' : ' + (await r.text()));
        urls.push(SUPABASE_URL + '/storage/v1/object/public/' + BUCKET_IMAGES + '/' + chemin);
    }
    return urls;
}

// Approbation automatique : à partir de l'heure réglée (7h00 par défaut), les
// carrousels du calendrier prévus aujourd'hui, assemblés et non exclus, passent
// en « approuvé ». Le balayage habituel les publie ensuite à leur heure.
async function approuverAutomatiquement(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_publish) return { actif: false };
    const [hh, mm] = String(reglages.auto_approve_at || '07:00').split(':').map(Number);
    if (now.minutes < hh * 60 + mm) return { actif: true, enAttenteHeure: true };

    const exclus = Array.isArray(reglages.exclusions) ? reglages.exclusions : [];
    const candidats = await sbFetch('pending_publications?status=eq.pending&platform=eq.instagram'
        + '&overlay_data->>source=eq.content-calendar&scheduled_for=eq.' + now.dateStr
        + '&select=id,carousel_images,overlay_data') || [];
    const approuves = [];
    for (const c of candidats) {
        const calId = c.overlay_data && c.overlay_data.calendar_id;
        if (exclus.indexOf(calId) !== -1) continue;
        if (!Array.isArray(c.carousel_images) || !c.carousel_images.length || c.carousel_images.some(u => !u)) continue;
        await sbFetch('pending_publications?id=eq.' + c.id + '&status=eq.pending', {
            method: 'PATCH',
            body: JSON.stringify({ status: 'approved', overlay_data: Object.assign({}, c.overlay_data, { auto_approuve_le: new Date().toISOString() }) })
        });
        approuves.push(calId);
    }
    return { actif: true, approuves };
}

// ------------------------------------------------------------
// Séquence marketing du combiné (Content Planner > Réglages)
//
// Calée sur le premier coup d'envoi du combiné du jour :
//   - « Bonjour l'équipe » ~5 h avant (jamais avant 9h), Telegram + story ;
//   - relance 2 h avant, Telegram + story ;
//   - « c'est parti » 15 min avant, Telegram ;
//   - après la validation du résultat par l'admin : message victoire ou
//     défaite, Telegram + story (jamais la nuit : entre 8h et minuit).
// Chaque étape est créée une seule fois (clé de séquence) et déjà approuvée :
// le balayage la publie dans la foulée. L'agent ne valide jamais un résultat.
// ------------------------------------------------------------
// Bloc de contact repris au bas de chaque publication Telegram.
const CONTACT = '🌐 Site : https://scoremaster.fr/\n📸 Instagram : @scoremaster.fr\n➡️ Telegram : @ScoreMasterOfficiel';

const SEQ_TELEGRAM = {
    promo: [
        "⚽ Chaque jour, des pronostics analysés GRATUITEMENT sur l'app Score Master.\n\nProbabilités, forme des équipes, classements : tout est expliqué, match par match. 📊",
        "📖 Chez Score Master, tous nos résultats restent visibles : les victoires comme les défaites.\n\nC'est la seule façon de juger une méthode sur la durée. Consulte l'historique complet dans l'app. 🔍",
        "👑 L'espace VIP+ Score Master : le combiné du jour avec les scores exacts, les cotes et le suivi en direct.\n\nToutes les infos sur l'app. 🔥",
        "🧠 Nos analyses partent de données réelles : forme, confrontations, enjeux, compositions.\n\nPas d'intuition, une méthode. Découvre-la sur l'app. 📈",
        "📲 Pas d'application à télécharger : Score Master s'ouvre directement dans ton navigateur.\n\nAjoute-la à ton écran d'accueil en deux secondes. ⚡",
        "🎁 Parrainage Score Master : invite 3 amis sur le canal et débloque un pronostic VIP+ gratuit.\n\nRécompense répétable à chaque palier de 3. Ton lien t'attend dans ton profil. 🔗",
        "💡 Un conseil par jour pour jouer plus malin : erreurs à éviter, bons réflexes, idées reçues.\n\nRetrouve-les sur notre Instagram et dans l'app. 📚",
        "🔔 Rejoins le canal Telegram Score Master pour ne rater aucune annonce : combiné du jour, relances, résultats. 📣",
        "🧘 Un budget, une méthode, zéro précipitation.\n\nChez Score Master, on préfère peu de paris bien choisis à beaucoup de paris au hasard. 🎯",
        "🗓️ Tous les matchs du jour au même endroit : horaires, classements et analyses gratuites.\n\nOuvre l'onglet Matchs de l'app. ⚽"
    ],
    bonjour: [
        "☀️ Bonjour l'équipe ! J'espère que vous passez une bonne journée.\n\nDe notre côté, on termine l'analyse des matchs du jour : premier coup d'envoi à {HEURE}. On vous a préparé du solide. 🔍",
        "👋 Salut à tous !\n\nLe combiné du jour est prêt : {N} passés au crible. Coup d'envoi à {HEURE}.\n\nOn reste concentrés jusqu'au bout. 🎯",
        "🔎 Bonjour la team !\n\nOn peaufine les derniers détails avant le coup d'envoi de {HEURE} : compositions, dynamique, enjeux, tout est vérifié.",
        "💬 Bonne journée à tous !\n\nAu programme de notre combiné : {N}. On vous en dit plus dans l'app, avant le coup d'envoi à {HEURE}.",
        "📊 Hello l'équipe !\n\nJournée d'analyse chez Score Master : le combiné est bouclé. Premier match à {HEURE}.\n\nComme toujours : mise raisonnable, esprit clair.",
        "⚽ Bonjour à tous !\n\nOn continue d'analyser les rencontres du jour, et on vous réserve une belle sélection. Coup d'envoi à {HEURE}. 🔥"
    ],
    relance: [
        "⏳ Plus que 2 heures avant le coup d'envoi ({HEURE}) !\n\nLe combiné du jour est disponible dans l'app. Dernière ligne droite. 🎯",
        "🚨 J-2h ! Les compositions tombent bientôt, on vérifie tout une dernière fois.\n\nCoup d'envoi à {HEURE}. Le combiné vous attend dans l'app.",
        "🔥 Ça approche ! {N}, un seul objectif.\n\nRendez-vous à {HEURE}. Pensez à fixer votre budget avant de jouer.",
        "📲 Petit rappel : le combiné du jour est en ligne dans l'app.\n\nPremier match à {HEURE}. Restez concentrés, restez raisonnables.",
        "⏰ Dernier rappel !\n\nCoup d'envoi à {HEURE}. Tout est prêt de notre côté."
    ],
    depart: [
        "🟢 C'est parti dans 15 minutes ! Bon match à tous. ⚽",
        "⚽ Coup d'envoi imminent. On croise les doigts avec vous !",
        "🎬 Les équipes entrent sur le terrain. Bon match à tous !",
        "🔔 C'est l'heure ! Bon match, et restez raisonnables. ⚽"
    ],
    victoire: [
        "✅ COMBINÉ VALIDÉ !\n\nBravo à toute l'équipe, l'analyse a payé. 🎉\n\n{STAT}Merci pour votre confiance. On se retrouve demain pour la suite.",
        "🏆 C'EST GAGNÉ !\n\nLe combiné du jour passe : le travail d'analyse paie. 💪\n\n{STAT}Rendez-vous demain, même rigueur.",
        "🎯 Dans le mille !\n\nCombiné validé.\n\n{STAT}Merci à tous ceux qui nous suivent. À demain !",
        "✅ Victoire !\n\nUne sélection bien pensée, des matchs bien lus.\n\n{STAT}On reste humbles et on continue demain."
    ],
    defaite: [
        "❌ Pas cette fois.\n\nLe combiné du jour ne passe pas. Ça fait partie du jeu, et on l'assume.\n\n{STAT}On analyse ce qui a manqué et on revient demain avec la même rigueur. Pas de précipitation : mise toujours dans ton budget.",
        "😤 Raté.\n\nLe football reste imprévisible, même avec une bonne analyse.\n\n{STAT}On ne cherche pas à « se refaire » : on reprend demain, tranquillement, avec méthode.",
        "❌ Combiné perdu.\n\nOn vous le dit franchement, comme toujours.\n\n{STAT}On repasse les matchs en revue et on revient demain. Restez raisonnables. 🙏",
        "Ça n'a pas voulu. ❌\n\nUne défaite ne change pas notre méthode.\n\n{STAT}Merci pour votre confiance, on se retrouve demain."
    ]
};

const SEQ_STORY = {
    promo: [
        { badge: 'GRATUIT', texte: 'Des pronostics analysés *chaque jour*' },
        { badge: 'TRANSPARENCE', texte: 'Tous nos résultats, *sans filtre*' },
        { badge: 'ESPACE VIP+', texte: 'Le combiné du jour, *scores exacts* inclus' },
        { badge: 'MÉTHODE', texte: 'Des analyses sur *données réelles*' },
        { badge: 'SCOREMASTER.FR', texte: 'Aucune appli à installer. *Ouvre et c\'est parti*' },
        { badge: 'PARRAINAGE', texte: 'Invite 3 amis, débloque un *pronostic VIP+*' },
        { badge: 'CONSEILS', texte: 'Un conseil par jour pour *jouer plus malin*' },
        { badge: 'TELEGRAM', texte: 'Rejoins le canal : *ne rate aucune annonce*' },
        { badge: 'JEU RESPONSABLE', texte: 'Un budget, une méthode, *zéro précipitation*' },
        { badge: 'MATCHS DU JOUR', texte: 'Tous les matchs *au même endroit*' }
    ],
    bonjour: [
        { badge: "AUJOURD'HUI · {HEURE}", texte: "On termine l'analyse des matchs *du jour*" },
        { badge: "AUJOURD'HUI · {HEURE}", texte: "Le combiné du jour est *prêt*" },
        { badge: "AUJOURD'HUI · {HEURE}", texte: "On vous a préparé *du solide*" }
    ],
    relance: [
        { badge: 'J-2H', texte: "Plus que *2 heures* avant le coup d'envoi" },
        { badge: 'J-2H', texte: "Dernière ligne droite : coup d'envoi à *{HEURE}*" },
        { badge: 'J-2H', texte: "Le combiné est *en ligne* dans l'app" }
    ],
    victoire: [
        { badge: 'RÉSULTAT', texte: 'Combiné *validé*' },
        { badge: 'RÉSULTAT', texte: "C'est *gagné*. Merci pour votre confiance" },
        { badge: 'RÉSULTAT', texte: "L'analyse a *payé*" }
    ],
    defaite: [
        { badge: 'RÉSULTAT', texte: 'Pas cette fois. On revient *demain*' },
        { badge: 'RÉSULTAT', texte: 'Combiné perdu. Même *méthode* demain' },
        { badge: 'RÉSULTAT', texte: 'On analyse, on apprend, on *revient*' }
    ]
};

function minutesDe(hhmm) {
    const m = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
    return m ? (+m[1]) * 60 + (+m[2]) : null;
}
function hhmm(minutes) {
    const m = ((minutes % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
// Rotation sans répétition d'un jour sur l'autre.
function choisir(liste, dateStr, decalage) {
    const jour = Math.floor(Date.parse(dateStr + 'T12:00:00Z') / 86400000);
    return liste[(jour + (decalage || 0)) % liste.length];
}
function remplir(t, v) {
    return String(t).replace(/\{HEURE\}/g, v.heure || '').replace(/\{N\}/g, v.n || 'plusieurs matchs').replace(/\{STAT\}/g, v.stat || '');
}

// Vrai taux de réussite sur 30 jours (affiché seulement à partir de 5 combinés).
async function statTrenteJours(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 30);
    const rows = await sbFetch('combineds_public?date=gte.' + d.toISOString().slice(0, 10) + '&status=in.(termine,perdu)&select=status') || [];
    if (rows.length < 5) return '';
    const g = rows.filter(r => r.status === 'termine').length;
    return '📈 Sur les 30 derniers jours : ' + g + ' combiné' + (g > 1 ? 's' : '') + ' gagné' + (g > 1 ? 's' : '') + ' sur ' + rows.length + '.\n\n';
}

// Fond de story : un visuel 9:16 récent de la mascotte (slides finales des carrousels).
async function fondStoryRecent(dateStr, decalage) {
    try {
        const rows = await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar&select=overlay_data&order=created_at.desc&limit=12') || [];
        const fonds = [];
        rows.forEach(r => ((r.overlay_data && r.overlay_data.slides) || []).forEach(s => {
            if (s.position === 'cta' && s.image_url && fonds.indexOf(s.image_url) === -1) fonds.push(s.image_url);
        }));
        return fonds.length ? choisir(fonds, dateStr, decalage) : null;
    } catch (e) { return null; }
}

// Rencontres du combiné d'une date, avec les logos venant du cache.
async function infosMatchs(dateStr) {
    try {
        const combos = await sbFetch('combineds_public?date=eq.' + dateStr + '&select=time,matches') || [];
        const rencontres = [];
        combos.forEach(c => (c.matches || []).forEach(m => {
            const parts = String(m.teams || '').split(' - ');
            if (parts.length < 2) return;
            rencontres.push({ home: parts[0].trim(), away: parts.slice(1).join(' - ').trim(), heure: m.time || c.time || '' });
        }));
        if (!rencontres.length) return [];
        const cache = await sbFetch('ai_fixtures?fixture_date=eq.' + dateStr + '&select=home,away,home_logo,away_logo') || [];
        rencontres.forEach(r => {
            const f = cache.find(x => memesEquipes(x.home, r.home) && memesEquipes(x.away, r.away));
            if (f) { r.homeLogo = f.home_logo || null; r.awayLogo = f.away_logo || null; }
        });
        return rencontres.slice(0, 2);
    } catch (e) {
        return [];
    }
}

// Rappel des rencontres ajouté aux messages Telegram.
function rappelMatchs(matchs, dateStr) {
    if (!matchs || !matchs.length) return '';
    return '\n\n📋 Au programme :\n' + matchs.map(m => '⚽ ' + m.home + ' - ' + m.away + (m.heure ? ' · ' + String(m.heure).replace(':', 'h') : '')).join('\n')
        + (dateStr ? '\n📅 ' + dateLongue(dateStr) : '');
}

async function creerEtapeSequence(cle, canal, etape, v, now) {
    const deja = await sbFetch('pending_publications?overlay_data->>sequence_key=eq.' + encodeURIComponent(cle) + '&select=id&limit=1');
    if (deja && deja.length) return false;

    const base = {
        scheduled_for: now.dateStr,
        scheduled_time: hhmm(now.minutes),
        content_type: 'Séquence combiné',
        status: 'approved',
        overlay_data: { source: 'sequence', sequence_key: cle, etape }
    };
    let ligne;
    if (canal === 'telegram') {
        const texte = remplir(choisir(SEQ_TELEGRAM[etape], now.dateStr, etape.length), v);
        ligne = Object.assign(base, { platform: 'telegram', image_url: '', caption: texte + rappelMatchs(v.matchs, v.dateMatchs) + '\n\n' + CONTACT });
    } else {
        const modele = choisir(SEQ_STORY[etape], now.dateStr, etape.length);
        const { composerStory } = await import('./_compositeur.mjs');
        const image = await composerStory({
            fondUrl: await fondStoryRecent(now.dateStr, etape.length),
            badge: remplir(modele.badge, v),
            texte: remplir(modele.texte, v),
            matchs: v.matchs,
            dateTexte: v.dateMatchs ? dateLongue(v.dateMatchs) : null
        });
        const [url] = await televerserSlides('story-' + cle.replace(/[^\w-]/g, '_'), ['data:image/jpeg;base64,' + image.toString('base64')]);
        ligne = Object.assign(base, { platform: 'instagram', image_url: url, image_url_story: url, caption: remplir(modele.texte, v).replace(/\*/g, '') });
    }
    await sbFetch('pending_publications', { method: 'POST', body: JSON.stringify([ligne]) });
    return true;
}

// Promotion de l'app : une affiche par jour (Telegram + story), à 12h30.
const HEURE_PROMO = 12 * 60 + 30;
async function promotionQuotidienne(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_promo) return { actif: false };
    if (now.minutes < HEURE_PROMO || now.minutes >= HEURE_PROMO + 90) return { actif: true, attente: '12h30' };
    const creees = [];
    for (const canal of ['telegram', 'story']) {
        if (await creerEtapeSequence('promo:' + now.dateStr + ':' + canal, canal, 'promo', {}, now)) creees.push(canal);
    }
    return { actif: true, creees };
}

// ------------------------------------------------------------
// Récapitulatif des résultats, envoyé en privé à l'admin, au format des
// messages qu'il transfère ensuite sur le canal : une ligne par match avec sa
// cote réelle et le symbole du résultat. Tout vient des combinés validés par
// l'admin : aucune ligne n'est inventée.
// ------------------------------------------------------------
function dateCourte(dateStr) {
    const [a, m, j] = String(dateStr).split('-');
    return j + '.' + m + '.' + a;
}

async function recapResultats(dateStr) {
    const combos = await sbFetch('combineds_public?date=eq.' + dateStr + '&status=in.(termine,perdu)&select=id,status,matches,detected_scores') || [];
    if (!combos.length) return null;

    const blocs = [];
    for (const c of combos) {
        let vip = null;
        try { vip = (await sbFetch('combineds_vip?id=eq.' + c.id + '&select=matches,total_odds'))[0]; } catch (e) { vip = null; }
        const paris = (vip && vip.matches) || c.matches || [];
        const lignes = paris.map((m, i) => {
            const reel = (c.detected_scores && c.detected_scores[i]) || m.final_score || null;
            const gagne = reel && m.score
                ? String(reel).replace(/\s/g, '') === String(m.score).replace(/\s/g, '')
                : c.status === 'termine';
            const cote = Number(m.odds) > 0 ? Number(m.odds).toFixed(2) : null;
            return (cote || m.teams) + ' ' + (gagne ? '✅' : '❌');
        });
        const total = vip && vip.total_odds ? Number(vip.total_odds).toFixed(2) : null;
        blocs.push(lignes.join('\n') + (c.status === 'termine'
            ? '\n\nClean Sweep ! 💰' + (total ? '\nCote totale : ' + total : '')
            : '\n\nCombiné non validé cette fois.'));
    }

    // Bilan réel des 7 derniers jours (aucun chiffre arrondi ni embelli).
    const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - 6);
    const semaine = await sbFetch('combineds_public?date=gte.' + d.toISOString().slice(0, 10) + '&date=lte.' + dateStr + '&status=in.(termine,perdu)&select=status') || [];
    const gagnes = semaine.filter(x => x.status === 'termine').length;
    const bilan = semaine.length >= 2 ? '\n\n📊 Sur 7 jours : ' + gagnes + '/' + semaine.length + ' combinés validés.' : '';

    return '📅 ' + dateCourte(dateStr) + ' — SM VIP ⚽ Combiné 💰\n\n' + blocs.join('\n\n———\n\n') + bilan;
}

async function envoyerRecap(dateStr) {
    const texte = await recapResultats(dateStr);
    if (!texte) return null;
    await prevenirAdmin('📋 RÉCAP PRÊT À TRANSFÉRER\n\n— — — — —\n' + texte + '\n— — — — —\n\nCopie le bloc ci-dessus pour le transférer sur le canal.');
    return texte;
}

async function sequenceMarketing(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_sequence) return { actif: false };
    const bilan = { actif: true, creees: [] };

    // 0) Annonce du combiné : dès que ses visuels sont prêts (le combiné vient
    //    d'être lancé, en général entre 23h et minuit), l'annonce Telegram et la
    //    story Instagram préparées par l'app partent immédiatement.
    try {
        const annonces = await sbFetch('pending_publications?status=eq.pending&content_type=eq.' + encodeURIComponent('Combiné du jour')
            + '&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 12 * 3600000).toISOString())
            + '&select=id,platform,image_url,image_url_story,overlay_data') || [];
        for (const an of annonces) {
            const pret = an.platform === 'telegram' ? !!an.image_url : !!an.image_url_story;
            if (!pret) continue;
            await sbFetch('pending_publications?id=eq.' + an.id + '&status=eq.pending', {
                method: 'PATCH',
                body: JSON.stringify({
                    status: 'approved',
                    scheduled_for: now.dateStr,
                    scheduled_time: hhmm(now.minutes),
                    publish_as_story: true,
                    publish_as_post: false,
                    overlay_data: Object.assign({}, an.overlay_data, { auto_approuve_le: new Date().toISOString() })
                })
            });
            bilan.creees.push('annonce:' + an.platform);
        }
    } catch (err) { bilan.erreurAnnonce = String(err); }

    // 1) Relances autour du combiné du jour
    const combos = await sbFetch('combineds_public?date=eq.' + now.dateStr + '&status=eq.en-cours&select=id,time,nombre_matchs,matches') || [];
    let coupEnvoi = null, nbMatchs = 0;
    combos.forEach(c => {
        const heures = [minutesDe(c.time)].concat((c.matches || []).map(m => minutesDe(m.time))).filter(x => x !== null);
        heures.forEach(x => { if (coupEnvoi === null || x < coupEnvoi) coupEnvoi = x; });
        nbMatchs += c.nombre_matchs || (c.matches || []).length || 0;
    });
    if (coupEnvoi !== null) {
        const v = {
            heure: hhmm(coupEnvoi).replace(':', 'h'),
            n: nbMatchs ? nbMatchs + ' match' + (nbMatchs > 1 ? 's' : '') : '',
            matchs: await infosMatchs(now.dateStr),
            dateMatchs: now.dateStr
        };
        const etapes = [
            { etape: 'bonjour', debut: Math.max(coupEnvoi - 300, 9 * 60), fin: coupEnvoi - 150, canaux: ['telegram', 'story'] },
            { etape: 'relance', debut: coupEnvoi - 120, fin: coupEnvoi - 30, canaux: ['telegram', 'story'] },
            { etape: 'depart', debut: coupEnvoi - 15, fin: coupEnvoi + 10, canaux: ['telegram'] }
        ];
        for (const e of etapes) {
            if (e.debut >= e.fin || now.minutes < e.debut || now.minutes >= e.fin) continue;
            for (const canal of e.canaux) {
                try {
                    if (await creerEtapeSequence('seq:' + now.dateStr + ':' + e.etape + ':' + canal, canal, e.etape, v, now)) bilan.creees.push(e.etape + ':' + canal);
                } catch (err) { bilan.erreur = String(err); }
            }
        }
    }

    // 2) Résultat, une fois validé par l'admin (jamais la nuit)
    if (now.minutes >= 8 * 60) {
        const hier = new Date(now.dateStr + 'T12:00:00Z'); hier.setUTCDate(hier.getUTCDate() - 1);
        const valides = await sbFetch('combineds_public?date=gte.' + hier.toISOString().slice(0, 10) + '&status=in.(termine,perdu)&select=id,status,date') || [];
        for (const c of valides) {
            const etape = c.status === 'termine' ? 'victoire' : 'defaite';
            const v = { stat: await statTrenteJours(now.dateStr), matchs: await infosMatchs(c.date), dateMatchs: c.date };
            let nouveau = false;
            for (const canal of ['telegram', 'story']) {
                try {
                    if (await creerEtapeSequence('res:' + c.id + ':' + canal, canal, etape, v, now)) { bilan.creees.push(etape + ':' + canal); nouveau = true; }
                } catch (err) { bilan.erreur = String(err); }
            }
            if (nouveau) { try { await envoyerRecap(c.date); } catch (err) { /* récap au mieux */ } }
        }
    }
    return bilan;
}

// ------------------------------------------------------------
// Combiné automatique (Content Planner > Réglages)
//
// Règles fixées par l'admin :
// - un seul combiné en cours à la fois : tant que le combiné en cours n'est
//   pas validé (gagné ou perdu) par l'admin, rien n'est généré ;
// - le suivant est généré au plus tôt 1 h après cette validation, et
//   seulement entre 23h et minuit (pour le lendemain soir) ou entre minuit et
//   14h (pour le soir même) ; entre 14h et 23h, on attend 23h ;
// - uniquement des matchs du soir (coup d'envoi à 18h ou plus).
// Le combiné est d'abord un brouillon : l'admin est prévenu sur Telegram et
// peut l'annuler pendant 20 minutes, puis il est publié et annoncé.
//
// Choix des scores : pour chaque match, le score exact le plus probable selon
// les vraies cotes des bookmakers (API-Football), parmi ceux qui correspondent
// à l'issue prédite par l'analyse API-Football. Les cotes affichées sont ces
// vraies cotes.
// ------------------------------------------------------------
const { GRANDES_LIGUES, prioriteLigue } = require('./_ligues.js');
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY;
const VETO_MINUTES = 20;
const MISE_COMBINE = 100;
const BOOKMAKERS_PREFERES = [8, 3, 2, 36, 11]; // Bet365, Betfair, Marathonbet, BetVictor, 1xBet

async function apiFootballPublish(chemin) {
    const r = await fetch('https://v3.football.api-sports.io' + chemin, { headers: { 'x-apisports-key': APIFOOTBALL_KEY } });
    if (!r.ok) throw new Error('API-Football ' + chemin + ' -> ' + r.status);
    return r.json();
}

function heureParisDe(iso) {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
}
function lendemain(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}
function normaliser(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
function memesEquipes(a, b) {
    const x = normaliser(a), y = normaliser(b);
    return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
}

async function enregistrerReglages(patch) {
    await sbFetch('automation_settings?id=eq.singleton', { method: 'PATCH', body: JSON.stringify(Object.assign({ updated_at: new Date().toISOString() }, patch)) });
}

async function prevenirAdmin(message) {
    await sbFetch('telegram_queue', { method: 'POST', body: JSON.stringify([{ message }]) }).catch(function () {});
}

async function derniereValidation() {
    try {
        const rows = await sbFetch('combineds_public?validated_at=not.is.null&select=validated_at&order=validated_at.desc&limit=1');
        return rows && rows[0] ? Date.parse(rows[0].validated_at) : null;
    } catch (e) {
        return null; // colonne absente : la règle d'1 h ne peut pas s'appliquer
    }
}

// Rencontres du soir de la date visée, depuis le cache (ou l'API si vide).
async function rencontresDuSoir(cible) {
    let lignes = await sbFetch('ai_fixtures?fixture_date=eq.' + cible + '&select=*') || [];
    if (!lignes.length && APIFOOTBALL_KEY) {
        const fx = (await apiFootballPublish('/fixtures?date=' + cible)).response || [];
        lignes = fx.filter(x => GRANDES_LIGUES[x.league && x.league.id]).map(x => ({
            fixture_id: x.fixture.id, fixture_date: cible, kickoff: x.fixture.date,
            home: x.teams.home.name, away: x.teams.away.name,
            home_logo: x.teams.home.logo || null, away_logo: x.teams.away.logo || null,
            league_code: GRANDES_LIGUES[x.league.id].code, league_name: GRANDES_LIGUES[x.league.id].nom,
            country: x.league.country || null, flag: x.league.flag || null
        }));
    }
    const limite = Date.now() + 60 * 60000;
    return lignes.filter(l => {
        const heure = heureParisDe(l.kickoff);
        return heure >= '18:00' && Date.parse(l.kickoff) > limite && prioriteLigue(l.league_code) <= 2;
    }).sort((a, b) => (prioriteLigue(a.league_code) - prioriteLigue(b.league_code)) || (Date.parse(a.kickoff) - Date.parse(b.kickoff)));
}

// Score exact retenu pour une rencontre, avec sa vraie cote.
async function scoreExact(rencontre, pronostics) {
    const r = ((await apiFootballPublish('/odds?fixture=' + rencontre.fixture_id + '&bet=10')).response || [])[0];
    if (!r || !r.bookmakers || !r.bookmakers.length) return null;
    const bk = BOOKMAKERS_PREFERES.map(id => r.bookmakers.find(b => b.id === id)).find(Boolean) || r.bookmakers[0];
    const valeurs = ((bk.bets || [])[0] || {}).values || [];
    const p = pronostics.find(x => memesEquipes(x.home, rencontre.home) && memesEquipes(x.away, rencontre.away));
    let issue = null;
    if (p) {
        const max = Math.max(p.home_prob, p.draw_prob, p.away_prob);
        issue = p.home_prob === max ? 'domicile' : p.away_prob === max ? 'exterieur' : 'nul';
    }
    const coherent = v => {
        const m = String(v.value).match(/^(\d+):(\d+)$/);
        if (!m) return false;
        const a = +m[1], b = +m[2];
        if (issue === 'domicile') return a > b;
        if (issue === 'exterieur') return b > a;
        if (issue === 'nul') return a === b;
        return true;
    };
    const choix = valeurs.filter(coherent)
        .map(v => ({ score: String(v.value).replace(':', '-'), cote: parseFloat(v.odd) }))
        .filter(v => v.cote >= 4 && v.cote <= 20)
        .sort((a, b) => a.cote - b.cote)[0];
    return choix ? Object.assign({ bookmaker: bk.name }, choix) : null;
}

async function construireCombine(cible) {
    const candidats = (await rencontresDuSoir(cible)).slice(0, 8);
    if (candidats.length < 2) return null;
    const pronostics = await sbFetch('ai_predictions?fixture_date=eq.' + cible + '&select=home,away,home_prob,draw_prob,away_prob') || [];
    const retenus = [];
    let appels = 0;
    for (const c of candidats) {
        if (retenus.length >= 4 || appels >= 6) break;
        appels++;
        try {
            const s = await scoreExact(c, pronostics);
            if (s) retenus.push(Object.assign({ rencontre: c }, s));
        } catch (e) { /* cote indisponible pour ce match : on passe au suivant */ }
    }
    if (retenus.length < 2) return null;
    // Deux matchs aux coups d'envoi les plus proches, comme le générateur de l'app.
    let paire = [retenus[0], retenus[1]], ecart = Infinity;
    for (let i = 0; i < retenus.length; i++) for (let j = i + 1; j < retenus.length; j++) {
        const e = Math.abs(Date.parse(retenus[i].rencontre.kickoff) - Date.parse(retenus[j].rencontre.kickoff));
        if (e < ecart) { ecart = e; paire = [retenus[i], retenus[j]]; }
    }
    paire.sort((a, b) => Date.parse(a.rencontre.kickoff) - Date.parse(b.rencontre.kickoff));
    return paire.map(x => ({
        teams: x.rencontre.home + ' - ' + x.rencontre.away,
        score: x.score,
        odds: x.cote,
        time: heureParisDe(x.rencontre.kickoff),
        ligue: x.rencontre.league_name,
        flag: x.rencontre.flag || '',
        bookmaker: x.bookmaker
    }));
}

function drapeauHtml(url) {
    return url ? '<img src="' + url + '" style="width:16px;height:12px;object-fit:cover;border-radius:2px;vertical-align:middle;">' : '';
}

async function publierCombineAuto(b, now) {
    const matches = b.matches.map(m => ({ teams: m.teams, score: m.score, odds: m.odds, time: m.time, logo: '', league_flag: drapeauHtml(m.flag), match_status: 'en-cours', source: 'auto' }));
    const publics = b.matches.map(m => ({ teams: m.teams, time: m.time, score: '?-?', odds: 0, logo: '', league_flag: drapeauHtml(m.flag), match_status: 'en-cours' }));
    const total = Math.round(b.matches.reduce((t, m) => t * m.odds, 1) * 100) / 100;
    const pub = await sbFetch('combineds_public', {
        method: 'POST', headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{ date: b.cible, time: b.matches[0].time, status: 'en-cours', nombre_matchs: matches.length, matches: publics }])
    });
    const id = pub && pub[0] && pub[0].id;
    await sbFetch('combineds_vip', { method: 'POST', body: JSON.stringify([{ id, matches, mise: MISE_COMBINE, gains: Math.round(MISE_COMBINE * total * 100) / 100, total_odds: total }]) });

    // Annonce : même esprit que l'annonce de l'app, visuel assemblé ici.
    const lignesTexte = b.matches.map(m => '🏆 ' + m.teams + ' (' + m.time + ')').join('\n');
    const legende = '🏆 LE COMBINÉ DU JOUR EST DISPONIBLE !\n\nVoici les affiches retenues :\n' + lignesTexte
        + '\n\n⏰ Coup d\'envoi à ' + b.matches[0].time + '.\n\nComme toujours, l\'analyse complète est disponible dès maintenant dans votre espace VIP+ Score Master. 🙌'
        + '\n\n' + CONTACT;
    try {
        const { composerStory } = await import('./_compositeur.mjs');
        const image = await composerStory({
            fondUrl: await fondStoryRecent(now.dateStr, 3),
            badge: 'COMBINÉ DU JOUR',
            texte: 'Le combiné est *disponible*',
            matchs: await infosMatchs(b.cible),
            dateTexte: dateLongue(b.cible)
        });
        const [url] = await televerserSlides('annonce-' + id, ['data:image/jpeg;base64,' + image.toString('base64')]);
        const base = { scheduled_for: now.dateStr, scheduled_time: hhmm(now.minutes), content_type: 'Combiné du jour', status: 'approved', overlay_data: { source: 'combo-auto', combo_id: id } };
        await sbFetch('pending_publications', {
            method: 'POST', body: JSON.stringify([
                Object.assign({}, base, { platform: 'telegram', image_url: url, caption: legende }),
                Object.assign({}, base, { platform: 'instagram', image_url: url, image_url_story: url, publish_as_story: true, publish_as_post: false, caption: 'Le combiné du jour est disponible' })
            ])
        });
    } catch (e) {
        await prevenirAdmin('⚠️ Combiné publié, mais l\'annonce n\'a pas pu être préparée : ' + String(e).slice(0, 200));
    }
    await prevenirAdmin('✅ COMBINÉ AUTOMATIQUE PUBLIÉ (' + b.cible + ')\n\n' + b.matches.map(m => '• ' + m.teams + ' · ' + m.time + ' · ' + m.score + ' @ ' + m.odds).join('\n')
        + '\nCote totale : ' + total + '\n\nAnnonce envoyée sur Telegram et en story. La validation du résultat reste à toi.');
    return id;
}

async function combineAutomatique(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_combo) return { actif: false };
    const enCours = await sbFetch('combineds_public?status=eq.en-cours&select=id&limit=1') || [];
    const brouillon = reglages.combo_brouillon;

    if (brouillon) {
        if (brouillon.annule || enCours.length) {
            await enregistrerReglages({ combo_brouillon: null });
            return { actif: true, brouillon: brouillon.annule ? 'annulé par l\'admin' : 'abandonné : un combiné a été publié entre-temps' };
        }
        if (Date.now() >= Date.parse(brouillon.publier_a)) {
            await enregistrerReglages({ combo_brouillon: null });
            const id = await publierCombineAuto(brouillon, now);
            return { actif: true, publie: id };
        }
        return { actif: true, brouillon: 'publication à ' + heureParisDe(brouillon.publier_a) };
    }

    if (enCours.length) return { actif: true, attente: 'combiné en cours non validé' };
    let cible;
    if (now.minutes >= 23 * 60) cible = lendemain(now.dateStr);
    else if (now.minutes < 14 * 60) cible = now.dateStr;
    else return { actif: true, attente: 'fenêtre de 23h' };

    const validation = await derniereValidation();
    if (validation && Date.now() < validation + 60 * 60000) return { actif: true, attente: '1 h après la validation' };
    const existe = await sbFetch('combineds_public?date=eq.' + cible + '&select=id&limit=1') || [];
    if (existe.length) return { actif: true, attente: 'combiné déjà publié pour le ' + cible };
    if (reglages.combo_essai_le && Date.now() - Date.parse(reglages.combo_essai_le) < 60 * 60000) return { actif: true, attente: 'nouvel essai dans l\'heure' };

    await enregistrerReglages({ combo_essai_le: new Date().toISOString() });
    const matches = await construireCombine(cible);
    if (!matches) {
        await prevenirAdmin('ℹ️ Combiné automatique : aucun couple de matchs du soir exploitable pour le ' + cible + ' (cotes score exact indisponibles ou pas assez de rencontres). Nouvel essai dans une heure si la fenêtre le permet.');
        return { actif: true, rien: cible };
    }
    const publierA = new Date(Date.now() + VETO_MINUTES * 60000).toISOString();
    const total = Math.round(matches.reduce((t, m) => t * m.odds, 1) * 100) / 100;
    await enregistrerReglages({ combo_brouillon: { cible, matches, total, genere_le: new Date().toISOString(), publier_a: publierA } });
    await prevenirAdmin('🤖 COMBINÉ AUTOMATIQUE PRÊT — pour le ' + cible + '\n\n'
        + matches.map(m => '• ' + m.teams + ' (' + m.ligue + ') · ' + m.time + '\n   Score exact ' + m.score + ' @ ' + m.odds + ' (' + m.bookmaker + ')').join('\n')
        + '\n\nCote totale : ' + total + '\nPublication automatique à ' + heureParisDe(publierA) + ', sauf si tu l\'annules : Content Planner > Réglages > Gérer.');
    return { actif: true, brouillon: 'créé pour le ' + cible };
}

// ------------------------------------------------------------
// Rapport quotidien : l'agenda du lendemain, envoyé à l'admin sur Telegram
// (automatiquement à 23h45 si activé, ou à la demande depuis les Réglages).
// ------------------------------------------------------------
const HEURE_RAPPORT = 23 * 60 + 45;
const HEURE_TRAME = 19 * 60;   // 19h00 : trame des cotes à ajuster
const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function dateLongue(dateStr) {
    const d = new Date(dateStr + 'T12:00:00Z');
    return JOURS_FR[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MOIS_FR[d.getUTCMonth()];
}

async function construireRapport(cible) {
    const reglages = await lireReglagesAuto() || {};
    const lignes = [];
    const titre = dateLongue(cible);
    lignes.push('📅 AGENDA DE DEMAIN — ' + titre.charAt(0).toUpperCase() + titre.slice(1));
    lignes.push('');

    // 1) Carrousels Instagram
    let calendrier = [];
    try { calendrier = await (await fetch('https://scoremaster.fr/content-calendar.json', { cache: 'no-store' })).json(); } catch (e) { calendrier = []; }
    const debut = Date.parse('2026-09-21T12:00:00Z');
    const numero = Math.round((Date.parse(cible + 'T12:00:00Z') - debut) / 86400000) + 1;
    const entrees = (calendrier || []).filter(e => e.jour === numero);
    const lignesCal = await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar&platform=eq.instagram&scheduled_for=eq.' + cible + '&select=status,carousel_images,overlay_data') || [];
    const exclus = Array.isArray(reglages.exclusions) ? reglages.exclusions : [];
    lignes.push('🖼️ CARROUSELS INSTAGRAM');
    if (!entrees.length) lignes.push('• Aucun carrousel prévu.');
    entrees.forEach(e => {
        const l = lignesCal.find(x => x.overlay_data && x.overlay_data.calendar_id === e.id);
        let etat;
        if (exclus.indexOf(e.id) !== -1) etat = '⛔ exclu de l\'automatisation';
        else if (!l) etat = '⚠️ pas encore généré';
        else if (l.status === 'published') etat = '✅ publié';
        else if (l.status === 'approved') etat = '🟢 approuvé';
        else if (l.status === 'pending') etat = reglages.auto_publish ? '⏳ prêt — approuvé automatiquement à ' + String(reglages.auto_approve_at || '07:00').replace(':', 'h') : '⏳ prêt — à valider par toi';
        else if (l.status === 'failed') etat = '❌ échec — à régénérer';
        else etat = '🎨 en préparation';
        lignes.push('• ' + e.heure.replace(':', 'h') + ' — « ' + e.titre + ' » : ' + etat);
    });
    lignes.push('');

    // 2) Combiné
    lignes.push('🏆 COMBINÉ');
    const combos = await sbFetch('combineds_public?date=eq.' + cible + '&select=id,time,status,matches') || [];
    const brouillon = reglages.combo_brouillon && !reglages.combo_brouillon.annule && reglages.combo_brouillon.cible === cible ? reglages.combo_brouillon : null;
    let coupEnvoi = null;
    if (combos.length) {
        combos.forEach(c => {
            (c.matches || []).forEach(m => lignes.push('• ' + (m.time || '') + ' — ' + (m.teams || '')));
            [minutesDe(c.time)].concat((c.matches || []).map(m => minutesDe(m.time))).filter(x => x !== null).forEach(x => { if (coupEnvoi === null || x < coupEnvoi) coupEnvoi = x; });
        });
        lignes.push('Statut : ' + (combos[0].status === 'en-cours' ? 'publié, en cours' : combos[0].status === 'termine' ? 'gagné' : 'perdu'));
    } else if (brouillon) {
        brouillon.matches.forEach(m => lignes.push('• ' + m.time + ' — ' + m.teams + ' (score exact ' + m.score + ' @ ' + m.odds + ')'));
        lignes.push('Statut : brouillon, publication automatique à ' + heureParisDe(brouillon.publier_a) + ' sauf annulation.');
        coupEnvoi = minutesDe(brouillon.matches[0].time);
    } else {
        const enCours = await sbFetch('combineds_public?status=eq.en-cours&select=date&limit=1') || [];
        if (enCours.length) lignes.push('• Pas encore de combiné : celui du ' + enCours[0].date + ' est en cours. Le suivant sera généré 1 h après ta validation' + (reglages.auto_combo ? '.' : ' (combiné automatique désactivé).'));
        else if (reglages.auto_combo) lignes.push('• Pas encore de combiné : l\'agent en proposera un dès que des matchs du soir exploitables seront disponibles (fenêtre 23h–minuit, ou avant 14h pour le soir même).');
        else lignes.push('• Aucun combiné publié pour cette date (combiné automatique désactivé).');
    }
    lignes.push('');

    // 3) Séquence marketing
    lignes.push('📣 SÉQUENCE TELEGRAM + STORIES');
    if (reglages.auto_promo) lignes.push('• 12h30 — Promotion de l\'app Score Master (Telegram + story)');
    if (!reglages.auto_sequence) lignes.push('• Désactivée.');
    else if (coupEnvoi === null) lignes.push('• En attente du combiné : elle se calera sur son premier coup d\'envoi.');
    else {
        const bonjour = Math.max(coupEnvoi - 300, 9 * 60);
        if (bonjour < coupEnvoi - 150) lignes.push('• ' + hhmm(bonjour).replace(':', 'h') + ' — « Bonjour l\'équipe » (Telegram + story)');
        lignes.push('• ' + hhmm(coupEnvoi - 120).replace(':', 'h') + ' — Relance J-2h (Telegram + story)');
        lignes.push('• ' + hhmm(coupEnvoi - 15).replace(':', 'h') + ' — « C\'est parti » (Telegram)');
        lignes.push('• Coup d\'envoi à ' + hhmm(coupEnvoi).replace(':', 'h') + ', puis message victoire ou défaite après ta validation');
    }
    lignes.push('');

    // 4) Pronostics gratuits et points d'attention
    const pronos = await sbFetch('ai_predictions?fixture_date=eq.' + cible + '&select=home') || [];
    lignes.push('⚽ PRONOSTICS GRATUITS');
    lignes.push('• ' + (pronos.length ? pronos.length + ' matchs analysés pour la page Pronostics AI.' : 'Pas encore d\'analyses (le cron les prépare à 18h la veille et au matin).'));
    const echecs = await sbFetch('pending_publications?status=eq.failed&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 48 * 3600000).toISOString()) + '&select=content_type') || [];
    if (echecs.length) {
        lignes.push('');
        lignes.push('⚠️ À SURVEILLER');
        lignes.push('• ' + echecs.length + ' publication(s) en échec ces dernières 48 h : Content Planner > Valider.');
    }
    lignes.push('');
    lignes.push('Réglages : Content Planner > Réglages > Gérer.');
    return lignes.join('\n');
}

async function rapportAutomatique(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_rapport) return { actif: false };
    if (now.minutes < HEURE_RAPPORT) return { actif: true, attente: '23h45' };
    if (reglages.rapport_envoye_le === now.dateStr) return { actif: true, deja: true };
    await enregistrerReglages({ rapport_envoye_le: now.dateStr });
    await prevenirAdmin(await construireRapport(lendemain(now.dateStr)));
    return { actif: true, envoye: true };
}

// POST { action: 'recap-reseau' } (admin) : met en forme les pronostics
// transmis par le réseau de pronostiqueurs partenaires. L'admin colle ce qu'il
// a reçu (une ligne par pari : la cote, puis le résultat) ; rien n'est inventé
// ici, on ne fait que reprendre ses lignes dans le format du canal.
function analyserLignesReseau(brut) {
    return String(brut || '').split('\n').map(l => l.trim()).filter(Boolean).map(l => {
        const cote = (l.match(/(\d+[.,]\d+)/) || [])[1];
        if (!cote) return null;
        const perdu = /❌|✖|✗|perdu|lost|ko\b/i.test(l);
        const libelle = l.replace(/(\d+[.,]\d+)/, '').replace(/[✅✔☑❌✖✗]/g, '').replace(/\b(perdu|lost|gagn[ée]|won|ok|ko)\b/gi, '').replace(/^[\s\-–—:|]+|[\s\-–—:|]+$/g, '').replace(/\s{2,}/g, ' ').trim();
        return { cote: parseFloat(String(cote).replace(',', '.')), perdu, libelle };
    }).filter(Boolean).slice(0, 12);
}

// Brouillon du soir : quatre cotes dans la fourchette habituelle, envoyées en
// privé pour que l'admin n'ait plus qu'à remplacer par celles de son réseau.
function trameReseau(dateStr) {
    const lignes = [];
    for (let i = 0; i < 4; i++) lignes.push((1.5 + Math.random() * 0.5).toFixed(2) + ' ✅');
    return '📝 TRAME DU SOIR — remplace les cotes par celles de ton réseau\n\n— — — — —\n📅 '
        + dateCourte(dateStr) + ' — SM VIP ⚽ Chat 💰\n\n' + lignes.join('\n')
        + '\n\nClean Sweep ! 💰\n— — — — —';
}

async function trameAutomatique(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || reglages.auto_trame === false) return { actif: false };
    if (now.minutes < HEURE_TRAME) return { actif: true, attente: '19h00' };
    if (reglages.trame_envoyee_le === now.dateStr) return { actif: true, deja: true };
    await enregistrerReglages({ trame_envoyee_le: now.dateStr });
    await prevenirAdmin(trameReseau(now.dateStr));
    return { actif: true, envoye: true };
}

async function handleRecapReseau(req, res) {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken))) return res.status(403).json({ error: 'Accès refusé' });

    const corps = req.body || {};
    const paris = analyserLignesReseau(corps.lignes);
    if (!paris.length) return res.status(400).json({ error: 'Aucune ligne exploitable : mets une cote par ligne, par exemple « 1.91 ✅ ».' });

    const now = parisNowParts();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(corps.date || '') ? corps.date : now.dateStr;
    const source = String(corps.source || '').trim().slice(0, 40);
    const gagnes = paris.filter(x => !x.perdu).length;

    const entete = '📅 ' + dateCourte(date) + ' — ' + (source ? source : 'SM VIP') + ' ⚽ Chat 💰';
    const lignes = paris.map(x => x.cote.toFixed(2) + (x.libelle ? ' — ' + x.libelle : '') + ' ' + (x.perdu ? '❌' : '✅'));
    const total = paris.reduce((t, x) => t * (x.perdu ? 1 : x.cote), 1);
    const pied = gagnes === paris.length
        ? '\n\nClean Sweep ! 💰' + (paris.length > 1 ? '\nCote cumulée : ' + total.toFixed(2) : '')
        : '\n\n' + gagnes + '/' + paris.length + ' validés.';

    const texte = entete + '\n\n' + lignes.join('\n') + pied;
    await prevenirAdmin('📋 RÉCAP RÉSEAU — prêt à transférer\n\n— — — — —\n' + texte + '\n— — — — —');
    res.status(200).json({ ok: true, texte, gagnes, total: paris.length });
}

// POST { action: 'recap', date? } (admin) : récapitulatif des résultats d'un jour.
async function handleRecap(req, res) {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken))) return res.status(403).json({ error: 'Accès refusé' });
    const now = parisNowParts();
    let date = (req.body && req.body.date) || now.dateStr;
    let texte = await envoyerRecap(date);
    if (!texte) {
        // Rien aujourd'hui : on prend le dernier jour validé.
        const dernier = await sbFetch('combineds_public?status=in.(termine,perdu)&select=date&order=date.desc&limit=1');
        if (dernier && dernier[0]) { date = dernier[0].date; texte = await envoyerRecap(date); }
    }
    if (!texte) return res.status(200).json({ ok: false, message: 'Aucun combiné validé à récapituler.' });
    res.status(200).json({ ok: true, date, texte });
}

// POST { action: 'rapport' } (admin) : envoie tout de suite le rapport de demain.
async function handleRapport(req, res) {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken))) return res.status(403).json({ error: 'Accès refusé' });
    const now = parisNowParts();
    const texte = await construireRapport(lendemain(now.dateStr));
    await prevenirAdmin(texte);
    res.status(200).json({ ok: true, texte });
}

function parisNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

function isDue(item, now) {
    if (!item.scheduled_time || !item.scheduled_for) return true; // rétrocompatible : pas d'heure assignée -> publie dès approbation, comme avant
    if (item.scheduled_for < now.dateStr) return true; // date passée : rattrapage, publie
    if (item.scheduled_for > now.dateStr) return false; // date future : pas encore
    const [h, m] = item.scheduled_time.split(':').map(Number);
    return now.minutes >= (h * 60 + m);
}

async function handleCronSweep(req, res) {
    if (!CRON_SECRET) return res.status(500).json({ error: 'Variable d\'environnement manquante (CRON_SECRET).' });
    if ((req.query.secret || '') !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const summary = { checked: 0, published: [], waiting: [], errors: [] };
    const now = parisNowParts();
    try {
        summary.automatisation = await approuverAutomatiquement(now);
    } catch (e) {
        summary.automatisation = { erreur: String(e) };
    }
    try {
        summary.combine = await combineAutomatique(now);
    } catch (e) {
        summary.combine = { erreur: String(e) };
    }
    try {
        summary.promotion = await promotionQuotidienne(now);
    } catch (e) {
        summary.promotion = { erreur: String(e) };
    }
    try {
        summary.rapport = await rapportAutomatique(now);
        summary.trame = await trameAutomatique(now);
    } catch (e) {
        summary.rapport = { erreur: String(e) };
    }
    try {
        summary.sequence = await sequenceMarketing(now);
    } catch (e) {
        summary.sequence = { erreur: String(e) };
    }
    // Légendes préparées avant le changement de ligne éditoriale : la mention de
    // jeu responsable y figure encore, on la retire avant publication.
    try {
        const aNettoyer = await sbFetch('pending_publications?status=in.(pending,approved)&caption=like.*Jouer%20comporte%20des%20risques*&select=id,caption') || [];
        for (const l of aNettoyer) {
            const propre = String(l.caption)
                .split('\n')
                .filter(x => !/Jouer comporte des risques/i.test(x))
                .join('\n')
                .trim();
            await sbFetch('pending_publications?id=eq.' + l.id, { method: 'PATCH', body: JSON.stringify({ caption: propre }) });
        }
        if (aNettoyer.length) summary.legendesNettoyees = aNettoyer.length;
    } catch (e) { /* nettoyage au mieux : ne doit jamais bloquer la publication */ }

    const approvedAll = await sbFetch(`pending_publications?status=eq.approved&select=*`);
    const approved = approvedAll.filter(item => isDue(item, now));
    summary.checked = approved.length;
    summary.waiting = approvedAll.filter(item => !isDue(item, now)).map(item => ({ id: item.id, scheduled_for: item.scheduled_for, scheduled_time: item.scheduled_time }));

    let integrationsCache = null;
    async function getIntegrations() {
        if (!integrationsCache) integrationsCache = await postizFetch('/integrations');
        return integrationsCache;
    }

    for (const item of approved) {
        try {
            await postizPublish(item, await getIntegrations());
            await sbFetch(`pending_publications?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
            });
            summary.published.push({ id: item.id, platform: item.platform });
        } catch (innerErr) {
            await sbFetch(`pending_publications?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'failed', error: String(innerErr) })
            }).catch(function () {});
            summary.errors.push({ id: item.id, error: String(innerErr) });
        }
    }

    res.status(200).json(summary);
}

async function handleForcePublish(req, res) {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requis' });

    const rows = await sbFetch(`pending_publications?id=eq.${id}&select=*`);
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ error: 'Publication introuvable' });
    if (item.status !== 'approved') {
        return res.status(400).json({ error: `Statut actuel "${item.status}" — seules les publications "approved" peuvent être forcées.` });
    }

    try {
        const integrations = await postizFetch('/integrations');
        await postizPublish(item, integrations);
        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
        });
        res.status(200).json({ ok: true });
    } catch (error) {
        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: String(error) })
        }).catch(function () {});
        throw error;
    }
}

// POST { action: 'calendar-draft', secret, draft } — dépose un brouillon de
// carrousel issu du calendrier de contenu. Les images sont déjà générées
// (URLs Higgsfield) ; l'habillage texte + logo est fait ensuite côté app, à
// l'ouverture de l'onglet Publications, comme pour les autres carrousels.
async function handleCalendarDraft(req, res) {
    if (!CALENDAR_SECRET) return res.status(500).json({ error: 'CALENDAR_SECRET manquant côté serveur.' });
    const { secret, draft } = req.body || {};
    if (secret !== CALENDAR_SECRET) return res.status(403).json({ error: 'Secret invalide.' });
    if (!draft || !draft.calendar_id || !draft.caption || !Array.isArray(draft.slides) || !draft.slides.length) {
        return res.status(400).json({ error: 'draft.calendar_id, draft.caption et draft.slides sont requis.' });
    }
    if (draft.slides.some(function (s) { return !s || !s.image_url || !s.texte; })) {
        return res.status(400).json({ error: 'Chaque slide doit avoir image_url et texte.' });
    }

    // Mode essai (diagnostic) : assemble et stocke les visuels, renvoie leurs
    // URLs, sans créer aucune publication.
    if (draft.essai === true) {
        const debut = Date.now();
        const { assembler } = await import('./_compositeur.mjs');
        const images = await assembler(draft);
        const urls = await televerserSlides('essai-' + debut, images.map(function (b) { return 'data:image/jpeg;base64,' + b.toString('base64'); }));
        return res.status(200).json({ ok: true, essai: true, duree_ms: Date.now() - debut, urls });
    }

    // Les carrousels ne sont jamais publiés sur Telegram : un dépôt Telegram est
    // ignoré, et les éventuels brouillons Telegram de carrousels encore en attente
    // sont retirés au passage.
    if ((draft.platform || 'instagram') === 'telegram') {
        await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar&platform=eq.telegram&status=neq.published', { method: 'DELETE' }).catch(function () {});
        return res.status(200).json({ ok: true, skipped: 'telegram' });
    }

    // Idempotence : une même publication du calendrier n'est jamais déposée deux
    // fois pour la même plateforme (Instagram et Telegram ont chacun leur ligne).
    const query = 'pending_publications?select=id&overlay_data->>calendar_id=eq.'
        + encodeURIComponent(draft.calendar_id)
        + '&platform=eq.' + encodeURIComponent(draft.platform || 'instagram');
    const existing = await sbFetch(query);
    if (existing && existing.length) {
        return res.status(200).json({ ok: true, already: true, id: existing[0].id });
    }

    const row = {
        scheduled_for: draft.scheduled_for,
        scheduled_time: draft.scheduled_time,
        content_type: draft.content_type || 'Carrousel Calendrier',
        platform: draft.platform || 'instagram',
        caption: draft.caption,
        status: 'generating',
        overlay_data: {
            calendar_id: draft.calendar_id,
            titre: draft.titre || '',
            format: draft.format || '',
            format_nom: draft.format_nom || '',
            source: 'content-calendar',
            slides: draft.slides
        }
    };
    const inserted = await sbFetch('pending_publications', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([row])
    });

    const nouvelId = inserted && inserted[0] && inserted[0].id;

    // Slides déjà assemblées par la routine : plus besoin d'ouvrir l'app pour
    // l'habillage, le carrousel est tout de suite prêt à valider.
    let assemble = false;
    let composees = Array.isArray(draft.composed) ? draft.composed : null;
    // Carrousel duo déposé sans visuels assemblés (cas normal de la routine) :
    // le serveur les assemble lui-même avec le même rendu que l'app.
    const estDuo = draft.slides.every(function (s) { return s.page && s.position; });
    if (nouvelId && !composees && estDuo) {
        try {
            const { assembler } = await import('./_compositeur.mjs');
            const images = await assembler(draft);
            composees = images.map(function (b) { return 'data:image/jpeg;base64,' + b.toString('base64'); });
        } catch (e) {
            console.error('Assemblage serveur impossible :', e);
        }
    }
    if (nouvelId && composees && composees.length && composees.length <= 10) {
        try {
            const urls = await televerserSlides(nouvelId, composees);
            await sbFetch('pending_publications?id=eq.' + nouvelId, {
                method: 'PATCH',
                body: JSON.stringify({ carousel_images: urls, status: 'pending' })
            });
            assemble = true;
        } catch (e) {
            // Échec du stockage : la ligne reste « generating » et l'app fera
            // l'assemblage à l'ouverture, comme avant.
            console.error('Slides assemblées non stockées :', e);
        }
    }

    if (draft.request_id) {
        // Carrousel de test : la demande d'origine est traitée, on la retire de la file.
        await sbFetch('pending_publications?id=eq.' + encodeURIComponent(draft.request_id) + '&status=eq.requested', { method: 'DELETE' }).catch(function () {});
    } else if (nouvelId && draft.scheduled_for && draft.scheduled_time) {
        // Un nouveau carrousel du calendrier remplace tout brouillon non publié
        // déjà posé sur le même créneau (ex. ancien format déjà approuvé) : un
        // créneau ne publie jamais deux carrousels.
        await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar'
            + '&scheduled_for=eq.' + encodeURIComponent(draft.scheduled_for)
            + '&scheduled_time=eq.' + encodeURIComponent(draft.scheduled_time)
            + '&platform=eq.' + encodeURIComponent(draft.platform || 'instagram')
            + '&status=neq.published&id=neq.' + encodeURIComponent(nouvelId), { method: 'DELETE' }).catch(function () {});
    }

    // Notification Telegram privée à l'admin : une seule par publication (sur la
    // ligne Instagram, pas sur sa jumelle Telegram), pour ne pas doubler l'alerte.
    if ((draft.platform || 'instagram') === 'instagram') {
        const quand = draft.scheduled_time ? (' à ' + String(draft.scheduled_time).replace(':', 'h')) : '';
        const message = draft.request_id
            ? `🧪 CARROUSEL DE TEST PRÊT\n\n« ${draft.titre || draft.calendar_id} »\nPrévu le ${draft.scheduled_for}${quand} s'il est approuvé.\n\nOuvre l'app : Content Planner > Valider.`
            : `🗓️ CARROUSEL PRÊT À VALIDER\n\n« ${draft.titre || draft.calendar_id} »\nPrévu le ${draft.scheduled_for}${quand} sur Instagram.\n\nOuvre l'app : Content Planner > Valider.`;
        const reglagesAuto = draft.request_id ? null : await lireReglagesAuto();
        const complement = (reglagesAuto && reglagesAuto.auto_publish)
            ? `\n\n🤖 Automatisation active : approuvé automatiquement le ${draft.scheduled_for} à ${String(reglagesAuto.auto_approve_at || '07:00').replace(':', 'h')}, sauf si tu l'exclus (Content Planner > Réglages > Gérer).`
            : '';
        const apercu = assemble ? '' : '\nLes visuels s\'assembleront à l\'ouverture de l\'app.';
        await sbFetch('telegram_queue', {
            method: 'POST',
            body: JSON.stringify([{ message: message + apercu + complement }])
        }).catch(function () {});
    }

    res.status(200).json({ ok: true, id: nouvelId });
}

// ------------------------------------------------------------
// Carrousels de test demandés à la main depuis le Content Planner.
// L'app dépose une demande (statut "requested") ; la routine cloud
// « Carrousels manuels » la récupère, génère les images avec la mascotte, puis
// dépose le brouillon via calendar-draft (avec request_id).
// ------------------------------------------------------------
const MASCOTTE = '<<<5367a632-1402-4f89-8713-824bedb14457>>>';
const PERSONNAGE = 'the friendly grey and gold robot mascot with a golden crown, glowing yellow eyes behind a dark visor and a small golden shield crest on its chest, is the main character';
const INTERDITS = 'ABSOLUTE RULE: no text, no letters, no numbers, no logos and no readable signage anywhere in the image — captions and the Score Master logo are added separately afterwards. No real club crests, no real person\'s face.';
const FAMILLES_DUO = {
    R: 'Le bon réflexe', C: "Ce que tu vois / Ce qu'on calcule", E: "L'erreur / Le réflexe",
    M: 'Idée reçue / Réalité', P: 'Pressé / Patient', S: 'Coulisses Score Master'
};

function promptMoitie(scene, position) {
    const ambiance = position === 'haut'
        ? 'slightly cooler and muted color grading, a hint of tension'
        : 'warm golden color grading, calm and confident mood';
    return `${MASCOTTE} The mascot ${scene}. ${PERSONNAGE}, soft 3D toon character integrated into a realistic cinematic environment, ${ambiance}, rich environmental detail, eye-level shot, square 1:1 composition, subject centered, keep the lower fifth of the frame visually simple. ${INTERDITS}`;
}
function promptCta(scene) {
    return `${MASCOTTE} The mascot ${scene}. ${PERSONNAGE}, soft 3D toon character integrated into a realistic cinematic environment, warm golden color grading, vertical 9:16 composition, mascot in the upper half of the frame, the lower half darker and visually simple. ${INTERDITS}`;
}

async function handleManualRequest(req, res) {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken))) return res.status(403).json({ error: 'Accès refusé' });

    const r = (req.body && req.body.request) || {};
    const date = String(r.scheduled_for || '');
    const heure = String(r.scheduled_time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(heure)) {
        return res.status(400).json({ error: 'Date (AAAA-MM-JJ) et heure (HH:MM) requises.' });
    }
    // Carrousels : Instagram uniquement.
    const plateformes = ['instagram'];

    let demande;
    if (r.mode === 'banque') {
        if (!r.calendar_id) return res.status(400).json({ error: 'Choisis un carrousel de la banque.' });
        demande = { mode: 'banque', calendar_id: String(r.calendar_id) };
    } else if (r.mode === 'perso') {
        const duos = (Array.isArray(r.duos) ? r.duos : [])
            .map(d => ({ haut: String((d && d.haut) || '').trim().slice(0, 90), bas: String((d && d.bas) || '').trim().slice(0, 90) }))
            .filter(d => d.haut && d.bas);
        if (duos.length < 1 || duos.length > 6) return res.status(400).json({ error: 'Entre 1 et 6 slides duo, avec un texte en haut et en bas.' });
        demande = {
            mode: 'perso',
            famille: FAMILLES_DUO[r.famille] ? r.famille : 'R',
            titre: String(r.titre || 'Carrousel de test').slice(0, 80),
            duos,
            cta: String(r.cta || 'Un conseil par jour. *Zéro promesse.* Abonne-toi.').slice(0, 120),
            legende: String(r.legende || '').slice(0, 1500)
        };
    } else {
        return res.status(400).json({ error: 'Mode inconnu.' });
    }

    const lignes = await sbFetch('pending_publications', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
            scheduled_for: date,
            scheduled_time: heure,
            content_type: 'Carrousel Calendrier',
            platform: 'instagram',
            caption: 'Carrousel de test en attente de génération',
            status: 'requested',
            overlay_data: { source: 'manual-request', titre: demande.titre || demande.calendar_id, platforms: plateformes, demande }
        }])
    });
    res.status(200).json({ ok: true, id: lignes && lignes[0] && lignes[0].id });
}

// GET ?action=manual-queue&secret=CALENDAR_SECRET — demandes en attente, prêtes
// à générer : chaque slide porte son prompt final, sauf en mode personnalisé où
// la routine écrit la scène ({{SCENE}}) d'après la légende.
async function handleManualQueue(req, res) {
    if (!CALENDAR_SECRET || req.query.secret !== CALENDAR_SECRET) return res.status(401).json({ error: 'Secret invalide' });
    const demandes = await sbFetch('pending_publications?status=eq.requested&select=id,scheduled_for,scheduled_time,overlay_data&order=created_at.asc&limit=4') || [];
    if (!demandes.length) return res.status(200).json({ jobs: [] });

    let calendrier = null;
    const jobs = [];
    for (const d of demandes) {
        const od = d.overlay_data || {};
        const dem = od.demande || {};
        const base = {
            request_id: d.id,
            calendar_id: 'TEST-' + String(d.id).slice(0, 8),
            scheduled_for: d.scheduled_for,
            scheduled_time: d.scheduled_time,
            platforms: od.platforms || ['instagram']
        };
        if (dem.mode === 'banque') {
            if (!calendrier) {
                const r = await fetch('https://scoremaster.fr/content-calendar.json', { cache: 'no-store' });
                calendrier = await r.json();
            }
            const e = (calendrier || []).find(x => x.id === dem.calendar_id);
            if (!e) continue;
            jobs.push(Object.assign(base, {
                titre: e.titre, format: e.format, format_nom: e.format_nom,
                caption: [e.accroche, e.corps, e.cta, CONTACT, e.hashtags].filter(Boolean).join('\n\n'),
                slides: e.slides.map(s => ({ page: s.page, position: s.position, ratio: s.ratio || '9:16', prompt: s.prompt, texte: s.texte }))
            }));
        } else if (dem.mode === 'perso') {
            const slides = [];
            dem.duos.forEach((x, i) => {
                slides.push({ page: i + 1, position: 'haut', ratio: '1:1', prompt: promptMoitie('{{SCENE}}', 'haut'), texte: x.haut, scene_a_ecrire: true });
                slides.push({ page: i + 1, position: 'bas', ratio: '1:1', prompt: promptMoitie('{{SCENE}}', 'bas'), texte: x.bas, scene_a_ecrire: true });
            });
            slides.push({ page: dem.duos.length + 1, position: 'cta', ratio: '9:16', prompt: promptCta('waving at the viewer in front of a stadium at golden hour'), texte: dem.cta });
            const legende = dem.legende || (dem.titre + '\n\n' + dem.cta.replace(/\*/g, ''));
            jobs.push(Object.assign(base, {
                titre: dem.titre, format: dem.famille, format_nom: FAMILLES_DUO[dem.famille] || 'Test',
                caption: legende + '\n\n' + CONTACT + '\n\n#ScoreMaster #Football #PronosticsFootball',
                slides
            }));
        }
    }
    res.status(200).json({ jobs });
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !POSTIZ_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, POSTIZ_API_KEY).' });
    }

    try {
        if (req.method === 'GET' && req.query.action === 'manual-queue') return await handleManualQueue(req, res);
        if (req.method === 'GET') return await handleCronSweep(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'calendar-draft') return await handleCalendarDraft(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'manual-request') return await handleManualRequest(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'rapport') return await handleRapport(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'recap') return await handleRecap(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'recap-reseau') return await handleRecapReseau(req, res);
        if (req.method === 'POST') return await handleForcePublish(req, res);
        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
