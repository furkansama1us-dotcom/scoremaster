// Détection automatique des scores réels pour les combinés "en-cours", côté serveur.
// Appelé périodiquement par une tâche cron externe (ex: crontab sur le VPS) via
// GET /api/auto-confirm?secret=... — ne dépend d'aucun navigateur/admin connecté.
//
// IMPORTANT : cet endpoint NE PUBLIE JAMAIS rien tout seul. Il détecte quand un
// match est réellement FINISHED côté API, enregistre le score réel dans
// `detected_scores` (pré-remplissage) et notifie l'admin par Telegram. La décision
// finale (GAGNÉ / PERDU / scores affichés publiquement) reste 100% manuelle, via
// le bouton "Appliquer les nouveaux scores et publier" dans le Panel Admin.
//
// Utilise la clé service_role Supabase (accès complet, bypass RLS) : elle ne doit
// JAMAIS être exposée côté client ni committée dans le code — elle est lue
// uniquement depuis les variables d'environnement Vercel.

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

// Minutes "horloge de Paris" depuis l'epoch : permet de comparer l'heure
// actuelle et un coup d'envoi saisi en heure de Paris, sans gérer le décalage.
function parisMinutes(y, mo, d, hh, mi) {
    return Date.UTC(y, mo - 1, d, hh, mi) / 60000;
}

function parisNowMinutes() {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
    return parisMinutes(+p.year, +p.month, +p.day, +p.hour % 24, +p.minute);
}

// Dernier coup d'envoi du combiné (le match qui finira en dernier).
function lastKickoffMinutes(dateStr, matches) {
    const d = (dateStr || '').split('-').map(Number);
    if (d.length !== 3) return null;
    let last = null;
    (matches || []).forEach(function (m) {
        const hm = String(m.time || '').match(/(\d{1,2}):(\d{2})/);
        if (!hm) return;
        const t = parisMinutes(d[0], d[1], d[2], +hm[1], +hm[2]);
        if (last === null || t > last) last = t;
    });
    return last;
}

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
    return res.status === 204 ? null : res.json();
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET) {
        return res.status(500).json({ error: 'SUPABASE_SERVICE_ROLE_KEY et/ou CRON_SECRET manquants dans les variables d\'environnement Vercel.' });
    }
    if ((req.query.secret || '') !== CRON_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    const summary = { checked: 0, newlyDetected: [], errors: [] };

    try {
        const pendingPublic = await sbFetch(`combineds_public?status=eq.en-cours&select=*`);
        summary.checked = pendingPublic.length;

        for (const pub of pendingPublic) {
            try {
                const vipRows = await sbFetch(`combineds_vip?id=eq.${pub.id}&select=*`);
                const vip = vipRows[0];
                if (!vip || !vip.matches || !vip.matches.length || !pub.date) continue;

                // Alerte "on approche de la 90e du dernier match" : envoyée une
                // seule fois, entre 80 et 130 minutes après le dernier coup
                // d'envoi (la fenêtre large absorbe l'intervalle du cron).
                const lastKick = lastKickoffMinutes(pub.date, vip.matches);
                if (lastKick !== null && !pub.end_notified_at) {
                    const elapsed = parisNowMinutes() - lastKick;
                    if (elapsed >= 80 && elapsed <= 130) {
                        const dernier = vip.matches.reduce(function (acc, m) {
                            const hm = String(m.time || '').match(/\d{1,2}:\d{2}/);
                            return (!acc || (hm && hm[0] > acc.h)) ? { h: hm ? hm[0] : '', teams: m.teams } : acc;
                        }, null);
                        await sbFetch('telegram_queue', {
                            method: 'POST',
                            body: JSON.stringify([{ message: `⏱️ FIN DE MATCH IMMINENTE — Combiné du ${pub.date}\n\nDernier match : ${dernier ? dernier.teams : ''} (coup d'envoi ${dernier ? dernier.h : ''}).\nOn approche de la 90e minute.\n\nPrépare la validation : Panel Admin > À Confirmer. Les scores réels arrivent juste après le coup de sifflet.` }])
                        }).catch(function () {});
                        await sbFetch(`combineds_public?id=eq.${pub.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ end_notified_at: new Date().toISOString() })
                        }).catch(function () {});
                        summary.endAlerts = (summary.endAlerts || 0) + 1;
                    }
                }
                if (vip.detected_scores) continue; // déjà détecté et notifié précédemment, on ne renotifie pas

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

                if (!allFinished) continue; // pas encore tous terminés, on retentera au prochain passage

                // On enregistre uniquement les scores détectés (pré-remplissage) — aucun changement de statut ni publication.
                await sbFetch(`combineds_vip?id=eq.${pub.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ detected_scores: realScores })
                });

                const recap = vip.matches.map(function (m, idx) { return `${m.teams} : prédit ${m.score} → réel ${realScores[idx]}`; }).join('\n');
                await sbFetch('telegram_queue', {
                    method: 'POST',
                    body: JSON.stringify([{ message: `🔎 SCORES DÉTECTÉS — Combiné du ${pub.date} prêt à valider\n\n${recap}\n\nVa dans Panel Admin > À Confirmer pour vérifier et publier.` }])
                });

                summary.newlyDetected.push({ id: pub.id, date: pub.date, scores: realScores });
            } catch (innerErr) {
                summary.errors.push({ id: pub.id, error: String(innerErr) });
            }
        }

        res.status(200).json(summary);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
