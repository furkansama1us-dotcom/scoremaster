// Déclenche à la demande (depuis le Calendrier de contenu du Panel Admin)
// la même génération que le script VPS nocturne, mais pour un type de
// contenu et un jour (J+0/J+1) choisis par l'admin en un clic.
//
// Reste rapide (<10s) : appelle Claude pour la légende + le prompt image,
// puis SOUMET la génération Higgsfield sans attendre qu'elle se termine
// (ça peut prendre jusqu'à 3 min). Dépose un brouillon "generating" par
// plateforme dans pending_publications ; c'est /api/check-generation-status
// (appelé en polling par le client) qui viendra compléter l'image une fois
// prête et passer le statut à "pending" (prêt à approuver).

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;

const CONTENT_TYPES = {
    promo: { label: 'Promo Web App', platforms: ['instagram', 'telegram'], aspect: '3:4' },
    prompt_ia: { label: 'Prompt IA (affiche combiné)', platforms: ['instagram', 'telegram'], aspect: '3:4' },
    ecusson: { label: 'Écusson Brodé', platforms: ['instagram'], aspect: '1:1' },
    story: { label: 'Story Instagram', platforms: ['instagram'], aspect: '9:16' },
    telegram_vip: { label: 'Annonce Telegram VIP+', platforms: ['telegram'], aspect: '3:4' },
    reels: { label: 'Reels & Posts Instagram', platforms: ['instagram'], aspect: '9:16' },
    relance: { label: 'Relance Adhérents', platforms: ['telegram'], aspect: '3:4' }
};

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

async function getRecentHistory() {
    const [pubs, tg] = await Promise.all([
        sbFetch('pending_publications?select=caption,content_type&order=created_at.desc&limit=5').catch(() => []),
        sbFetch('telegram_queue?select=message&order=created_at.desc&limit=5').catch(() => [])
    ]);
    return [...(pubs || []).map(p => p.caption), ...(tg || []).map(t => t.message)].filter(Boolean);
}

async function getCurrentCombine() {
    try {
        const rows = await sbFetch('combineds_public?status=eq.en-cours&select=*&order=created_at.desc&limit=1');
        return rows && rows[0] ? rows[0] : null;
    } catch (e) {
        return null;
    }
}

async function draftWithClaude(type, recentHistory, combine) {
    const matchInfo = combine && combine.matches && combine.matches.length
        ? combine.matches.map(m => `${m.teams} (${m.time || '?'})`).join(', ')
        : null;

    const prompt = `Tu écris pour "Score Master" (SM), un service français de pronostics sportifs premium (packs payants + espace VIP+). Identité visuelle : bleu marine/noir profond + doré premium, couronne dorée, monogramme "SM". Jamais de vrais blasons de club (générique/stylisé), jamais de visage de personne réelle/célébrité.

Type de contenu à produire aujourd'hui : "${type.label}".
${matchInfo ? `Combiné en cours (noms d'équipes uniquement, PAS de score) : ${matchInfo}` : "Aucun combiné en cours actuellement — reste générique (marque/app), sans référence à un match précis."}

Ne répète pas ces accroches/légendes déjà utilisées récemment :
${recentHistory.length ? recentHistory.map(h => `- ${h.slice(0, 120)}`).join('\n') : '(aucun historique)'}

STYLE VISUEL OBLIGATOIRE pour "image_prompt" (référence : les visuels marketing d'app du compte Instagram @sport.meridian — PAS des scènes cinématiques/photos dramatiques) :
- Un vrai graphisme marketing d'application mobile professionnel : fond dégradé bleu marine/noir profond avec touches dorées, typographie bold moderne et minimaliste.
- Une maquette de téléphone (mockup) propre et réaliste montrant un écran plausible de l'app (liste de matchs, cote, score prédit par IA, badge "AI Prediction").
- 2 à 4 éléments de texte MAXIMUM, chacun COURT (3-6 mots), à donner EXACTEMENT entre guillemets dans le prompt (ex: "Predict smarter with AI.", "AI PREDICTION · PSG 2-1"). Ne jamais demander de paragraphes ou de texte dense : les générateurs d'image rendent mal le texte long, donc moins de texte = plus pro.
- Optionnel : liste de fonctionnalités avec coches (✓), badges App Store / Google Play, petites icônes UI (stats, IA, live score).
- Qualité : rendu net type design graphique professionnel (Figma/Webflow marketing page), pas de flou artistique, pas de photo de stade/silhouette/scène narrative.

Ton du texte (caption) par type :
- Promo Web App : lumineux, accueillant, évoque l'application mobile
- Prompt IA (affiche combiné) : met en avant la prédiction IA et le score exact
- Écusson Brodé : gros plan textile brodé premium, esthétique luxe (garde ce type tel quel, ne pas appliquer le style app-mockup ici)
- Story Instagram : verticale, punchy, très peu de texte
- Annonce Telegram VIP+ : urgence/compte à rebours, mais toujours en graphisme d'app propre (pas de scène noire/néons)
- Reels & Posts Instagram : met en avant les fonctionnalités/résultats de l'app
- Relance Adhérents : rappel amical, met en avant la valeur de l'abonnement VIP+

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format :
{"caption": "légende en français avec emojis, prête à poster", "image_prompt": "prompt en anglais pour un générateur d'image, décrivant précisément la scène/composition/ambiance/style, avec les textes exacts entre guillemets"}`;

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
    const text = data.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Réponse Claude non-JSON: ' + text.slice(0, 300));
    return JSON.parse(jsonMatch[0]);
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

        const { typeKey, dayOffset } = req.body || {};
        const type = CONTENT_TYPES[typeKey];
        if (!type) return res.status(400).json({ error: 'Type de contenu inconnu' });
        const offset = dayOffset === 1 ? 1 : 0;

        const d = new Date();
        d.setUTCDate(d.getUTCDate() + offset);
        const dateStr = d.toISOString().slice(0, 10);

        const [recentHistory, combine] = await Promise.all([getRecentHistory(), getCurrentCombine()]);
        const draft = await draftWithClaude(type, recentHistory, combine);
        const statusUrl = await submitHiggsfield(draft.image_prompt, type.aspect);

        const rows = await sbFetch('pending_publications', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify(type.platforms.map(platform => ({
                scheduled_for: dateStr,
                content_type: type.label,
                platform,
                caption: draft.caption,
                image_url: '',
                status: 'generating',
                hf_status_url: statusUrl
            })))
        });

        res.status(200).json({ rows: (rows || []).map(r => ({ id: r.id, platform: r.platform })), statusUrl });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
