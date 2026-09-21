// Ligues suivies, partagées par api/football.js (cache des rencontres et
// pronostics) et api/publish.js (combiné automatique). Le préfixe « _ »
// empêche Vercel d'en faire une fonction à part.
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

module.exports = { GRANDES_LIGUES, LIGUES_PRIORITAIRES, LIGUES_SECONDAIRES, prioriteLigue };
