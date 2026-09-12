// Publie un message directement sur le canal Telegram public via Postiz.
// Appelé depuis le Panel Admin (index.html) pour les contenus destinés au
// public (relance, annonce victoire, combiné disponible...) — remplace
// l'ancien circuit telegram_queue qui envoyait ces messages en DM au bot
// au lieu de les poster sur le canal.
//
// Auth : le client envoie le token de session Supabase de l'admin connecté
// (Authorization: Bearer <access_token>). On vérifie ici que ce user existe
// et a is_admin=true avant de publier quoi que ce soit.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN || 'postiz.srv1960340.hstgr.cloud';

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }, options));
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

async function postizFetch(path, options) {
    const res = await fetch(`https://${POSTIZ_DOMAIN}/api/public/v1${path}`, Object.assign({
        headers: Object.assign({
            'Authorization': POSTIZ_API_KEY,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }, options));
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

        const { message, imageUrl } = req.body || {};
        if (!message || !String(message).trim()) {
            return res.status(400).json({ error: 'Message manquant' });
        }

        const integrations = await postizFetch('/integrations');
        const tg = (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('telegram') !== -1; });
        if (!tg) throw new Error('Aucune intégration Telegram trouvée sur Postiz');

        const value = imageUrl
            ? [{ content: message, image: [{ id: 'manual-' + Date.now(), path: imageUrl }] }]
            : [{ content: message }];

        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now',
                date: new Date().toISOString(),
                shortLink: false,
                tags: [],
                posts: [{
                    integration: { id: tg.id },
                    value,
                    settings: { __type: 'telegram' }
                }]
            })
        });

        res.status(200).json({ ok: true });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
