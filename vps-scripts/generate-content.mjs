// Script de génération de contenu quotidien pour Score Meridian.
// Tourne sur le VPS via cron chaque soir vers 22h (Europe/Paris).
// Choisit le type de contenu de demain (rotation 7 jours, même logique que
// l'app), génère une légende + un prompt image via Claude (Anthropic API),
// génère l'image via Higgsfield, et dépose le brouillon dans Supabase
// (table pending_publications, status='pending') pour validation manuelle
// dans le Panel Admin > Publications.
//
// Ne publie jamais rien directement — c'est api/publish-approved.js (Vercel)
// qui s'en charge, une fois que l'admin a cliqué "Approuver".

import { higgsfield, config as hfConfig } from '@higgsfield/client/v2';
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

hfConfig({ credentials: `${HF_KEY_ID}:${HF_KEY_SECRET}` });

const CONTENT_TYPES = [
    { key: 'promo', label: 'Promo Web App', platforms: ['instagram', 'telegram'], aspect: '4:5' },
    { key: 'prompt_ia', label: 'Prompt IA (affiche combiné)', platforms: ['instagram', 'telegram'], aspect: '4:5' },
    { key: 'ecusson', label: 'Écusson Brodé', platforms: ['instagram'], aspect: '1:1' },
    { key: 'story', label: 'Story Instagram', platforms: ['instagram'], aspect: '9:16' },
    { key: 'telegram_vip', label: 'Annonce Telegram VIP+', platforms: ['telegram'], aspect: '4:5' },
    { key: 'reels', label: 'Reels & Posts Instagram', platforms: ['instagram'], aspect: '9:16' },
    { key: 'relance', label: 'Relance Adhérents', platforms: ['telegram'], aspect: '4:5' }
];

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
    return res.status === 204 ? null : res.json();
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

    const prompt = `Tu écris pour "Score Meridian" (SM), un service français de pronostics sportifs premium (packs payants + espace VIP+). Ton de marque : affiches illustrées dramatiques/cinématiques, jamais de vrais blasons de club (stylise/générique), jamais de visage de personne réelle/célébrité.

Type de contenu à produire aujourd'hui : "${type.label}".
${matchInfo ? `Combiné en cours (noms d'équipes uniquement, PAS de score) : ${matchInfo}` : "Aucun combiné en cours actuellement — reste générique (marque/app), sans référence à un match précis."}

Ne répète pas ces accroches/légendes déjà utilisées récemment :
${recentHistory.length ? recentHistory.map(h => `- ${h.slice(0, 120)}`).join('\n') : '(aucun historique)'}

Ton par type :
- Promo Web App : lumineux, accueillant, évoque l'application mobile
- Prompt IA (affiche combiné) : poster cinématique stade/foule/tableau de score, dramatique
- Écusson Brodé : gros plan textile brodé premium, esthétique luxe
- Story Instagram : composition verticale punchy, grande zone pour texte
- Annonce Telegram VIP+ : urgence/compte à rebours, horloge, néons, ville la nuit
- Reels & Posts Instagram : scène d'action dynamique, flou de mouvement, football
- Relance Adhérents : ambiance noir/mystère — silhouette, train, montre qui tic-tac, porte verrouillée

Réponds UNIQUEMENT avec un objet JSON strict, sans texte autour, au format :
{"caption": "légende en français avec emojis, prête à poster", "image_prompt": "prompt en anglais pour un générateur d'image, décrivant précisément la scène/composition/ambiance/style"}`;

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

async function generateImage(prompt, aspect) {
    const jobSet = await higgsfield.subscribe('flux-pro/kontext/max/text-to-image', {
        input: { aspect_ratio: aspect, prompt, safety_tolerance: 2 },
        withPolling: true
    });
    if (!jobSet.isCompleted || !jobSet.jobs || !jobSet.jobs[0] || !jobSet.jobs[0].results) {
        throw new Error('Génération Higgsfield échouée ou incomplète: ' + JSON.stringify(jobSet).slice(0, 400));
    }
    return jobSet.jobs[0].results.raw.url;
}

async function main() {
    const { type, dateStr } = computeTomorrowType();
    console.log(`[${new Date().toISOString()}] Type de contenu pour ${dateStr} : ${type.label} (${type.platforms.join(', ')})`);

    const [recentHistory, combine] = await Promise.all([getRecentHistory(), getCurrentCombine()]);

    const draft = await draftWithClaude(type, recentHistory, combine);
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
