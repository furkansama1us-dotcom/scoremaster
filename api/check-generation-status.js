// Vérifie (un seul appel, pas de boucle) où en est une génération Higgsfield
// démarrée par /api/generate-content-now. Appelé en polling toutes les
// quelques secondes par le client tant que le statut est "generating".
// Une fois l'image prête, met à jour les lignes pending_publications
// correspondantes (image_url + status='pending', prêt à approuver).

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

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_SERVICE_ROLE_KEY || !HF_KEY_ID || !HF_KEY_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes.' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { statusUrl, rowIds } = req.body || {};
        if (!statusUrl || !Array.isArray(rowIds) || !rowIds.length) {
            return res.status(400).json({ error: 'statusUrl et rowIds requis' });
        }

        const statusRes = await fetch(statusUrl, { headers: { Authorization: `Key ${HF_KEY_ID}:${HF_KEY_SECRET}` } });
        if (!statusRes.ok) throw new Error(`Higgsfield status -> ${statusRes.status}: ${await statusRes.text()}`);
        const statusData = await statusRes.json();

        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            const url = statusData.images?.[0]?.url || statusData.result?.url || statusData.output?.[0]?.url || statusData.url;
            if (!url) throw new Error('Higgsfield: génération terminée mais URL introuvable.');

            for (const id of rowIds) {
                await sbFetch(`pending_publications?id=eq.${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ image_url: url, status: 'pending' })
                });
            }
            return res.status(200).json({ done: true, imageUrl: url });
        }

        if (statusData.status === 'failed' || statusData.status === 'error') {
            const errMsg = 'Higgsfield: génération échouée: ' + JSON.stringify(statusData).slice(0, 300);
            for (const id of rowIds) {
                await sbFetch(`pending_publications?id=eq.${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: 'failed', error: errMsg })
                });
            }
            return res.status(200).json({ done: true, failed: true, error: errMsg });
        }

        res.status(200).json({ done: false });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
