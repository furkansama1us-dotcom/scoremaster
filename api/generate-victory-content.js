// Déclenché automatiquement quand l'admin valide un combiné comme GAGNÉ
// (ou manuellement via le bouton "Gagné" dans le Panel Admin).
//
// La légende est écrite par Claude à chaque appel (prompt "community
// manager" fourni par l'admin) à partir des données RÉELLES du ticket
// (date, matchs, scores) transmises par le client — Claude n'invente
// jamais de résultat, il ne fait que rédiger. Ça évite le côté répétitif
// d'un texte tiré d'une liste statique. Le prompt image reste construit
// côté client (buildVictoryImagePromptRaw) et soumis ici à Higgsfield.
// On dépose ensuite un brouillon "generating" dans pending_publications
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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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

async function draftVictoryCaption(matches, dateStr) {
    const ticketDate = new Date(dateStr).toLocaleDateString('fr-FR');
    const matchLines = (matches || []).map(m => `${m.teams} | Score : ${m.score}`).join('\n');

    const prompt = `Tu es le community manager de ScoreMaster, spécialisé dans les pronostics sportifs.

À partir des informations que je vais te fournir, rédige une publication dynamique, professionnelle et percutante destinée à Telegram et aux réseaux sociaux.

OBJECTIF :
Mettre en avant un ticket honoré, valoriser la régularité et le sérieux de ScoreMaster, renforcer la confiance des abonnés et encourager les personnes intéressées à rejoindre la communauté.

STYLE :
- Ton dynamique, confiant et professionnel
- Accroche forte dès la première ligne
- Utiliser des emojis pertinents sans en abuser
- Texte facile à lire sur mobile
- IMPORTANT : n'utilise JAMAIS de markdown (pas d'astérisques *, pas de dièse #, pas de tirets de liste) — Telegram ne l'interprète pas ici, ça s'afficherait tel quel. Pour mettre en avant une info importante, utilise plutôt des MAJUSCULES ou un emoji, jamais des astérisques.
- Donner une impression de sérieux, de régularité et de professionnalisme
- Éviter les formulations trop longues
- Ne jamais promettre de gains garantis
- Ne jamais inventer de résultats ou d'informations autres que celles fournies ci-dessous
- Créer un sentiment de satisfaction et de confiance sans exagération
- Varie la formulation à chaque génération (accroche, tournures de phrase) pour ne jamais sonner répétitif ou robotique

STRUCTURE (respecte cet ordre, avec un saut de ligne entre chaque bloc) :
🔥 Une accroche courte et percutante
📈 Une phrase mettant en avant le ticket honoré et la régularité
📋 Les détails du ticket avec chaque match et son score
💪 Une phrase forte sur la rigueur, la régularité ou la confiance
🤝 Un message de remerciement aux abonnés
🚀 Un appel à l'action
🌐 Le site web
📲 Le Telegram

DONNÉES DU JOUR (réelles, à utiliser telles quelles, sans rien inventer) :
Date : ${ticketDate}
Ticket honoré : OUI
Matchs :
${matchLines}
Site Web : https://scoremaster.fr/
Telegram : @ScoreMasterOfficiel

Génère UNIQUEMENT la publication finale, prête à être copiée-collée sur Telegram, sans aucun texte autour (pas d'introduction, pas de commentaire).`;

    const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 1024,
            messages: [{ role: 'user', content: prompt }]
        })
    });
    if (!res.ok) throw new Error(`Anthropic API -> ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.content[0].text.trim();
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
    if (!SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY || !HF_KEY_ID || !HF_KEY_SECRET) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, HF_KEY_ID, HF_KEY_SECRET).' });
    }

    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');

    try {
        const isAdmin = await verifyAdmin(accessToken);
        if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

        const { matches, imagePrompt, dateStr } = req.body || {};
        if (!Array.isArray(matches) || !matches.length || !imagePrompt) {
            return res.status(400).json({ error: 'matches et imagePrompt requis' });
        }

        const caption = await draftVictoryCaption(matches, dateStr || new Date().toISOString().slice(0, 10));

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
