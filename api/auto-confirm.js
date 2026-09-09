// Vérification et confirmation automatique des combinés "en-cours", côté serveur.
// Appelé périodiquement par une tâche cron externe (ex: crontab sur le VPS) via
// GET /api/auto-confirm?secret=... — ne dépend d'aucun navigateur/admin connecté.
//
// Utilise la clé service_role Supabase (accès complet, bypass RLS) : elle ne doit
// JAMAIS être exposée côté client ni committée dans le code — elle est lue
// uniquement depuis les variables d'environnement Vercel (voir README ci-dessous
// pour les noms exacts à configurer : Project Settings > Environment Variables).

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '188ee1f452d24a99b59f174dcaee710d';
const CRON_SECRET = process.env.CRON_SECRET;

function cleanStr(str) {
    return (str || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

function matchTeamsToFixture(teamsStr, fixtures) {
    const parts = (teamsStr || '').split(' - ');
    const homeSearch = cleanStr(parts[0] || '');
    const awaySearch = cleanStr(parts[1] || '');
    return fixtures.find(function (f) {
        const fH = cleanStr(f.homeTeam.name);
        const fA = cleanStr(f.awayTeam.name);
        const homeMatch = fH.includes(homeSearch) || homeSearch.includes(fH);
        const awayMatch = fA.includes(awaySearch) || awaySearch.includes(fA);
        return homeMatch && awayMatch;
    });
}

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }, options));
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase ${path} -> ${res.status}: ${text}`);
    }
    return res.status === 204 ? null : res.json();
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET) {
        return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY et/ou CRON_SECRET manquants dans les variables d\'environnement Vercel.' });
    }
    if ((req.query.secret || '') !== CRON_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    const summary = { checked: 0, confirmed: [], errors: [] };

    try {
        const pendingPublic = await sbFetch(`combineds_public?status=eq.en-cours&select=*`);
        summary.checked = pendingPublic.length;

        for (const pub of pendingPublic) {
            try {
                const vipRows = await sbFetch(`combineds_vip?id=eq.${pub.id}&select=*`);
                const vip = vipRows[0];
                if (!vip || !vip.matches || !vip.matches.length || !pub.date) continue;

                const dTo = new Date(pub.date); dTo.setDate(dTo.getDate() + 1);
                const dateToStr = `${dTo.getFullYear()}-${String(dTo.getMonth() + 1).padStart(2, '0')}-${String(dTo.getDate()).padStart(2, '0')}`;

                const fdRes = await fetch(`https://api.football-data.org/v4/matches?dateFrom=${pub.date}&dateTo=${dateToStr}`, {
                    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
                });
                if (!fdRes.ok) continue;
                const fdData = await fdRes.json();
                const fixtures = (fdData.matches || []).filter(function (m) { return m.utcDate && m.utcDate.slice(0, 10) === pub.date; });

                let allFinished = true;
                const realScores = [];
                vip.matches.forEach(function (m) {
                    const fixture = matchTeamsToFixture(m.teams, fixtures);
                    if (fixture && fixture.status === 'FINISHED' && fixture.score && fixture.score.fullTime && fixture.score.fullTime.home !== null) {
                        realScores.push(`${fixture.score.fullTime.home}-${fixture.score.fullTime.away}`);
                    } else {
                        allFinished = false;
                        realScores.push(null);
                    }
                });

                if (!allFinished) continue;

                let allCorrect = true;
                const updatedMatches = vip.matches.map(function (m, idx) {
                    const real = realScores[idx];
                    const won = real.replace(/\s/g, '') === (m.score || '').replace(/\s/g, '');
                    if (!won) allCorrect = false;
                    return Object.assign({}, m, { score: real });
                });
                const finalStatus = allCorrect ? 'termine' : 'perdu';
                updatedMatches.forEach(function (m) { m.match_status = finalStatus; });

                const publicMatches = updatedMatches.map(function (m) {
                    return { teams: m.teams, time: m.time, score: m.score, odds: m.odds, logo: m.logo, league_flag: m.league_flag, match_status: finalStatus };
                });

                await sbFetch(`combineds_public?id=eq.${pub.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: finalStatus, matches: publicMatches })
                });
                await sbFetch(`combineds_vip?id=eq.${pub.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ matches: updatedMatches })
                });

                const recap = updatedMatches.map(function (m) { return `${m.teams} : ${m.score}`; }).join('\n');
                await sbFetch('telegram_queue', {
                    method: 'POST',
                    body: JSON.stringify([{ message: `AUTO-CONFIRMATION (cron)\n\nCombine du ${pub.date} confirme automatiquement : ${finalStatus === 'termine' ? 'GAGNE' : 'PERDU'}\n\n${recap}` }])
                });

                summary.confirmed.push({ id: pub.id, date: pub.date, status: finalStatus });
            } catch (innerErr) {
                summary.errors.push({ id: pub.id, error: String(innerErr) });
            }
        }

        res.status(200).json(summary);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
