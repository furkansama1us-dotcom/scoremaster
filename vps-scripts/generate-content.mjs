// Script de génération de contenu pour Score Master.
// Tourne sur le VPS via cron, deux modes :
//   - mode par défaut (aucun argument) : appelé chaque soir vers 22h,
//     choisit le type de contenu de demain (rotation 7 jours) et dépose
//     un brouillon pour ce type.
//   - mode "urgence" (--mode=urgence) : appelé 2-3 fois par jour (matin/
//     midi/soir), génère un teaser cinématique/urgence pour AUJOURD'HUI
//     (style "train qui n'attend pas les retardataires"), en variant la
//     scène à chaque appel pour ne pas se répéter.
// Génère une légende + un prompt image via Claude (Anthropic API), génère
// l'image via Higgsfield, et dépose le brouillon dans Supabase (table
// pending_publications, status='pending') pour validation manuelle dans
// le Panel Admin > Publications.
//
// Ne publie jamais rien directement — c'est api/publish-approved.js (Vercel)
// qui s'en charge, une fois que l'admin a cliqué "Approuver".

import 'dotenv/config';

const {
    ANTHROPIC_API_KEY,
    HF_KEY_ID,
    HF_KEY_SECRET,
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY
} = process.env;

if (!ANTHROPIC_API_KEY || !HF_KEY_ID || !HF_KEY_SECRET || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Variables manquantes dans .env (ANTHROPIC_API_KEY, HF_KEY_ID, HF_KEY_SECRET, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)');
    process.exit(1);
}

const HF_AUTH = `Key ${HF_KEY_ID}:${HF_KEY_SECRET}`;

// `time` : heure assignée à scheduled_time (format "HH:MM", fuseau Paris).
// Sans ça, publish.js publie la ligne dès son approbation, au prochain
// passage du cron (*/15 * * * *) -- peu importe l'heure prévue -- au lieu
// d'attendre le créneau voulu comme le reste des contenus planifiés.
const CONTENT_TYPES = [
    { key: 'promo', label: 'Promo Web App', platforms: ['instagram', 'telegram'], aspect: '3:4', time: '09:30' },
    { key: 'prompt_ia', label: 'Prompt IA (affiche combiné)', platforms: ['instagram', 'telegram'], aspect: '3:4', time: '10:30' },
    { key: 'ecusson', label: 'Écusson Brodé', platforms: ['instagram'], aspect: '1:1', time: '12:30' },
    { key: 'story', label: 'Story Instagram', platforms: ['instagram'], aspect: '9:16', time: '14:30' },
    { key: 'telegram_vip', label: 'Annonce Telegram VIP+', platforms: ['telegram'], aspect: '3:4', time: '16:30' },
    { key: 'reels', label: 'Reels & Posts Instagram', platforms: ['instagram'], aspect: '9:16', time: '18:30' },
    { key: 'relance', label: 'Relance Adhérents', platforms: ['telegram'], aspect: '3:4', time: '20:30' }
];

// Scènes utilisées en mode "urgence" (appels intraday, 2-3x/jour) — on fait
// tourner la scène pour ne pas répéter le même visuel à chaque appel.
// Illustration stylisée (pas de photo/interface détaillée — voir consigne
// de style dans draftWithClaude), monogramme "SM" + couronne dorée discret
// sur un objet/décor de la scène.
const URGENCE_SCENES = [
    'a lone silhouette sprinting to catch a departing high-speed train at night, neon-lit platform, the golden "SM" crown monogram glowing on the train\'s side',
    'a close-up of a hand checking a luxury wristwatch, the watch face marked with a small "SM" monogram, dark moody alley background',
    'a golden vault door slowly closing, sparks flying, the "SM" crown monogram engraved on the door',
    'an elegant hand holding a glowing black VIP card with a golden crown and "SM" monogram, dim exclusive lounge background',
    'a silhouette running through a rain-soaked neon-lit metro station at night, a glowing "SM" crown sign above the exit',
    'a golden hourglass with sand running out, dark background, the "SM" crown monogram subtly etched on its base'
];

// Angle éditorial du jour : impose une STRUCTURE de légende différente à chaque
// génération. Sans ça, le modèle retombe toujours sur la même accroche
// ("La rigueur paie...", "Pas de hasard...") d'un jour à l'autre.
const CAPTION_ANGLES = [
    'Question directe au lecteur en ouverture, puis une réponse courte et nette.',
    "Mini-récit à la première personne (2-3 phrases) : une situation vécue par un parieur, puis la leçon.",
    'Constat chiffré vérifiable sur le sport (fréquence des nuls, importance de la forme récente...), sans jamais inventer de statistique sur nos propres résultats.',
    "Coulisses : raconte le travail de préparation d'une analyse, comme un carnet de bord.",
    'Mise en garde bienveillante contre une erreur classique (parier sur son club, doubler après une perte...).',
    'Conseil pratique immédiatement applicable, formulé en une seule phrase impérative.',
    'Comparaison imagée avec un autre domaine (cuisine, échecs, musculation, course à pied).',
    "Opposition en deux temps : \"ce que font la plupart\" / \"ce qu'on fait ici\".",
    'Ton sobre et factuel, sans emphase ni superlatif, deux phrases maximum.',
    'Adresse à la communauté : remerciement sincère, sans promesse de gains.',
    "Réflexion sur le temps long : ce qui compte sur une saison, pas sur un soir.",
    'Fausse évidence démontée : commence par une croyance répandue, puis explique pourquoi elle est fausse.'
];

function computeTodayAngle() {
    const now = new Date();
    const daySeed = now.getUTCFullYear() * 372 + (now.getUTCMonth() + 1) * 31 + now.getUTCDate();
    const hourSlot = Math.floor(now.getUTCHours() / 4);
    return CAPTION_ANGLES[(daySeed * 3 + hourSlot) % CAPTION_ANGLES.length];
}

function computeTodayUrgenceScene() {
    const today = new Date();
    const daySeed = today.getUTCFullYear() * 372 + (today.getUTCMonth() + 1) * 31 + today.getUTCDate();
    const hourSlot = Math.floor(today.getUTCHours() / 6); // varie aussi selon le créneau horaire dans la journée
    const index = (daySeed + hourSlot) % URGENCE_SCENES.length;
    return URGENCE_SCENES[index];
}

async function sbFetch(path, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
        ...options,
        headers: {
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

function computeTomorrowType() {
    const refDate = Date.UTC(2026, 0, 1);
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const daysSinceRef = Math.floor((tomorrow.getTime() - refDate) / 86400000);
    const index = ((daysSinceRef % 7) + 7) % 7;
    const dateStr = tomorrow.toISOString().slice(0, 10);
    return { type: CONTENT_TYPES[index], dateStr };
}

async function getRecentHistory() {
    const [pubs, tg] = await Promise.all([
        sbFetch('pending_publications?select=caption,content_type&order=created_at.desc&limit=20').catch(() => []),
        sbFetch('telegram_queue?select=message&order=created_at.desc&limit=10').catch(() => [])
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

async function draftWithClaude(type, recentHistory, combine, forcedScene) {
    const matchInfo = combine && combine.matches && combine.matches.length
        ? combine.matches.map(m => `${m.teams} (${m.time || '?'})`).join(', ')
        : null;

    const prompt = `Tu écris pour "Score Master" (SM), un service français de pronostics sportifs premium (packs payants + espace VIP+). Identité visuelle : bleu marine/noir profond + doré premium, couronne dorée, monogramme "SM". Jamais de vrais blasons de club (générique/stylisé), jamais de visage de personne réelle/célébrité.

Type de contenu à produire aujourd'hui : "${type.label}".
${matchInfo ? `Combiné en cours (noms d'équipes uniquement, PAS de score) : ${matchInfo}` : "Aucun combiné en cours actuellement — reste générique (marque/app), sans référence à un match précis."}

ANGLE ÉDITORIAL IMPOSÉ POUR CETTE LÉGENDE (change à chaque génération, respecte-le strictement) :
${computeTodayAngle()}

Légendes déjà publiées récemment — interdiction de les reprendre, même reformulées :
${recentHistory.length ? recentHistory.map(h => `- ${h.slice(0, 160)}`).join('\n') : '(aucun historique)'}

RÈGLES ANTI-RÉPÉTITION (essentielles) :
- Ne commence JAMAIS par les mêmes mots qu'une des légendes ci-dessus.
- Bannis les formules déjà trop vues dans la marque : "Pas de hasard", "La rigueur paie", "L'analyse parle", "ce n'est pas de la chance, c'est de la méthode", "décuplez vos gains".
- Varie la longueur d'une fois sur l'autre : parfois une seule phrase, parfois un court paragraphe.
- Varie les emojis (2 maximum) et n'ouvre pas systématiquement sur un emoji.
- Aucune promesse de gain, aucun pourcentage de réussite inventé, aucun montant d'argent promis.

${forcedScene ? `STYLE VISUEL OBLIGATOIRE pour "image_prompt" : illustration digitale stylisée dessinée à la main, contours sombres marqués, ink wash haute-contraste, style bande dessinée / roman graphique premium (PAS de photo réaliste, PAS de rendu 3D). INTERDIT ABSOLU : aucun texte, aucun chiffre, aucune typographie visible dans l'image, sous aucun prétexte. INTERDIT : aucun téléphone/smartphone/iPhone, aucun écran, aucune tablette dans l'image. Reprends cette scène en l'enrichissant de détails de composition/lumière, avec le monogramme "SM" en forme d'écusson surmonté d'une couronne dorée intégré discrètement dans le décor, sans aucun texte à côté :\n${forcedScene}` : `STYLE VISUEL OBLIGATOIRE pour "image_prompt" (à écrire en anglais) :
- Illustration digitale stylisée, dessinée à la main, contours sombres marqués, ink wash haute-contraste, style bande dessinée / roman graphique premium (PAS de photo réaliste, PAS de rendu 3D, PAS de maquette d'écran/interface).
- INTERDIT ABSOLU : AUCUN texte, AUCUN chiffre, AUCUNE typographie ou lettrage visible dans l'image, sous aucun prétexte — les générateurs d'image rendent systématiquement le texte illisible/déformé, donc la composition doit reposer uniquement sur l'image, jamais sur des caractères écrits.
- INTERDIT : aucun téléphone/smartphone/iPhone, aucun écran, aucune tablette, aucune interface d'app visible dans l'image.
- Seul élément de marque autorisé (sans aucun texte à côté) : un monogramme "SM" en forme d'écusson (façon blason de club) surmonté d'une couronne dorée, intégré discrètement dans la scène (gravé sur un trophée, sur une bannière, éclairé en arrière-plan...) — toujours petit et élégant, jamais l'élément central.
- Tu peux évoquer le pays de la compétition concernée via un drapeau national stylisé intégré dans le décor (bannière, écharpe, ruban...), uniquement comme motif de couleur, sans aucun texte dessus.
- Palette bleu marine/noir profond avec touches dorées et néons discrets selon l'ambiance.
- Scène/personnage/objet élégant SANS écran : silhouette, montre, carte VIP, train, stade, porte, sablier, foule en liesse, confettis...

Ton par type (caption ET ambiance de l'illustration) :
- Promo Web App : lumineux, accueillant, évoque l'application mobile
- Prompt IA (affiche combiné) : poster stylisé mettant en scène le score exact prédit
- Écusson Brodé : gros plan textile brodé premium, esthétique luxe (garde ce type tel quel)
- Story Instagram : verticale, punchy, très peu de texte
- Annonce Telegram VIP+ : urgence/compte à rebours, horloge, néons, ville la nuit
- Reels & Posts Instagram : scène d'action dynamique, football
- Relance Adhérents : ambiance noir/mystère — silhouette, train, montre qui tic-tac, porte verrouillée`}

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format :
{"caption": "légende en français avec emojis, prête à poster", "image_prompt": "prompt en anglais pour un générateur d'image, décrivant précisément la scène/composition/ambiance/style — sans aucun texte/chiffre à faire apparaître dans l'image"}`;

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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function generateImage(prompt, aspect) {
    const submitRes = await fetch('https://api.higgsfield.ai/higgsfield-ai/soul/v2/standard', {
        method: 'POST',
        headers: { Authorization: HF_AUTH, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, aspect_ratio: aspect })
    });
    if (!submitRes.ok) throw new Error(`Higgsfield submit -> ${submitRes.status}: ${await submitRes.text()}`);
    const submitData = await submitRes.json();
    const statusUrl = submitData.status_url;
    if (!statusUrl) throw new Error('Higgsfield: pas de status_url dans la réponse: ' + JSON.stringify(submitData));

    // Poll jusqu'à 3 minutes (l'image est en général prête en 20-60s)
    for (let attempt = 0; attempt < 36; attempt++) {
        await sleep(5000);
        const statusRes = await fetch(statusUrl, { headers: { Authorization: HF_AUTH } });
        if (!statusRes.ok) throw new Error(`Higgsfield status -> ${statusRes.status}: ${await statusRes.text()}`);
        const statusData = await statusRes.json();

        if (statusData.status === 'completed' || statusData.status === 'succeeded') {
            const url = statusData.images?.[0]?.url
                || statusData.result?.url
                || statusData.output?.[0]?.url
                || statusData.url;
            if (!url) throw new Error('Higgsfield: génération terminée mais URL introuvable dans: ' + JSON.stringify(statusData).slice(0, 500));
            return url;
        }
        if (statusData.status === 'failed' || statusData.status === 'error') {
            throw new Error('Higgsfield: génération échouée: ' + JSON.stringify(statusData).slice(0, 500));
        }
        // sinon: queued / in_progress -> on continue à attendre
    }
    throw new Error('Higgsfield: délai dépassé (3 min) en attendant la génération.');
}

async function main() {
    const modeArg = process.argv.find(a => a.startsWith('--mode='));
    const mode = modeArg ? modeArg.split('=')[1] : 'daily';

    let type, dateStr, forcedScene;
    if (mode === 'urgence') {
        const today = new Date();
        dateStr = today.toISOString().slice(0, 10);
        type = { key: 'urgence', label: 'Teaser Urgence Combiné', platforms: ['instagram', 'telegram'], aspect: '3:4' };
        forcedScene = computeTodayUrgenceScene();
        console.log(`[${new Date().toISOString()}] Mode urgence — teaser pour ${dateStr} (scène: ${forcedScene.slice(0, 60)}...)`);
    } else {
        const tomorrow = computeTomorrowType();
        type = tomorrow.type;
        dateStr = tomorrow.dateStr;
        console.log(`[${new Date().toISOString()}] Type de contenu pour ${dateStr} : ${type.label} (${type.platforms.join(', ')})`);
    }

    const [recentHistory, combine] = await Promise.all([getRecentHistory(), getCurrentCombine()]);

    const draft = await draftWithClaude(type, recentHistory, combine, forcedScene);
    console.log('Légende générée :', draft.caption);
    console.log('Prompt image :', draft.image_prompt);

    const imageUrl = await generateImage(draft.image_prompt, type.aspect);
    console.log('Image générée :', imageUrl);

    for (const platform of type.platforms) {
        await sbFetch('pending_publications', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{
                scheduled_for: dateStr,
                scheduled_time: type.time || null,
                content_type: type.label,
                platform,
                caption: draft.caption,
                image_url: imageUrl,
                status: 'pending'
            }])
        });
        console.log(`Brouillon déposé pour ${platform}.`);
    }

    console.log('Terminé.');
}

main().catch(err => {
    console.error('Erreur script génération contenu:', err);
    process.exit(1);
});
