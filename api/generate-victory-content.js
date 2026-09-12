// Déclenché automatiquement quand l'admin valide un combiné comme GAGNÉ
// (ou manuellement via le bouton "Gagné" dans le Panel Admin).
//
// Contrairement à /api/generate-content-now, la légende (message de
// victoire "Maître Gon") et le prompt image sont déjà construits côté
// client — pas besoin de Claude ici. On soumet juste la génération
// Higgsfield et on dépose un brouillon "generating" dans pending_publications
// (platform: telegram), comme le reste du Calendrier de contenu.
//
// /api/check-generation-status (déjà utilisé par le Calendrier) vient
// ensuite compléter l'image une fois prête et passer le statut à "pending"
// (prêt à approuver dans l'onglet Publications). Rien n'est publié tant
// que l'admin n'a pas cliqué "Approuver" — c'est /api/publish-approved
// (cron) qui s'en charge ensuite, texte + photo ensemble sur Telegram.

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

        const { caption, imagePrompt, dateStr } = req.body || {};
        if (!caption || !imagePrompt) {
            return res.status(400).json({ error: 'caption et imagePrompt requis' });
        }

        const statusUrl = await submitHiggsfield(imagePrompt, '1:1');

        const rows = await sbFetch('pending_publications', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: dateStr || new Date().toISOString().slice(0, 10),
                content_type: 'Victoire',
                platform: 'telegram',
                caption: caption,
                image_url: '',
                status: 'generating',
                hf_status_url: statusUrl
            }])
        });

        res.status(200).json({ rows: (rows || []).map(r => ({ id: r.id, platform: r.platform })), statusUrl });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
