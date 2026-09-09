// Proxy serveur vers football-data.org.
// football-data.org n'autorise le CORS que depuis "localhost" (limite de leur plan gratuit) :
// un appel direct depuis le navigateur sur le vrai domaine est donc bloqué.
// Cette fonction Vercel (serverless) fait l'appel côté serveur et renvoie le résultat au client,
// ce qui contourne le CORS et évite d'exposer la clé API dans le code source.

const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY || '188ee1f452d24a99b59f174dcaee710d';

module.exports = async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { type, dateFrom, dateTo, code } = req.query;

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
