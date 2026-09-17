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
                    value: [{ content: item.caption, image: [{ id: item.id, path: item.image_url }] }],
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
    const approvedAll = await sbFetch(`pending_publications?status=eq.approved&select=*`);
    const now = parisNowParts();
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

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !POSTIZ_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, POSTIZ_API_KEY).' });
    }

    try {
        if (req.method === 'GET') return await handleCronSweep(req, res);
        if (req.method === 'POST') return await handleForcePublish(req, res);
        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
