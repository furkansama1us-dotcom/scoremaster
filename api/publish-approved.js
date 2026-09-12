// Publie les brouillons approuvés depuis le Panel Admin > Publications.
// Appelé périodiquement par le même cron VPS que auto-confirm (toutes les X min)
// via GET /api/publish-approved?secret=...
//
// - platform "instagram" -> publié immédiatement via l'API Postiz
// - platform "telegram"  -> publié immédiatement via l'API Postiz (canal
//   Telegram connecté)
//
// Utilise la clé service_role Supabase (bypass RLS) + la clé API Postiz :
// toutes deux lues uniquement depuis les variables d'environnement Vercel,
// jamais committées dans le code.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
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
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${path} -> ${res.status}: ${text}`);
    }
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

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET || !POSTIZ_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, POSTIZ_API_KEY).' });
    }
    if ((req.query.secret || '') !== CRON_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    const summary = { checked: 0, published: [], errors: [] };

    try {
        const approved = await sbFetch(`pending_publications?status=eq.approved&select=*`);
        summary.checked = approved.length;

        let integrationsCache = null;
        async function getIntegrations() {
            if (!integrationsCache) integrationsCache = await postizFetch('/integrations');
            return integrationsCache;
        }

        for (const item of approved) {
            try {
                if (item.platform === 'instagram') {
                    const integrations = await getIntegrations();
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
                    const integrations = await getIntegrations();
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
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
