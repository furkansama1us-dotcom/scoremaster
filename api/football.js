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
const MAX_MATCHS_PAR_JOUR = 12;

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
    if (!r.ok) throw new Error('API-Football ' + path + ' -> ' + r.status);
    return r.json();
}

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

// GET /api/football?type=refresh-predictions&secret=...&date=AAAA-MM-JJ
// Récupère les matchs du jour (football-data.org), les relie aux fixtures
// API-Football, puis stocke les probabilités en base. Idempotent : un match
// déjà analysé le jour même n'est pas redemandé.
async function refreshPredictions(req, res) {
    if (!APIFOOTBALL_KEY) return res.status(500).json({ error: 'APIFOOTBALL_KEY manquante côté serveur.' });
    if (!SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY manquante.' });
    if (!CRON_SECRET || req.query.secret !== CRON_SECRET) return res.status(401).json({ error: 'Secret invalide' });

    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const resume = { date, analyses: 0, deja: 0, sansCorrespondance: 0, erreurs: [] };

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

        for (const m of matchs) {
            const home = m.homeTeam && m.homeTeam.name;
            const away = m.awayTeam && m.awayTeam.name;
            if (!home || !away) continue;
            if (estEnCache(home, away)) { resume.deja++; continue; }

            const fx = fixtures.find(f => memeEquipe(f.teams.home.name, home) && memeEquipe(f.teams.away.name, away));
            if (!fx) { resume.sansCorrespondance++; continue; }

            try {
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

    try {
        const apiRes = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } });
        const data = await apiRes.json();
        res.status(apiRes.status).json(data);
    } catch (e) {
        res.status(502).json({ error: 'Erreur proxy football-data.org', details: String(e) });
    }
};
