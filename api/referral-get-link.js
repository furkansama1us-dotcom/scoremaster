// Génère (ou renvoie) le lien d'invitation Telegram personnel d'un membre,
// pour le système de parrainage : "invite 3 amis qui rejoignent le canal,
// débloque un pronostic VIP+ gratuit".
//
// Utilise un bot Telegram DÉDIÉ (REFERRAL_BOT_TOKEN, différent du bot
// Postiz) — Telegram interdit d'avoir deux consommateurs actifs (getUpdates)
// sur un même bot, donc ce second bot évite tout conflit avec Postiz.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const REFERRAL_BOT_TOKEN = process.env.REFERRAL_BOT_TOKEN;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1001477645066';

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

async function getUser(accessToken) {
    if (!accessToken) return null;
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': `Bearer ${accessToken}` }
    });
    if (!res.ok) return null;
    const user = await res.json();
    return (user && user.id) ? user : null;
}

// Campagne « 5 filleuls = un combiné score exact », ouverte jusqu'au 31/10.
const CAMPAGNE_SEUIL = 5;
const CAMPAGNE_FIN = '2026-10-31';

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée' });
    if (!SUPABASE_SERVICE_ROLE_KEY || !REFERRAL_BOT_TOKEN) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, REFERRAL_BOT_TOKEN).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const user = await getUser(accessToken);
        if (!user) return res.status(401).json({ error: 'Non authentifié' });

        const rows = await sbFetch(`profiles?id=eq.${user.id}&select=referral_invite_link,referral_joins_count,referral_rewards_claimed,username,campagne_recompense_le`);
        const profile = rows && rows[0];
        if (!profile) return res.status(404).json({ error: 'Profil introuvable' });

        // { action: 'campagne' } : avancement détaillé, filleul par filleul.
        if (req.body && req.body.action === 'campagne') {
            const filleuls = await sbFetch(`referral_joins?parrain_id=eq.${user.id}&select=telegram_username,telegram_nom,statut,motif,rejoint_le&order=rejoint_le.desc`).catch(() => []) || [];
            const valides = filleuls.filter(f => f.statut === 'valide').length;
            return res.status(200).json({
                inviteLink: profile.referral_invite_link || null,
                seuil: CAMPAGNE_SEUIL,
                fin: CAMPAGNE_FIN,
                ouverte: new Date().toISOString().slice(0, 10) <= CAMPAGNE_FIN,
                valides,
                recompenseLe: profile.campagne_recompense_le || null,
                filleuls: filleuls.map(f => ({
                    // On ne renvoie jamais l'identifiant Telegram du filleul.
                    nom: f.telegram_username ? '@' + f.telegram_username : (f.telegram_nom || 'Invité'),
                    statut: f.statut,
                    motif: f.motif || null,
                    le: f.rejoint_le
                }))
            });
        }

        if (profile.referral_invite_link) {
            return res.status(200).json({
                inviteLink: profile.referral_invite_link,
                joinsCount: profile.referral_joins_count,
                rewardsClaimed: profile.referral_rewards_claimed
            });
        }

        const linkName = (profile.username || user.id.slice(0, 8)).slice(0, 32);
        const tgRes = await fetch(`https://api.telegram.org/bot${REFERRAL_BOT_TOKEN}/createChatInviteLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TELEGRAM_CHANNEL_ID, name: `ref-${linkName}` })
        });
        const tgData = await tgRes.json();
        if (!tgRes.ok || !tgData.ok) throw new Error('Telegram createChatInviteLink -> ' + JSON.stringify(tgData));

        const inviteLink = tgData.result.invite_link;
        await sbFetch(`profiles?id=eq.${user.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ referral_invite_link: inviteLink })
        });

        res.status(200).json({ inviteLink, joinsCount: 0, rewardsClaimed: 0 });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
