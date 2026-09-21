// Fusion de publish-approved.js (cron) et publish-now.js (bouton admin),
// pour rester sous la limite de 12 fonctions serverless du plan Vercel
// Hobby. Deux façons d'appeler ce même endpoint :
//
// - GET /api/publish?secret=... (cron VPS, toutes les X min) : publie
//   TOUTES les publications "approved" en attente via Postiz.
// - POST /api/publish avec Authorization: Bearer <token admin> et
//   { id } dans le corps : force la publication immédiate d'UNE
//   publication déjà "approved", sans attendre le prochain passage cron —
//   utilisé par le bouton "Publier maintenant" du Panel Admin.
//
// - platform "instagram" -> publié immédiatement via l'API Postiz
// - platform "telegram"  -> publié immédiatement via l'API Postiz (canal
//   Telegram connecté)

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5dHFxdWVybGt0eG5mbm9od21nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUxNTkxNzgsImV4cCI6MjA5MDczNTE3OH0.aBEIXwv-uSMLuuokUDJPEIgcAFMOrb6hi2LhZ56Pdng';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const POSTIZ_API_KEY = process.env.POSTIZ_API_KEY;
const POSTIZ_DOMAIN = process.env.POSTIZ_DOMAIN || 'postiz.srv1960340.hstgr.cloud';
// Cette instance Postiz héberge PLUSIEURS comptes Instagram (Score Master +
// d'autres projets, ex: Hibou Empire), tous avec le même `identifier`
// technique ("instagram-standalone") -- un simple .find() sur l'identifier
// prenait donc le premier trouvé, potentiellement celui d'un autre projet
// (bug réel constaté : contenu Score Master publié sur le compte Hibou
// Empire). On cible désormais explicitement le compte par son id Postiz.
// Secret partagé avec la routine "Calendrier de contenu" (Claude Code), qui
// génère les 8 visuels d'un carrousel avec la mascotte puis dépose le brouillon
// ici. Sans ce secret, aucun dépôt possible : la clé anon ne peut pas écrire
// dans pending_publications (aucune policy d'insertion).
const CALENDAR_SECRET = process.env.CALENDAR_SECRET;
const POSTIZ_INSTAGRAM_INTEGRATION_ID = process.env.POSTIZ_INSTAGRAM_INTEGRATION_ID || 'cmtw09jnf0001no72az5xn74h'; // "Scores Meridian" = compte Instagram réel de Score Master

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

async function postizFetch(path, options) {
    const res = await fetch(`https://${POSTIZ_DOMAIN}/api/public/v1${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'Authorization': POSTIZ_API_KEY,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    if (!res.ok) throw new Error(`Postiz ${path} -> ${res.status}: ${text}`);
    return data;
}

async function postizPublishInstagram(ig, item, imagePath, postType) {
    await postizFetch('/posts', {
        method: 'POST',
        body: JSON.stringify({
            type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
            posts: [{
                integration: { id: ig.id },
                value: [{ content: item.caption, image: [{ id: item.id, path: imagePath }] }],
                settings: { __type: 'instagram', post_type: postType }
            }]
        })
    });
}

async function postizPublish(item, integrations) {
    if (item.platform === 'instagram') {
        const ig = (integrations || []).find(function (i) { return i.id === POSTIZ_INSTAGRAM_INTEGRATION_ID; });
        if (!ig) throw new Error('Compte Instagram Score Master introuvable sur Postiz (id attendu: ' + POSTIZ_INSTAGRAM_INTEGRATION_ID + ')');

        // Carrousel Story Time (plusieurs slides, voir image-bridge.js) : publié
        // comme un seul post multi-images, swipeable sur Instagram.
        if (Array.isArray(item.carousel_images) && item.carousel_images.length) {
            await postizFetch('/posts', {
                method: 'POST',
                body: JSON.stringify({
                    type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                    posts: [{
                        integration: { id: ig.id },
                        value: [{
                            content: item.caption,
                            image: item.carousel_images.map(function (url, i) { return { id: item.id + '-' + i, path: url }; })
                        }],
                        settings: { __type: 'instagram', post_type: 'post' }
                    }]
                })
            });
            return;
        }

        // Contenu généré en double format (Story 9:16 + Post 4:5, voir
        // image-bridge.js) : l'admin choisit au moment d'approuver lequel publier,
        // potentiellement les deux (deux appels Postiz distincts, une image
        // dédiée à chaque format plutôt qu'un recadrage).
        if (item.image_url_story || item.image_url_post) {
            const wantStory = item.publish_as_story !== false && item.image_url_story;
            const wantPost = item.publish_as_post === true && item.image_url_post;
            if (!wantStory && !wantPost) throw new Error('Aucun format sélectionné (Story/Post) pour cette publication');
            if (wantStory) await postizPublishInstagram(ig, item, item.image_url_story, 'story');
            if (wantPost) await postizPublishInstagram(ig, item, item.image_url_post, 'post');
            return;
        }

        await postizPublishInstagram(ig, item, item.image_url, 'post');
    } else if (item.platform === 'telegram') {
        const tg = (integrations || []).find(function (i) { return i.identifier && i.identifier.indexOf('telegram') !== -1; });
        if (!tg) throw new Error('Aucune intégration Telegram trouvée sur Postiz');
        await postizFetch('/posts', {
            method: 'POST',
            body: JSON.stringify({
                type: 'now', date: new Date().toISOString(), shortLink: false, tags: [],
                posts: [{
                    integration: { id: tg.id },
                    value: [{ content: item.caption, image: item.image_url ? [{ id: item.id, path: item.image_url }] : [] }],
                    settings: { __type: 'telegram' }
                }]
            })
        });
    } else {
        throw new Error(`Plateforme inconnue: ${item.platform}`);
    }
}

// Heure/date "maintenant" à Paris (pas le fuseau du serveur Vercel, qui
// tourne en UTC) — comparée à scheduled_for/scheduled_time pour ne publier
// une ligne "approved" qu'une fois son créneau réellement atteint.
// ------------------------------------------------------------
// Automatisation des publications (Content Planner > Réglages)
// ------------------------------------------------------------
async function lireReglagesAuto() {
    try {
        const rows = await sbFetch('automation_settings?id=eq.singleton&select=*');
        return (rows && rows[0]) || null;
    } catch (e) {
        return null; // table absente : automatisation considérée comme désactivée
    }
}

// Slides déjà assemblées par la routine (JPEG en base64) : stockées dans le
// bucket public, dans l'ordre du carrousel.
const BUCKET_IMAGES = 'content-images';
async function televerserSlides(idLigne, composees) {
    const urls = [];
    for (let i = 0; i < composees.length; i++) {
        const m = String(composees[i]).match(/^data:(image\/(?:jpeg|png));base64,(.+)$/);
        if (!m) throw new Error('Slide ' + (i + 1) + ' : format d\'image invalide');
        const ext = m[1] === 'image/png' ? 'png' : 'jpg';
        const chemin = 'carrousels/' + idLigne + '-slide' + i + '.' + ext;
        const r = await fetch(SUPABASE_URL + '/storage/v1/object/' + BUCKET_IMAGES + '/' + chemin, {
            method: 'POST',
            headers: {
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
                'Content-Type': m[1],
                'x-upsert': 'true'
            },
            body: Buffer.from(m[2], 'base64')
        });
        if (!r.ok) throw new Error('Stockage slide ' + (i + 1) + ' -> ' + r.status + ' : ' + (await r.text()));
        urls.push(SUPABASE_URL + '/storage/v1/object/public/' + BUCKET_IMAGES + '/' + chemin);
    }
    return urls;
}

// Approbation automatique : à partir de l'heure réglée (7h00 par défaut), les
// carrousels du calendrier prévus aujourd'hui, assemblés et non exclus, passent
// en « approuvé ». Le balayage habituel les publie ensuite à leur heure.
async function approuverAutomatiquement(now) {
    const reglages = await lireReglagesAuto();
    if (!reglages || !reglages.auto_publish) return { actif: false };
    const [hh, mm] = String(reglages.auto_approve_at || '07:00').split(':').map(Number);
    if (now.minutes < hh * 60 + mm) return { actif: true, enAttenteHeure: true };

    const exclus = Array.isArray(reglages.exclusions) ? reglages.exclusions : [];
    const candidats = await sbFetch('pending_publications?status=eq.pending&platform=eq.instagram'
        + '&overlay_data->>source=eq.content-calendar&scheduled_for=eq.' + now.dateStr
        + '&select=id,carousel_images,overlay_data') || [];
    const approuves = [];
    for (const c of candidats) {
        const calId = c.overlay_data && c.overlay_data.calendar_id;
        if (exclus.indexOf(calId) !== -1) continue;
        if (!Array.isArray(c.carousel_images) || !c.carousel_images.length || c.carousel_images.some(u => !u)) continue;
        await sbFetch('pending_publications?id=eq.' + c.id + '&status=eq.pending', {
            method: 'PATCH',
            body: JSON.stringify({ status: 'approved', overlay_data: Object.assign({}, c.overlay_data, { auto_approuve_le: new Date().toISOString() }) })
        });
        approuves.push(calId);
    }
    return { actif: true, approuves };
}

function parisNowParts() {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(new Date());
    const get = (t) => parts.find(p => p.type === t).value;
    return { dateStr: `${get('year')}-${get('month')}-${get('day')}`, minutes: parseInt(get('hour'), 10) * 60 + parseInt(get('minute'), 10) };
}

function isDue(item, now) {
    if (!item.scheduled_time || !item.scheduled_for) return true; // rétrocompatible : pas d'heure assignée -> publie dès approbation, comme avant
    if (item.scheduled_for < now.dateStr) return true; // date passée : rattrapage, publie
    if (item.scheduled_for > now.dateStr) return false; // date future : pas encore
    const [h, m] = item.scheduled_time.split(':').map(Number);
    return now.minutes >= (h * 60 + m);
}

async function handleCronSweep(req, res) {
    if (!CRON_SECRET) return res.status(500).json({ error: 'Variable d\'environnement manquante (CRON_SECRET).' });
    if ((req.query.secret || '') !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const summary = { checked: 0, published: [], waiting: [], errors: [] };
    const now = parisNowParts();
    try {
        summary.automatisation = await approuverAutomatiquement(now);
    } catch (e) {
        summary.automatisation = { erreur: String(e) };
    }
    const approvedAll = await sbFetch(`pending_publications?status=eq.approved&select=*`);
    const approved = approvedAll.filter(item => isDue(item, now));
    summary.checked = approved.length;
    summary.waiting = approvedAll.filter(item => !isDue(item, now)).map(item => ({ id: item.id, scheduled_for: item.scheduled_for, scheduled_time: item.scheduled_time }));

    let integrationsCache = null;
    async function getIntegrations() {
        if (!integrationsCache) integrationsCache = await postizFetch('/integrations');
        return integrationsCache;
    }

    for (const item of approved) {
        try {
            await postizPublish(item, await getIntegrations());
            await sbFetch(`pending_publications?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
            });
            summary.published.push({ id: item.id, platform: item.platform });
        } catch (innerErr) {
            await sbFetch(`pending_publications?id=eq.${item.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ status: 'failed', error: String(innerErr) })
            }).catch(function () {});
            summary.errors.push({ id: item.id, error: String(innerErr) });
        }
    }

    res.status(200).json(summary);
}

async function handleForcePublish(req, res) {
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace(/^Bearer\s+/i, '');
    const isAdmin = await verifyAdmin(accessToken);
    if (!isAdmin) return res.status(403).json({ error: 'Accès refusé' });

    const { id } = req.body || {};
    if (!id) return res.status(400).json({ error: 'id requis' });

    const rows = await sbFetch(`pending_publications?id=eq.${id}&select=*`);
    const item = rows && rows[0];
    if (!item) return res.status(404).json({ error: 'Publication introuvable' });
    if (item.status !== 'approved') {
        return res.status(400).json({ error: `Statut actuel "${item.status}" — seules les publications "approved" peuvent être forcées.` });
    }

    try {
        const integrations = await postizFetch('/integrations');
        await postizPublish(item, integrations);
        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'published', published_at: new Date().toISOString() })
        });
        res.status(200).json({ ok: true });
    } catch (error) {
        await sbFetch(`pending_publications?id=eq.${id}`, {
            method: 'PATCH',
            body: JSON.stringify({ status: 'failed', error: String(error) })
        }).catch(function () {});
        throw error;
    }
}

// POST { action: 'calendar-draft', secret, draft } — dépose un brouillon de
// carrousel issu du calendrier de contenu. Les images sont déjà générées
// (URLs Higgsfield) ; l'habillage texte + logo est fait ensuite côté app, à
// l'ouverture de l'onglet Publications, comme pour les autres carrousels.
async function handleCalendarDraft(req, res) {
    if (!CALENDAR_SECRET) return res.status(500).json({ error: 'CALENDAR_SECRET manquant côté serveur.' });
    const { secret, draft } = req.body || {};
    if (secret !== CALENDAR_SECRET) return res.status(403).json({ error: 'Secret invalide.' });
    if (!draft || !draft.calendar_id || !draft.caption || !Array.isArray(draft.slides) || !draft.slides.length) {
        return res.status(400).json({ error: 'draft.calendar_id, draft.caption et draft.slides sont requis.' });
    }
    if (draft.slides.some(function (s) { return !s || !s.image_url || !s.texte; })) {
        return res.status(400).json({ error: 'Chaque slide doit avoir image_url et texte.' });
    }

    // Mode essai (diagnostic) : assemble et stocke les visuels, renvoie leurs
    // URLs, sans créer aucune publication.
    if (draft.essai === true) {
        const debut = Date.now();
        const { assembler } = await import('./_compositeur.mjs');
        const images = await assembler(draft);
        const urls = await televerserSlides('essai-' + debut, images.map(function (b) { return 'data:image/jpeg;base64,' + b.toString('base64'); }));
        return res.status(200).json({ ok: true, essai: true, duree_ms: Date.now() - debut, urls });
    }

    // Les carrousels ne sont jamais publiés sur Telegram : un dépôt Telegram est
    // ignoré, et les éventuels brouillons Telegram de carrousels encore en attente
    // sont retirés au passage.
    if ((draft.platform || 'instagram') === 'telegram') {
        await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar&platform=eq.telegram&status=neq.published', { method: 'DELETE' }).catch(function () {});
        return res.status(200).json({ ok: true, skipped: 'telegram' });
    }

    // Idempotence : une même publication du calendrier n'est jamais déposée deux
    // fois pour la même plateforme (Instagram et Telegram ont chacun leur ligne).
    const query = 'pending_publications?select=id&overlay_data->>calendar_id=eq.'
        + encodeURIComponent(draft.calendar_id)
        + '&platform=eq.' + encodeURIComponent(draft.platform || 'instagram');
    const existing = await sbFetch(query);
    if (existing && existing.length) {
        return res.status(200).json({ ok: true, already: true, id: existing[0].id });
    }

    const row = {
        scheduled_for: draft.scheduled_for,
        scheduled_time: draft.scheduled_time,
        content_type: draft.content_type || 'Carrousel Calendrier',
        platform: draft.platform || 'instagram',
        caption: draft.caption,
        status: 'generating',
        overlay_data: {
            calendar_id: draft.calendar_id,
            titre: draft.titre || '',
            format: draft.format || '',
            format_nom: draft.format_nom || '',
            source: 'content-calendar',
            slides: draft.slides
        }
    };
    const inserted = await sbFetch('pending_publications', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([row])
    });

    const nouvelId = inserted && inserted[0] && inserted[0].id;

    // Slides déjà assemblées par la routine : plus besoin d'ouvrir l'app pour
    // l'habillage, le carrousel est tout de suite prêt à valider.
    let assemble = false;
    let composees = Array.isArray(draft.composed) ? draft.composed : null;
    // Carrousel duo déposé sans visuels assemblés (cas normal de la routine) :
    // le serveur les assemble lui-même avec le même rendu que l'app.
    const estDuo = draft.slides.every(function (s) { return s.page && s.position; });
    if (nouvelId && !composees && estDuo) {
        try {
            const { assembler } = await import('./_compositeur.mjs');
            const images = await assembler(draft);
            composees = images.map(function (b) { return 'data:image/jpeg;base64,' + b.toString('base64'); });
        } catch (e) {
            console.error('Assemblage serveur impossible :', e);
        }
    }
    if (nouvelId && composees && composees.length && composees.length <= 10) {
        try {
            const urls = await televerserSlides(nouvelId, composees);
            await sbFetch('pending_publications?id=eq.' + nouvelId, {
                method: 'PATCH',
                body: JSON.stringify({ carousel_images: urls, status: 'pending' })
            });
            assemble = true;
        } catch (e) {
            // Échec du stockage : la ligne reste « generating » et l'app fera
            // l'assemblage à l'ouverture, comme avant.
            console.error('Slides assemblées non stockées :', e);
        }
    }

    if (draft.request_id) {
        // Carrousel de test : la demande d'origine est traitée, on la retire de la file.
        await sbFetch('pending_publications?id=eq.' + encodeURIComponent(draft.request_id) + '&status=eq.requested', { method: 'DELETE' }).catch(function () {});
    } else if (nouvelId && draft.scheduled_for && draft.scheduled_time) {
        // Un nouveau carrousel du calendrier remplace tout brouillon non publié
        // déjà posé sur le même créneau (ex. ancien format déjà approuvé) : un
        // créneau ne publie jamais deux carrousels.
        await sbFetch('pending_publications?overlay_data->>source=eq.content-calendar'
            + '&scheduled_for=eq.' + encodeURIComponent(draft.scheduled_for)
            + '&scheduled_time=eq.' + encodeURIComponent(draft.scheduled_time)
            + '&platform=eq.' + encodeURIComponent(draft.platform || 'instagram')
            + '&status=neq.published&id=neq.' + encodeURIComponent(nouvelId), { method: 'DELETE' }).catch(function () {});
    }

    // Notification Telegram privée à l'admin : une seule par publication (sur la
    // ligne Instagram, pas sur sa jumelle Telegram), pour ne pas doubler l'alerte.
    if ((draft.platform || 'instagram') === 'instagram') {
        const quand = draft.scheduled_time ? (' à ' + String(draft.scheduled_time).replace(':', 'h')) : '';
        const message = draft.request_id
            ? `🧪 CARROUSEL DE TEST PRÊT\n\n« ${draft.titre || draft.calendar_id} »\nPrévu le ${draft.scheduled_for}${quand} s'il est approuvé.\n\nOuvre l'app : Content Planner > Valider.`
            : `🗓️ CARROUSEL PRÊT À VALIDER\n\n« ${draft.titre || draft.calendar_id} »\nPrévu le ${draft.scheduled_for}${quand} sur Instagram.\n\nOuvre l'app : Content Planner > Valider.`;
        const reglagesAuto = draft.request_id ? null : await lireReglagesAuto();
        const complement = (reglagesAuto && reglagesAuto.auto_publish)
            ? `\n\n🤖 Automatisation active : approuvé automatiquement le ${draft.scheduled_for} à ${String(reglagesAuto.auto_approve_at || '07:00').replace(':', 'h')}, sauf si tu l'exclus (Content Planner > Réglages > Gérer).`
            : '';
        const apercu = assemble ? '' : '\nLes visuels s\'assembleront à l\'ouverture de l\'app.';
        await sbFetch('telegram_queue', {
            method: 'POST',
            body: JSON.stringify([{ message: message + apercu + complement }])
        }).catch(function () {});
    }

    res.status(200).json({ ok: true, id: nouvelId });
}

// ------------------------------------------------------------
// Carrousels de test demandés à la main depuis le Content Planner.
// L'app dépose une demande (statut "requested") ; la routine cloud
// « Carrousels manuels » la récupère, génère les images avec la mascotte, puis
// dépose le brouillon via calendar-draft (avec request_id).
// ------------------------------------------------------------
const MASCOTTE = '<<<5367a632-1402-4f89-8713-824bedb14457>>>';
const PERSONNAGE = 'the friendly grey and gold robot mascot with a golden crown, glowing yellow eyes behind a dark visor and a small golden shield crest on its chest, is the main character';
const INTERDITS = 'ABSOLUTE RULE: no text, no letters, no numbers, no logos and no readable signage anywhere in the image — captions and the Score Master logo are added separately afterwards. No real club crests, no real person\'s face.';
const JEU_RESPONSABLE = '18+ · Jouer comporte des risques : endettement, dépendance… Appelez le 09 74 75 13 13 (appel non surtaxé).';
const FAMILLES_DUO = {
    R: 'Le bon réflexe', C: "Ce que tu vois / Ce qu'on calcule", E: "L'erreur / Le réflexe",
    M: 'Idée reçue / Réalité', P: 'Pressé / Patient', S: 'Coulisses Score Master'
};

function promptMoitie(scene, position) {
    const ambiance = position === 'haut'
        ? 'slightly cooler and muted color grading, a hint of tension'
        : 'warm golden color grading, calm and confident mood';
    return `${MASCOTTE} The mascot ${scene}. ${PERSONNAGE}, soft 3D toon character integrated into a realistic cinematic environment, ${ambiance}, rich environmental detail, eye-level shot, square 1:1 composition, subject centered, keep the lower fifth of the frame visually simple. ${INTERDITS}`;
}
function promptCta(scene) {
    return `${MASCOTTE} The mascot ${scene}. ${PERSONNAGE}, soft 3D toon character integrated into a realistic cinematic environment, warm golden color grading, vertical 9:16 composition, mascot in the upper half of the frame, the lower half darker and visually simple. ${INTERDITS}`;
}

async function handleManualRequest(req, res) {
    const accessToken = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!(await verifyAdmin(accessToken))) return res.status(403).json({ error: 'Accès refusé' });

    const r = (req.body && req.body.request) || {};
    const date = String(r.scheduled_for || '');
    const heure = String(r.scheduled_time || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(heure)) {
        return res.status(400).json({ error: 'Date (AAAA-MM-JJ) et heure (HH:MM) requises.' });
    }
    // Carrousels : Instagram uniquement.
    const plateformes = ['instagram'];

    let demande;
    if (r.mode === 'banque') {
        if (!r.calendar_id) return res.status(400).json({ error: 'Choisis un carrousel de la banque.' });
        demande = { mode: 'banque', calendar_id: String(r.calendar_id) };
    } else if (r.mode === 'perso') {
        const duos = (Array.isArray(r.duos) ? r.duos : [])
            .map(d => ({ haut: String((d && d.haut) || '').trim().slice(0, 90), bas: String((d && d.bas) || '').trim().slice(0, 90) }))
            .filter(d => d.haut && d.bas);
        if (duos.length < 1 || duos.length > 6) return res.status(400).json({ error: 'Entre 1 et 6 slides duo, avec un texte en haut et en bas.' });
        demande = {
            mode: 'perso',
            famille: FAMILLES_DUO[r.famille] ? r.famille : 'R',
            titre: String(r.titre || 'Carrousel de test').slice(0, 80),
            duos,
            cta: String(r.cta || 'Un conseil par jour. *Zéro promesse.* Abonne-toi.').slice(0, 120),
            legende: String(r.legende || '').slice(0, 1500)
        };
    } else {
        return res.status(400).json({ error: 'Mode inconnu.' });
    }

    const lignes = await sbFetch('pending_publications', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify([{
            scheduled_for: date,
            scheduled_time: heure,
            content_type: 'Carrousel Calendrier',
            platform: 'instagram',
            caption: 'Carrousel de test en attente de génération',
            status: 'requested',
            overlay_data: { source: 'manual-request', titre: demande.titre || demande.calendar_id, platforms: plateformes, demande }
        }])
    });
    res.status(200).json({ ok: true, id: lignes && lignes[0] && lignes[0].id });
}

// GET ?action=manual-queue&secret=CALENDAR_SECRET — demandes en attente, prêtes
// à générer : chaque slide porte son prompt final, sauf en mode personnalisé où
// la routine écrit la scène ({{SCENE}}) d'après la légende.
async function handleManualQueue(req, res) {
    if (!CALENDAR_SECRET || req.query.secret !== CALENDAR_SECRET) return res.status(401).json({ error: 'Secret invalide' });
    const demandes = await sbFetch('pending_publications?status=eq.requested&select=id,scheduled_for,scheduled_time,overlay_data&order=created_at.asc&limit=4') || [];
    if (!demandes.length) return res.status(200).json({ jobs: [] });

    let calendrier = null;
    const jobs = [];
    for (const d of demandes) {
        const od = d.overlay_data || {};
        const dem = od.demande || {};
        const base = {
            request_id: d.id,
            calendar_id: 'TEST-' + String(d.id).slice(0, 8),
            scheduled_for: d.scheduled_for,
            scheduled_time: d.scheduled_time,
            platforms: od.platforms || ['instagram']
        };
        if (dem.mode === 'banque') {
            if (!calendrier) {
                const r = await fetch('https://scoremaster.fr/content-calendar.json', { cache: 'no-store' });
                calendrier = await r.json();
            }
            const e = (calendrier || []).find(x => x.id === dem.calendar_id);
            if (!e) continue;
            jobs.push(Object.assign(base, {
                titre: e.titre, format: e.format, format_nom: e.format_nom,
                caption: [e.accroche, e.corps, e.cta, e.jeu_responsable, e.hashtags].filter(Boolean).join('\n\n'),
                slides: e.slides.map(s => ({ page: s.page, position: s.position, ratio: s.ratio || '9:16', prompt: s.prompt, texte: s.texte }))
            }));
        } else if (dem.mode === 'perso') {
            const slides = [];
            dem.duos.forEach((x, i) => {
                slides.push({ page: i + 1, position: 'haut', ratio: '1:1', prompt: promptMoitie('{{SCENE}}', 'haut'), texte: x.haut, scene_a_ecrire: true });
                slides.push({ page: i + 1, position: 'bas', ratio: '1:1', prompt: promptMoitie('{{SCENE}}', 'bas'), texte: x.bas, scene_a_ecrire: true });
            });
            slides.push({ page: dem.duos.length + 1, position: 'cta', ratio: '9:16', prompt: promptCta('waving at the viewer in front of a stadium at golden hour'), texte: dem.cta });
            const legende = dem.legende || (dem.titre + '\n\n' + dem.cta.replace(/\*/g, ''));
            jobs.push(Object.assign(base, {
                titre: dem.titre, format: dem.famille, format_nom: FAMILLES_DUO[dem.famille] || 'Test',
                caption: legende + '\n\n' + JEU_RESPONSABLE + '\n\n#ScoreMaster #Football #PronosticsFootball #JeuResponsable',
                slides
            }));
        }
    }
    res.status(200).json({ jobs });
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !POSTIZ_API_KEY) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, POSTIZ_API_KEY).' });
    }

    try {
        if (req.method === 'GET' && req.query.action === 'manual-queue') return await handleManualQueue(req, res);
        if (req.method === 'GET') return await handleCronSweep(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'calendar-draft') return await handleCalendarDraft(req, res);
        if (req.method === 'POST' && req.body && req.body.action === 'manual-request') return await handleManualRequest(req, res);
        if (req.method === 'POST') return await handleForcePublish(req, res);
        return res.status(405).json({ error: 'Méthode non autorisée' });
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
