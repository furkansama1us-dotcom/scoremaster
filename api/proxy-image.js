// Récupère une image distante (ex: fond généré par Higgsfield, hébergé sur
// CloudFront) et la renvoie en base64, pour que le navigateur puisse la
// charger dans un <canvas> SANS être bloqué par le CORS de l'hébergeur
// d'origine (un canvas rempli d'une image cross-origin non autorisée par
// CORS devient "tainted" et impossible à exporter en toDataURL/toBlob).
// Une data: URI est toujours considérée same-origin par le navigateur.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        return res.status(500).json({ error: 'Variable d\'environnement manquante (SUPABASE_SERVICE_ROLE_KEY).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { url } = req.body || {};
        if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requise' });

        const imgRes = await fetch(url);
        if (!imgRes.ok) throw new Error(`Téléchargement image -> ${imgRes.status}`);
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        const buf = Buffer.from(await imgRes.arrayBuffer());

        res.status(200).json({ dataUri: `data:${contentType};base64,${buf.toString('base64')}` });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
