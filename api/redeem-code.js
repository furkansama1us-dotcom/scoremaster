// Rédemption d'un code d'accès pack (Journalier/Hebdo/SM VIP+), voir
// vip_access_codes dans supabase_orders_setup.sql.
//
// Volontairement côté serveur (clé service_role) : is_vip/vip_pack_type
// changent le rôle du compte, donc ne doivent JAMAIS être modifiables
// directement par le client avec la clé anon (n'importe qui pourrait sinon
// s'auto-passer VIP+ via les devtools, sans code). Le client envoie
// uniquement le code saisi + son token de session ; ce endpoint vérifie
// l'identité, verrouille le code de façon atomique (used=false comme
// condition de la mise à jour, pour éviter qu'il soit utilisé deux fois en
// cas de double clic/requêtes concurrentes) puis met à jour le profil.

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
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${path} -> ${res.status}: ${text}`);
    }
    return res.status === 204 ? null : res.json();
}

async function getUserFromToken(accessToken) {
    if (!accessToken) return null;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return (user && user.id) ? user : null;
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquant dans les variables d\'environnement Vercel.' });

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    const user = await getUserFromToken(accessToken);
    if (!user) return res.status(401).json({ error: 'Non authentifié' });

    const code = ((req.body && req.body.code) || '').trim().toUpperCase();
    if (!code) return res.status(400).json({ error: 'Code requis' });

    try {
        const rows = await sbFetch(`vip_access_codes?code=eq.${encodeURIComponent(code)}&used=eq.false&select=*`);
        const packCode = rows && rows[0];
        if (!packCode) return res.status(404).json({ error: 'Code invalide, déjà utilisé, ou expiré.' });

        // Verrou optimiste : la condition used=eq.false dans l'URL fait que
        // seule UNE requête concurrente peut réussir à marquer ce code utilisé.
        // Code "Testeur" : usage unique, 5 minutes, AUCUN accès supplémentaire.
        // is_vip et vip_pack_type ne sont jamais touchés : le compte garde
        // exactement les droits d'un visiteur, seul le libellé du rôle change.
        if (packCode.pack_type === 'testeur') {
            const claimedTest = await sbFetch(`vip_access_codes?id=eq.${packCode.id}&used=eq.false`, {
                method: 'PATCH',
                headers: { 'Prefer': 'return=representation' },
                body: JSON.stringify({ used: true, used_by: user.id, used_at: new Date().toISOString() })
            });
            if (!claimedTest || !claimedTest.length) return res.status(409).json({ error: 'Ce code vient d\'être utilisé.' });

            const testerUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
            await sbFetch(`profiles?id=eq.${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ tester_until: testerUntil })
            });
            return res.status(200).json({ ok: true, pack_type: 'testeur', tester_until: testerUntil });
        }

        const claimed = await sbFetch(`vip_access_codes?id=eq.${packCode.id}&used=eq.false`, {
            method: 'PATCH',
            headers: { 'Prefer': 'return=representation' },
            body: JSON.stringify({ used: true, used_by: user.id, used_at: new Date().toISOString() })
        });
        if (!claimed || !claimed.length) return res.status(409).json({ error: 'Ce code vient d\'être utilisé.' });

        const expiresAt = packCode.duration_days
            ? new Date(Date.now() + packCode.duration_days * 24 * 60 * 60 * 1000).toISOString()
            : null;

        await sbFetch(`profiles?id=eq.${user.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ is_vip: true, vip_expires_at: expiresAt, vip_pack_type: packCode.pack_type })
        });

        res.status(200).json({ ok: true, pack_type: packCode.pack_type, duration_days: packCode.duration_days });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
