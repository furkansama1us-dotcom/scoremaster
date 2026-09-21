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

// football-data.org ne couvre que 12 compétitions sur le plan gratuit, et
// elles s'arrêtent toutes pendant les trêves internationales. API-Football
// couvre le reste : on garde ici les ligues qu'on accepte d'afficher, avec le
// code football-data quand il existe pour rester compatible avec le front.
const GRANDES_LIGUES = {
    39: { code: 'PL', nom: 'Premier League' },
    140: { code: 'PD', nom: 'Primera Division' },
    135: { code: 'SA', nom: 'Serie A' },
    78: { code: 'BL1', nom: 'Bundesliga' },
    61: { code: 'FL1', nom: 'Ligue 1' },
    88: { code: 'DED', nom: 'Eredivisie' },
    94: { code: 'PPL', nom: 'Primeira Liga' },
    40: { code: 'ELC', nom: 'Championship' },
    71: { code: 'BSA', nom: 'Serie A (Brésil)' },
    2: { code: 'UCL', nom: 'Ligue des Champions' },
    3: { code: 'UEL', nom: 'Ligue Europa' },
    848: { code: 'UECL', nom: 'Conference League' },
    5: { code: 'UNL', nom: 'Ligue des Nations' },
    1: { code: 'WC', nom: 'Coupe du Monde' },
    4: { code: 'EC', nom: "Championnat d'Europe" },
    9: { code: 'CA', nom: 'Copa America' },
    13: { code: 'CLI', nom: 'Copa Libertadores' },
    11: { code: 'CSA', nom: 'Copa Sudamericana' },
    32: { code: 'WCQE', nom: 'Qualif. Coupe du Monde (Europe)' },
    34: { code: 'WCQS', nom: 'Qualif. Coupe du Monde (Am. Sud)' },
    29: { code: 'WCQA', nom: 'Qualif. Coupe du Monde (Afrique)' },
    30: { code: 'WCQAS', nom: 'Qualif. Coupe du Monde (Asie)' },
    262: { code: 'MX1', nom: 'Liga MX' },
    128: { code: 'ARG', nom: 'Liga Profesional (Argentine)' },
    253: { code: 'MLS', nom: 'MLS' },
    203: { code: 'TR1', nom: 'Süper Lig' },
    144: { code: 'BE1', nom: 'Jupiler Pro League' },
    179: { code: 'SC1', nom: 'Premiership (Écosse)' },
    218: { code: 'AT1', nom: 'Bundesliga (Autriche)' },
    207: { code: 'CH1', nom: 'Super League (Suisse)' },
    197: { code: 'GR1', nom: 'Super League (Grèce)' },
    119: { code: 'DK1', nom: 'Superliga (Danemark)' },
    103: { code: 'NO1', nom: 'Eliteserien' },
    113: { code: 'SE1', nom: 'Allsvenskan' },
    106: { code: 'PL1', nom: 'Ekstraklasa' },
    235: { code: 'RU1', nom: 'Premier Liga (Russie)' },
    98: { code: 'JP1', nom: 'J1 League' },
    292: { code: 'KR1', nom: 'K League 1' },
    307: { code: 'SA1', nom: 'Saudi Pro League' },
    62: { code: 'FL2', nom: 'Ligue 2' },
    79: { code: 'BL2', nom: '2. Bundesliga' },
    136: { code: 'SB', nom: 'Serie B' },
    141: { code: 'SD', nom: 'Segunda Division' },
    72: { code: 'BSB', nom: 'Serie B (Brésil)' },
    // Coupes nationales : les soirs de semaine, ce sont souvent les seules
    // rencontres disponibles.
    45: { code: 'FAC', nom: 'FA Cup' },
    48: { code: 'EFL', nom: 'League Cup' },
    66: { code: 'CDF', nom: 'Coupe de France' },
    143: { code: 'CDR', nom: 'Copa del Rey' },
    137: { code: 'CI', nom: 'Coppa Italia' },
    81: { code: 'DFB', nom: 'DFB-Pokal' },
    90: { code: 'KNVB', nom: 'Coupe des Pays-Bas' },
    96: { code: 'TP', nom: 'Coupe du Portugal' },
    181: { code: 'SCUP', nom: 'Coupe d\'Écosse' },
    73: { code: 'CDB', nom: 'Copa do Brasil' }
};

// Ordre de préférence quand il y a plus de rencontres que de places (15 par
// jour) : les grandes compétitions d'abord, les deuxièmes divisions en dernier.
const LIGUES_PRIORITAIRES = ['PL', 'PD', 'SA', 'BL1', 'FL1', 'UCL', 'UEL', 'UECL', 'UNL', 'WC', 'EC', 'CA', 'CLI', 'WCQE', 'WCQS', 'WCQA', 'WCQAS'];
const LIGUES_SECONDAIRES = ['FL2', 'BL2', 'SB', 'SD', 'BSB'];

function prioriteLigue(code) {
    if (LIGUES_PRIORITAIRES.indexOf(code) !== -1) return 1;
    if (LIGUES_SECONDAIRES.indexOf(code) !== -1) return 3;
    return 2;
}

function normaliseNom(s) {
    return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}

function memeEquipe(a, b) {
    const x = normaliseNom(a), y = normaliseNom(b);
    if (!x || !y) return false;
    return x === y || x.includes(y) || y.includes(x);
}

async function apiFootball(path) {
    const r = await fetch('https://v3.football.api-sports.io' + path, {
        headers: { 'x-apisports-key': APIFOOTBALL_KEY }
    });
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

// GET /api/football?type=refresh-predictions&secret=...&date=AAAA-MM-JJ
// Récupère les matchs du jour (football-data.org), les relie aux fixtures
// API-Football, puis stocke les probabilités en base. Idempotent : un match
// déjà analysé le jour même n'est pas redemandé.
async function refreshPredictions(req, res) {
    if (!APIFOOTBALL_KEY) return res.status(500).json({ error: 'APIFOOTBALL_KEY manquante côté serveur.' });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquante.' });
    if (!CRON_SECRET || req.query.secret !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const resume = { date, analyses: 0, deja: 0, sansCorrespondance: 0, restant: 0, quotaAtteint: false, erreurs: [] };
    let appels = 0;

    try {
        // Matchs affichés par l'app ce jour-là (même source que la page publique)
        const dTo = new Date(date + 'T00:00:00Z');
        dTo.setUTCDate(dTo.getUTCDate() + 1);
        const fdRes = await fetch('https://api.football-data.org/v4/matches?dateFrom=' + date + '&dateTo=' + dTo.toISOString().slice(0, 10), {
            headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
        });
        const fdData = await fdRes.json();
        const matchs = (fdData.matches || [])
            .filter(m => m.utcDate && m.utcDate.slice(0, 10) === date)
            .slice(0, MAX_MATCHS_PAR_JOUR);

        // Déjà en cache pour cette date ?
        const enCache = await sbFetch('ai_predictions?select=home,away&fixture_date=eq.' + date);
        const estEnCache = (h, a) => (enCache || []).some(c => memeEquipe(c.home, h) && memeEquipe(c.away, a));

        // Une seule requête pour toutes les fixtures du jour
        const fixtures = (await apiFootball('/fixtures?date=' + date)).response || [];

        // Les rencontres des ligues suivies sont mises en cache : elles servent
        // de source de repli quand football-data.org ne renvoie rien (trêves).
        const suivies = fixtures
            .filter(f => GRANDES_LIGUES[f.league && f.league.id])
            .sort((a, b) => (prioriteLigue(GRANDES_LIGUES[a.league.id].code) - prioriteLigue(GRANDES_LIGUES[b.league.id].code))
                || (new Date(a.fixture.date) - new Date(b.fixture.date)));

        if (suivies.length) {
            await sbFetch('ai_fixtures', {
                method: 'POST',
                headers: { Prefer: 'resolution=merge-duplicates' },
                body: JSON.stringify(suivies.map(f => ({
                    fixture_id: f.fixture.id,
                    fixture_date: date,
                    kickoff: f.fixture.date,
                    home: f.teams.home.name,
                    away: f.teams.away.name,
                    league_code: GRANDES_LIGUES[f.league.id].code,
                    league_name: GRANDES_LIGUES[f.league.id].nom,
                    country: f.league.country || null,
                    flag: f.league.flag || null
                })))
            });
            resume.matchsEnCache = suivies.length;
        }

        // Source des matchs à analyser : football-data quand il en a, le cache
        // API-Football sinon.
        const cibles = matchs.length
            ? matchs.map(m => ({ home: m.homeTeam && m.homeTeam.name, away: m.awayTeam && m.awayTeam.name, fixtureId: null }))
            : suivies.slice(0, MAX_MATCHS_PAR_JOUR).map(f => ({ home: f.teams.home.name, away: f.teams.away.name, fixtureId: f.fixture.id }));
        resume.source = matchs.length ? 'football-data' : 'api-football';

        for (const m of cibles) {
            const home = m.home;
            const away = m.away;
            if (!home || !away) continue;
            if (estEnCache(home, away)) { resume.deja++; continue; }

            const fx = m.fixtureId
                ? { fixture: { id: m.fixtureId } }
                : fixtures.find(f => memeEquipe(f.teams.home.name, home) && memeEquipe(f.teams.away.name, away));
            if (!fx) { resume.sansCorrespondance++; continue; }

            // Budget de requêtes épuisé : on s'arrête proprement, le passage
            // suivant reprendra là où on en est.
            if (appels >= MAX_APPELS_PAR_PASSAGE) { resume.restant++; continue; }

            try {
                if (appels > 0) await pause(PAUSE_ENTRE_APPELS_MS);
                appels++;
                const pred = ((await apiFootball('/predictions?fixture=' + fx.fixture.id)).response || [])[0];
                if (!pred) { resume.sansCorrespondance++; continue; }
                const pourcent = p => parseInt(String(p || '0').replace('%', ''), 10) || 0;

                await sbFetch('ai_predictions', {
                    method: 'POST',
                    headers: { Prefer: 'resolution=merge-duplicates' },
                    body: JSON.stringify([{
                        fixture_date: date,
                        home: home,
                        away: away,
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
                    // Limite de débit atteinte : inutile d'insister, le cron
                    // repassera. On note les matchs restants sans les compter
                    // comme des erreurs.
                    resume.quotaAtteint = true;
                    appels = MAX_APPELS_PAR_PASSAGE;
                    resume.restant++;
                    continue;
                }
                resume.erreurs.push({ match: home + ' - ' + away, erreur: String(e) });
            }
        }

        res.status(200).json(resume);
    } catch (e) {
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
