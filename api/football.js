// Proxy serveur vers football-data.org.
// football-data.org n'autorise le CORS que depuis "localhost" (limite de leur plan gratuit) :
// un appel direct depuis le navigateur sur le vrai domaine est donc bloqué.
// Cette fonction Vercel (serverless) fait l'appel côté serveur et renvoie le résultat au client,
// ce qui contourne le CORS et évite d'exposer la clé API dans le code source.

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '188ee1f452d24a99b59f174dcaee710d';

// Prédictions gratuites (API-Football). La clé reste côté serveur et le quota
// (100 requêtes/jour) est protégé par un cache en base : la page publique lit
// uniquement ce cache, jamais l'API. Le remplissage est déclenché par le cron.
const APIFOOTBALL_KEY = process.env.APIFOOTBALL_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
// Nombre de matchs analysés par journée : 100 requêtes/jour au total, et on
// couvre trois journées (aujourd'hui, J+1, J+2).
const MAX_MATCHS_PAR_JOUR = 15;
// Le plan gratuit est limité à 10 requêtes par minute. On en garde une pour la
// liste des fixtures : 8 analyses par passage, le reste est repris au passage
// suivant grâce au cache (la fonction est idempotente).
const MAX_APPELS_PAR_PASSAGE = 8;
const PAUSE_ENTRE_APPELS_MS = 300;

const { GRANDES_LIGUES, prioriteLigue } = require('./_ligues.js');

function normaliseNom(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function memeEquipe(a, b) {
    const x = normaliseNom(a), y = normaliseNom(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

// Quota journalier restant, tel qu'annoncé par API-Football dans l'en-tête de
// sa dernière réponse. null tant qu'aucun appel n'a été fait.
let quotaRestant = null;

async function apiFootball(path) {
    const r = await fetch('https://v3.football.api-sports.io' + path, {
        headers: { 'x-apisports-key': APIFOOTBALL_KEY }
    });
    const q = parseInt(r.headers.get('x-ratelimit-requests-remaining'), 10);
    if (!isNaN(q)) quotaRestant = q;
    if (!r.ok) {
        const err = new Error('API-Football ' + path + ' -> ' + r.status);
        err.status = r.status;
        throw err;
    }
    return r.json();
}

const pause = ms => new Promise(r => setTimeout(r, ms));

async function sbFetch(path, options) {
    const r = await fetch(SUPABASE_URL + '/rest/v1/' + path, Object.assign({}, options, {
        headers: Object.assign({
            apikey: SUPABASE_SERVICE_ROLE_KEY,
            Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!r.ok) throw new Error('Supabase ' + path + ' -> ' + r.status + ' : ' + (await r.text()));
    const t = await r.text();
    return t ? JSON.parse(t) : null;
}

// Le plan gratuit de football-data.org est limité à 10 requêtes par minute
// pour l'ensemble du site. Les classements changent au plus une fois par jour :
// on les sert depuis Supabase et on ne rappelle l'API que si le cache a vieilli.
const DUREE_CACHE_CLASSEMENT_MS = 12 * 60 * 60 * 1000;

async function lireCacheClassement(code) {
    try {
        const rows = await sbFetch('ai_standings?select=payload,updated_at&code=eq.' + encodeURIComponent(code));
        return (rows && rows[0]) || null;
    } catch (e) {
        return null;
    }
}

async function ecrireCacheClassement(code, payload) {
    try {
        await sbFetch('ai_standings', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates' },
            body: JSON.stringify([{ code, payload, updated_at: new Date().toISOString() }])
        });
    } catch (e) { /* le cache n'est qu'une optimisation */ }
}

// Les rencontres mises en cache par le rafraîchissement, au format football-data
// pour que les deux fronts n'aient rien à adapter.
async function matchsDepuisCache(dateFrom) {
    const rows = await sbFetch('ai_fixtures?select=*&fixture_date=eq.' + encodeURIComponent(dateFrom) + '&order=kickoff.asc');
    if (!rows || !rows.length) return null;
    // Même sélection que le rafraîchissement, pour que chaque match affiché
    // ait bien son analyse réelle.
    const retenues = rows
        .slice()
        .sort((a, b) => (prioriteLigue(a.league_code) - prioriteLigue(b.league_code)) || (new Date(a.kickoff) - new Date(b.kickoff)))
        .slice(0, MAX_MATCHS_PAR_JOUR)
        .sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
    return {
        source: 'api-football',
        matches: retenues.map(f => ({
            id: f.fixture_id,
            utcDate: f.kickoff,
            homeTeam: { name: f.home },
            awayTeam: { name: f.away },
            competition: { name: f.league_name, code: f.league_code, major: true },
            area: { name: f.country, flag: f.flag }
        }))
    };
}

// Économie de crédits API-Football (100 requêtes/jour sur le plan gratuit) :
// - un passage qui trouve la journée déjà complète s'arrête sans aucun appel ;
// - la liste des rencontres est réutilisée tant qu'elle a moins de 6 heures ;
// - une réserve n'est jamais entamée, pour garder de la marge en cas d'imprévu.
const FRAICHEUR_LISTE_MS = 6 * 60 * 60 * 1000;
const RESERVE_QUOTA = 15;
const SEUIL_ALERTE_QUOTA = 25;

// Alerte privée Telegram, envoyée au plus une fois par jour et par sujet.
async function alerterAdmin(sujet, message) {
    try {
        const debutJour = new Date(); debutJour.setUTCHours(0, 0, 0, 0);
        const deja = await sbFetch('telegram_queue?select=id&created_at=gte.' + debutJour.toISOString()
            + '&message=like.' + encodeURIComponent('*' + sujet + '*') + '&limit=1');
        if (deja && deja.length) return;
        await sbFetch('telegram_queue', {
            method: 'POST',
            body: JSON.stringify([{ message: sujet + '\n\n' + message }])
        });
    } catch (e) { /* une alerte manquée ne doit pas faire échouer le passage */ }
}

// GET /api/football?type=refresh-predictions&secret=...&date=AAAA-MM-JJ
// Met en cache les rencontres de la journée et leurs analyses API-Football.
// Idempotent : un match déjà analysé n'est jamais redemandé.
async function refreshPredictions(req, res) {
    if (!APIFOOTBALL_KEY) return res.status(500).json({ error: 'APIFOOTBALL_KEY manquante côté serveur.' });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquante.' });
    if (!CRON_SECRET || req.query.secret !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const resume = { date, appelsApi: 0, analyses: 0, deja: 0, sansCorrespondance: 0, restant: 0, quotaAtteint: false, erreurs: [] };
    let appels = 0;

    try {
        // Ce qu'on a déjà : analyses et liste des rencontres
        const enCache = await sbFetch('ai_predictions?select=home,away&fixture_date=eq.' + date) || [];
        let liste = await sbFetch('ai_fixtures?select=*&fixture_date=eq.' + date) || [];
        const estEnCache = (h, a) => enCache.some(c => memeEquipe(c.home, h) && memeEquipe(c.away, a));

        // Matchs de football-data (gratuit, sans quota journalier) : ce sont
        // eux que la page affiche en saison, ils doivent donc être analysés.
        let matchsFd = [];
        try {
            const dTo = new Date(date + 'T00:00:00Z');
            dTo.setUTCDate(dTo.getUTCDate() + 1);
            const fdRes = await fetch('https://api.football-data.org/v4/matches?dateFrom=' + date + '&dateTo=' + dTo.toISOString().slice(0, 10), {
                headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
            });
            const fdData = JSON.parse(await fdRes.text());
            matchsFd = (fdData.matches || []).filter(m => m.utcDate && m.utcDate.slice(0, 10) === date).slice(0, MAX_MATCHS_PAR_JOUR);
        } catch (e) { /* football-data indisponible : on s'appuie sur API-Football */ }

        // Journée complète : aucun appel à API-Football.
        const attendus = matchsFd.length ? matchsFd.length : Math.min(MAX_MATCHS_PAR_JOUR, liste.length);
        if (liste.length && attendus > 0 && enCache.length >= attendus) {
            resume.complet = true;
            resume.deja = enCache.length;
            return res.status(200).json(resume);
        }

        // Liste des rencontres : redemandée seulement si absente ou vieillie.
        const plusRecente = liste.reduce((t, r) => Math.max(t, new Date(r.created_at).getTime() || 0), 0);
        if (!liste.length || (Date.now() - plusRecente) > FRAICHEUR_LISTE_MS) {
            const fixtures = (await apiFootball('/fixtures?date=' + date)).response || [];
            appels++;
            const maintenant = new Date().toISOString();
            const lignes = fixtures
                .filter(fx => GRANDES_LIGUES[fx.league && fx.league.id])
                .map(fx => ({
                    fixture_id: fx.fixture.id,
                    fixture_date: date,
                    kickoff: fx.fixture.date,
                    home: fx.teams.home.name,
                    away: fx.teams.away.name,
                    league_code: GRANDES_LIGUES[fx.league.id].code,
                    league_name: GRANDES_LIGUES[fx.league.id].nom,
                    country: fx.league.country || null,
                    flag: fx.league.flag || null,
                    created_at: maintenant
                }));
            if (lignes.length) {
                await sbFetch('ai_fixtures', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates' },
                    body: JSON.stringify(lignes)
                });
            }
            liste = lignes;
            resume.listeRafraichie = true;
        }
        resume.matchsEnCache = liste.length;

        // Rencontres à analyser, les plus importantes d'abord
        liste.sort((a, b) => (prioriteLigue(a.league_code) - prioriteLigue(b.league_code)) || (new Date(a.kickoff) - new Date(b.kickoff)));
        const cibles = matchsFd.length
            ? matchsFd.map(m => {
                const home = m.homeTeam && m.homeTeam.name, away = m.awayTeam && m.awayTeam.name;
                const fx = liste.find(r => memeEquipe(r.home, home) && memeEquipe(r.away, away));
                return { home, away, fixtureId: fx ? fx.fixture_id : null };
            })
            : liste.slice(0, MAX_MATCHS_PAR_JOUR).map(r => ({ home: r.home, away: r.away, fixtureId: r.fixture_id }));
        resume.source = matchsFd.length ? 'football-data' : 'api-football';

        for (const m of cibles) {
            if (!m.home || !m.away) continue;
            if (estEnCache(m.home, m.away)) { resume.deja++; continue; }
            if (!m.fixtureId) { resume.sansCorrespondance++; continue; }

            // Limite de débit (10/min) ou réserve de quota : on laisse le reste
            // au passage suivant.
            if (appels >= MAX_APPELS_PAR_PASSAGE || (quotaRestant !== null && quotaRestant <= RESERVE_QUOTA)) {
                if (quotaRestant !== null && quotaRestant <= RESERVE_QUOTA) resume.quotaAtteint = true;
                resume.restant++;
                continue;
            }

            try {
                if (appels > 0) await pause(PAUSE_ENTRE_APPELS_MS);
                appels++;
                const pred = ((await apiFootball('/predictions?fixture=' + m.fixtureId)).response || [])[0];
                if (!pred) { resume.sansCorrespondance++; continue; }
                const pourcent = p => parseInt(String(p || '0').replace('%', ''), 10) || 0;

                await sbFetch('ai_predictions', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates' },
                    body: JSON.stringify([{
                        fixture_date: date,
                        home: m.home,
                        away: m.away,
                        home_prob: pourcent(pred.predictions.percent.home),
                        draw_prob: pourcent(pred.predictions.percent.draw),
                        away_prob: pourcent(pred.predictions.percent.away),
                        advice: pred.predictions.advice || null,
                        goals_home: pred.predictions.goals && pred.predictions.goals.home,
                        goals_away: pred.predictions.goals && pred.predictions.goals.away,
                        under_over: pred.predictions.under_over || null,
                        source: 'api-football',
                        fetched_at: new Date().toISOString()
                    }])
                });
                resume.analyses++;
            } catch (e) {
                if (e && e.status === 429) {
                    // Limite de débit : le passage suivant reprendra.
                    resume.quotaAtteint = true;
                    appels = MAX_APPELS_PAR_PASSAGE;
                    resume.restant++;
                    continue;
                }
                resume.erreurs.push({ match: m.home + ' - ' + m.away, erreur: String(e) });
            }
        }

        resume.appelsApi = appels;
        resume.quotaRestant = quotaRestant;

        if (quotaRestant !== null && quotaRestant < SEUIL_ALERTE_QUOTA) {
            await alerterAdmin('⚠️ QUOTA API-FOOTBALL BAS',
                'Il reste ' + quotaRestant + ' requêtes pour aujourd\'hui. Les analyses sont suspendues sous ' + RESERVE_QUOTA
                + ' et reprendront automatiquement demain.');
        }
        if (resume.erreurs.length) {
            await alerterAdmin('❌ PRONOSTICS : ERREURS',
                resume.erreurs.length + ' analyse(s) en échec pour le ' + date + '.\n' + resume.erreurs.slice(0, 3).map(x => '• ' + x.match + ' — ' + x.erreur).join('\n'));
        }

        res.status(200).json(resume);
    } catch (e) {
        await alerterAdmin('❌ PRONOSTICS : PASSAGE EN ÉCHEC', 'Date ' + date + ' : ' + String(e).slice(0, 300));
        res.status(502).json({ error: 'Erreur rafraîchissement prédictions', details: String(e) });
    }
}

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { type, dateFrom, dateTo, code } = req.query;

    if (type === 'refresh-predictions') return refreshPredictions(req, res);

    let url;
    if (type === 'matches') {
        if (!dateFrom || !dateTo) return res.status(400).json({ error: 'dateFrom et dateTo requis' });
        url = `https://api.football-data.org/v4/matches?dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
    } else if (type === 'standings') {
        if (!code) return res.status(400).json({ error: 'code requis' });
        url = `https://api.football-data.org/v4/competitions/${encodeURIComponent(code)}/standings`;
    } else {
        return res.status(400).json({ error: 'type invalide (attendu: matches ou standings)' });
    }

    // Classements : on répond depuis le cache tant qu'il est frais, ce qui
    // évite 12 requêtes par visiteur sur un quota de 10 par minute.
    let cache = null;
    if (type === 'standings' && SUPABASE_SERVICE_ROLE_KEY) {
        cache = await lireCacheClassement(code);
        if (cache && cache.payload && (Date.now() - new Date(cache.updated_at).getTime()) < DUREE_CACHE_CLASSEMENT_MS) {
            return res.status(200).json(cache.payload);
        }
    }

    try {
        const apiRes = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });
        // Un 429 arrive en texte brut, pas en JSON : on lit d'abord le corps.
        const brut = await apiRes.text();
        let data = null;
        try { data = JSON.parse(brut); } catch (e) { /* réponse non JSON */ }

        if (type === 'standings') {
            if (apiRes.ok && data) {
                await ecrireCacheClassement(code, data);
                return res.status(200).json(data);
            }
            // API indisponible : mieux vaut un classement daté que rien.
            if (cache && cache.payload) return res.status(200).json(cache.payload);
            return res.status(apiRes.status === 429 ? 429 : 502).json({ error: 'Classement indisponible', details: brut.slice(0, 120) });
        }

        // Matchs : le cache API-Football prend le relais aussi bien pendant les
        // trêves (liste vide) que lorsque football-data est saturé.
        if (SUPABASE_SERVICE_ROLE_KEY && (!apiRes.ok || !data || !(data.matches || []).length)) {
            try {
                const secours = await matchsDepuisCache(dateFrom);
                if (secours) return res.status(200).json(secours);
            } catch (e) { /* cache indisponible : on renvoie la réponse d'origine */ }
        }

        if (!data) {
            return res.status(apiRes.status === 429 ? 429 : 502).json({ error: 'football-data.org indisponible', details: brut.slice(0, 120) });
        }
        res.status(apiRes.status).json(data);
    } catch (e) {
        res.status(502).json({ error: 'Erreur proxy football-data.org', details: String(e) });
    }
};
