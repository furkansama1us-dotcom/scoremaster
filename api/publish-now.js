// Force la publication immédiate d'UNE publication déjà "approved", sans
// attendre le prochain passage du cron VPS (toutes les 15 min sur
// /api/publish-approved). Appelé depuis le bouton "Publier maintenant" du
// Panel Admin (onglet Publications), avec le token de session de l'admin
// connecté — contrairement à publish-approved.js qui utilise un secret cron
// dédié pour l'appel automatisé côté serveur.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN || 'postiz.srv1960340.hstgr.cloud';

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

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_SERVICE_ROLE_KEY || !POSTIZ_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, POSTIZ_API_KEY).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
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

        const integrations = await postizFetch('/integrations');

        if (item.platform === 'instagram') {
            const ig = (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('instagram') !== -1; });
            if (!ig) throw new Error('Aucune intégration Instagram trouvée sur Postiz');
            await postizFetch('/posts', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'now',
                    date: new Date().toISOString(),
                    shortLink: false,
                    tags: [],
                    posts: [{
                        integration: { id: ig.id },
                        value: [{ content: item.caption, image: [{ id: item.id, path: item.image_url }] }],
                        settings: { __type: 'instagram', post_type: 'post' }
                    }]
                })
            });
        } else if (item.platform === 'telegram') {
            const tg = (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('telegram') !== -1; });
            if (!tg) throw new Error('Aucune intégration Telegram trouvée sur Postiz');
            await postizFetch('/posts', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'now',
                    date: new Date().toISOString(),
                    shortLink: false,
                    tags: [],
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

        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        await sbFetch(`pending_publications?id=eq.${req.body && req.body.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: String(error) })
        }).catch(function () {});
        res.status(500).json({ error: String(error) });
    }
};
