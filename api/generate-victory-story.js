// Déclenché automatiquement en même temps que la publication de victoire
// "classique" (message + photo générique sur Telegram), pour produire EN
// PLUS un visuel dédié à Instagram : écussons réels des équipes (via
// TheSportsDB, jamais dessinés par l'IA), score, barres de probabilité et
// sceau "Score Master" habillés en Canvas côté client, sur un fond
// Higgsfield SANS AUCUN TEXTE (même règle que le reste de l'app).
//
// Comme /api/generate-conseil-content, ce endpoint ne fait que soumettre
// la génération Higgsfield et déposer un brouillon "generating" avec les
// données de match dans overlay_data — c'est le client (index.html,
// compositeVictoryStory()) qui habille le texte une fois le fond prêt,
// avant d'envoyer le PNG final à /api/upload-composited-image. Rien n'est
// publié sans validation admin dans l'onglet Publications.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;

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

async function submitHiggsfield(prompt, aspect) {
    const res = await fetch('https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard', {
        method: 'POST',
        headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspect_ratio: aspect })
    });
    if (!res.ok) throw new Error(`Higgsfield submit -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (!data.status_url) throw new Error('Higgsfield: pas de status_url dans la réponse: ' + JSON.stringify(data));
    return data.status_url;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_SERVICE_ROLE_KEY || !HF_KEY_ID || !HF_KEY_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, HF_KEY_ID, HF_KEY_SECRET).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { caption, imagePrompt, dateStr, overlayData } = req.body || {};
        if (!caption || !imagePrompt || !overlayData) {
            return res.status(400).json({ error: 'caption, imagePrompt et overlayData requis' });
        }

        const statusUrl = await submitHiggsfield(imagePrompt, '9:16');

        const rows = await sbFetch('pending_publications', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: dateStr || new Date().toISOString().slice(0, 10),
                content_type: 'Victoire Story',
                platform: 'instagram',
                caption: caption,
                image_url: '',
                status: 'generating',
                hf_status_url: statusUrl,
                overlay_data: overlayData
            }])
        });

        res.status(200).json({ rows: (rows || []).map(r => ({ id: r.id, platform: r.platform })), statusUrl });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
