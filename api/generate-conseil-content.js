// Déclenché depuis le bouton "Conseil IA" du Panel Admin (onglet Notifs).
//
// Choisit un conseil (banque fixe, anti-répétition sur les dernières
// publications), soumet un fond illustré SANS TEXTE à Higgsfield (même
// règle que le reste de l'app : les générateurs d'image rendent le texte
// illisible, donc aucune lettre n'est jamais demandée dans le prompt) et
// dépose un brouillon "generating" dans pending_publications avec les
// textes du conseil dans `overlay_data`.
//
// Le texte est ensuite habillé sur l'image CÔTÉ CLIENT (Canvas, vraie
// typographie Google Fonts) une fois le fond prêt — voir
// compositeConseilImage()/uploadCompositedConseil() dans index.html — puis
// uploadé via /api/upload-composited-image avant de passer "pending"
// (prêt à approuver dans Publications).

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const HF_KEY_ID = process.env.HF_KEY_ID;
const HF_KEY_SECRET = process.env.HF_KEY_SECRET;

const CONSEILS = [
    {
        kicker: 'Conseil du jour',
        headline: "L'IA ne devine pas.\nElle recoupe.",
        sub: "Forme récente, historique des confrontations, contexte du match : c'est la combinaison des données qui fait un pronostic sérieux — pas le hasard.",
        scene: 'a football pitch at night under dramatic floodlights, with a glowing holographic neural-network / data grid overlay hovering above the pitch like a scoreboard hologram'
    },
    {
        kicker: 'Méthode',
        headline: "Un bon prono commence\navant le coup d'envoi.",
        sub: "Composition probable, enjeux du match, fatigue accumulée : l'analyse se construit des heures avant, jamais dans la précipitation.",
        scene: "a coach's tactics desk illuminated by a warm lamp, a glowing tactical board with abstract light-trail formations hovering above it, dramatic dark stadium tunnel background"
    },
    {
        kicker: 'Discipline',
        headline: 'La régularité bat\nla chance à long terme.',
        sub: "Un ticket gagné isolé ne prouve rien. C'est la constance de la méthode qui fait la différence sur la durée.",
        scene: 'an hourglass with golden sand slowly falling, placed on a stadium ledge overlooking a floodlit pitch at dusk, moody cinematic lighting'
    },
    {
        kicker: 'Données',
        headline: 'Chaque cote\nraconte une histoire.',
        sub: "Une cote qui bouge signale un mouvement de marché — encore faut-il savoir le lire avant de miser.",
        scene: 'an elegant hand holding a glowing translucent data chart in mid-air above a dark stadium seating background, abstract rising and falling light-line graphs'
    },
    {
        kicker: 'Analyse',
        headline: "Le score exact n'est\njamais un pari au hasard.",
        sub: "C'est le croisement de dizaines de variables qui permet d'isoler les scénarios les plus probables.",
        scene: 'a low-angle view of an empty stadium pitch at night, dozens of thin glowing light threads converging toward a single point above the center circle, dramatic floodlights'
    },
    {
        kicker: "État d'esprit",
        headline: "Mieux vaut rater un match\nque brûler sa bankroll.",
        sub: "La gestion de la mise compte autant que l'analyse elle-même. Pas d'exception à la règle.",
        scene: 'a golden vault door slightly ajar with a warm light glowing from within, dark moody stadium corridor background, sparks of golden light dust in the air'
    },
    {
        kicker: 'Expertise',
        headline: "L'IA analyse.\nL'expérience décide.",
        sub: "Nos modèles traitent la donnée brute, mais chaque ticket final passe par un œil humain avant publication.",
        scene: 'a silhouette standing at a stadium tunnel entrance looking out onto a glowing floodlit pitch, one hand touching a translucent holographic data panel floating beside them'
    },
    {
        kicker: 'Patience',
        headline: 'Le bon moment compte\nautant que le bon match.',
        sub: 'Certaines rencontres ne valent tout simplement pas l\'analyse. Savoir passer son tour, ça fait aussi partie de la rigueur.',
        scene: 'an antique pocket watch resting on a dark wooden stadium bench, out-of-focus floodlit pitch glowing softly in the background'
    }
];

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

function pickConseil(recentHeadlines) {
    const candidates = CONSEILS.filter(c => recentHeadlines.indexOf(c.headline) === -1);
    const pool = candidates.length ? candidates : CONSEILS;
    return pool[Math.floor(Math.random() * pool.length)];
}

function buildImagePrompt(conseil) {
    return `A stylized, hand-drawn illustrated scene, dark bold ink outlines, high-contrast ink wash, premium comic book / graphic novel art style. NOT photorealistic, NOT 3D render, NOT a photo.

ABSOLUTE RULE: NO text, NO numbers, NO typography or lettering of any kind anywhere in the image, under any circumstance. NO phone, NO screen, NO tablet, NO app interface anywhere.

Scene: ${conseil.scene}. Deep navy and black color palette with warm gold accent lighting.

Brand mark (the ONLY graphic emblem allowed, no accompanying text): a small, elegant gold crown resting above a bold shield-shaped monogram "SM" emblem, integrated subtly into the scene (engraved, embossed, or softly lit in the background) — always small and secondary, never the main focus.

Style: cinematic, moody, premium illustrated aesthetic, generous empty negative space in the top third and bottom third of the frame for a text overlay to be added afterward.`;
}

function buildCaption(conseil) {
    const headlinePlain = conseil.headline.replace(/\n/g, ' ');
    return `${conseil.kicker.toUpperCase()} 📊\n\n${headlinePlain}\n\n${conseil.sub}\n\n🌐 https://scoremaster.fr/\n📲 Telegram : @ScoreMasterOfficiel`;
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

        const recent = await sbFetch(`pending_publications?content_type=eq.Conseil IA&select=overlay_data&order=created_at.desc&limit=3`).catch(() => []);
        const recentHeadlines = (recent || []).map(r => r.overlay_data && r.overlay_data.headline).filter(Boolean);

        const conseil = pickConseil(recentHeadlines);
        const statusUrl = await submitHiggsfield(buildImagePrompt(conseil), '4:5');

        const rows = await sbFetch('pending_publications', {
            method: 'POST',
            headers: { Prefer: 'return=representation' },
            body: JSON.stringify([{
                scheduled_for: new Date().toISOString().slice(0, 10),
                content_type: 'Conseil IA',
                platform: 'instagram',
                caption: buildCaption(conseil),
                image_url: '',
                status: 'generating',
                hf_status_url: statusUrl,
                overlay_data: conseil
            }])
        });

        res.status(200).json({ rows: (rows || []).map(r => ({ id: r.id, platform: r.platform })), statusUrl });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
