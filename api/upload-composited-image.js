// Reçoit l'image finale (fond Higgsfield + texte habillé en Canvas côté
// client) en base64, l'upload dans le bucket Supabase Storage public
// "content-images", puis passe la publication en "pending" (prête à
// approuver dans l'onglet Publications) avec l'URL de l'image composée.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'content-images';

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

        const { id, imageDataUri } = req.body || {};
        if (!id || !imageDataUri || !imageDataUri.startsWith('data:image/')) {
            return res.status(400).json({ error: 'id et imageDataUri (data:image/...) requis' });
        }

        const match = imageDataUri.match(/^data:(image\/\w+);base64,(.+)$/);
        if (!match) return res.status(400).json({ error: 'imageDataUri invalide' });
        const contentType = match[1];
        const ext = contentType.split('/')[1] || 'png';
        const buf = Buffer.from(match[2], 'base64');

        const objectPath = `conseil-ia/${id}.${ext}`;
        const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': contentType,
                'x-upsert': 'true'
            },
            body: buf
        });
        if (!uploadRes.ok) throw new Error(`Supabase Storage upload -> ${uploadRes.status}: ${await uploadRes.text()}`);

        const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ image_url: publicUrl, status: 'pending' })
        });

        res.status(200).json({ ok: true, imageUrl: publicUrl });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
