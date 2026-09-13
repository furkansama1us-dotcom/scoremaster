// Fusion de proxy-image.js et upload-composited-image.js dans un seul
// fichier, pour rester sous la limite de 12 fonctions serverless du plan
// Vercel Hobby. Deux actions distinctes, sélectionnées par `action` dans
// le corps de la requête :
//
// - action:"proxy"  { url } -> télécharge une image distante (ex: fond
//   Higgsfield sur CloudFront) et la renvoie en base64, pour que le
//   navigateur puisse la charger dans un <canvas> SANS être bloqué par le
//   CORS de l'hébergeur d'origine (un canvas rempli d'une image
//   cross-origin non autorisée par CORS devient "tainted" et impossible à
//   exporter en toDataURL/toBlob — une data: URI est toujours considérée
//   same-origin par le navigateur).
//
// - action:"upload" { id, imageDataUri } -> reçoit l'image finale (fond +
//   texte habillé en Canvas côté client) en base64, l'upload dans le
//   bucket Supabase Storage public "content-images", puis passe la
//   publication en "pending" (prête à approuver dans Publications) avec
//   l'URL de l'image composée.

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

async function handleProxy(req, res) {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'url requise' });

    const imgRes = await fetch(url);
    if (!imgRes.ok) throw new Error(`Téléchargement image -> ${imgRes.status}`);
    const contentType = imgRes.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await imgRes.arrayBuffer());

    res.status(200).json({ dataUri: `data:${contentType};base64,${buf.toString('base64')}` });
}

async function handleUpload(req, res) {
    const { id, imageDataUri, field } = req.body || {};
    if (!id || !imageDataUri || !imageDataUri.startsWith('data:image/')) {
        return res.status(400).json({ error: 'id et imageDataUri (data:image/...) requis' });
    }

    const match = imageDataUri.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return res.status(400).json({ error: 'imageDataUri invalide' });
    const contentType = match[1];
    const ext = contentType.split('/')[1] || 'png';
    const buf = Buffer.from(match[2], 'base64');

    // `field`: 'story' ou 'post' -> upload dans une colonne dédiée (une publication
    // Instagram peut avoir les deux formats à choisir au moment d'approuver).
    // Sans `field` (rétrocompatible : Conseil IA, Victoire classique Telegram) ->
    // upload dans image_url comme avant, et passe la ligne en "pending".
    const suffix = field === 'story' ? '-story' : field === 'post' ? '-post' : '';
    const objectPath = `conseil-ia/${id}${suffix}.${ext}`;
    const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${objectPath}`, {
        method: 'POST',
        headers: {
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': contentType,
            'x-upsert': 'true'
        },
        body: buf
    });
    if (!uploadRes.ok) throw new Error(`Supabase Storage upload -> ${uploadRes.status}: ${await uploadRes.text()}`);

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${objectPath}`;

    const patch = field === 'story' ? { image_url_story: publicUrl }
        : field === 'post' ? { image_url_post: publicUrl }
        : { image_url: publicUrl, status: 'pending' };
    await sbFetch(`pending_publications?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });

    res.status(200).json({ ok: true, imageUrl: publicUrl });
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

        const action = (req.body && req.body.action) || 'proxy';
        if (action === 'upload') return await handleUpload(req, res);
        return await handleProxy(req, res);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
