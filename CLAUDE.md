# Score Master — briefing pour Claude

Application web de pronostics football (combinés du jour, packs payants, VIP+), en ligne sur **https://scoremaster.fr**. L'admin (le propriétaire) pilote tout depuis un panneau intégré à l'app : saisie des combinés, validation des résultats, commandes, génération et publication de contenu marketing vers Instagram et Telegram.

## Comment travailler avec l'utilisateur

- **Il parle français. Réponds en français.** Tout le texte visible de l'app est en français, et les messages de commit aussi.
- **Tu pilotes, il exécute.** Il ne veut pas choisir entre des options techniques : décide, applique, et donne-lui des étapes numérotées et précises uniquement quand une action lui revient (tableau de bord Vercel, éditeur SQL Supabase, Postiz, Telegram). Il les suit à la lettre. Annonce clairement toute action à portée externe (publication, suppression, message envoyé), sans en faire une demande de permission.
- **Commit puis push immédiatement** après chaque changement, sans attendre de confirmation. Vercel redéploie automatiquement `main` en une minute environ.
- **Ne lui fais jamais coller un secret dans la conversation.** Dis-lui où le coller directement (Vercel, Supabase), jamais ici.
- Il utilise l'app **sur téléphone** : toute modification d'interface doit rester lisible et utilisable en largeur mobile.
- Ne dis pas qu'une chose marche sans l'avoir vérifiée. Il juge sur ce qu'il voit à l'écran ; quand tu ne peux pas tester toi-même, dis-le.

## Architecture en une page

| Élément | Où | Rôle |
|---|---|---|
| Front + panneau admin | `index.html` (~11 000 lignes, HTML + CSS + JS inline, aucun build) | Toute l'app, publique et admin |
| API serveur | `api/*.js` — fonctions serverless Vercel | Tout ce qui exige une clé secrète |
| Base + auth | Supabase, projet `pytqquerlktxnfnohwmg` | Données, comptes, stockage d'images |
| Schéma | `supabase_orders_setup.sql` | Idempotent, relançable sans risque |
| Publication réseaux | Postiz, auto-hébergé sur le VPS | Envoie vers Instagram et le canal Telegram |
| Images IA | Higgsfield (API REST, modèle Soul v2) | Fonds de visuels, **toujours sans texte** |
| Textes IA | API Anthropic | Légendes et prompts d'images |
| Scores | football-data.org (via `api/football.js`), SofaScore, RapidAPI (live), TheSportsDB (logos) | Matchs et résultats |
| Tâches planifiées | crontab du VPS + une routine Claude Code | Voir « Automatisations » |

Dépôt : `github.com/furkansama1us-dotcom/scoremaster`, branche `main`.

## Contraintes qui te piégeront si tu les ignores

1. **12 fonctions serverless sur 12 — la limite du plan Vercel Hobby est atteinte.** Ajouter un fichier dans `api/` fera échouer le déploiement. Pour une nouvelle route, **greffe-la sur un fichier existant** avec un champ `action` ou `kind` dans le corps de la requête : c'est déjà le cas de `image-bridge.js` (proxy + upload), `publish.js` (cron + bouton), `telegram-post.js` (canal + DM) et `generate-story-content.js` (trois générateurs). Les commentaires en tête de fichier documentent chaque fusion.

2. **Neuf fonctions sont définies plusieurs fois dans `index.html`.** En JavaScript, **c'est la dernière définition qui gagne**. Si tu modifies la première, rien ne change à l'écran. Vérifie toujours avec un `grep` avant d'éditer :
   - `sendInstaPrompt` ×3 (lignes ~8672, ~9071, **~10851 ← active**)
   - `sendTelegramWin` ×2 (~8611, **~9060**)
   - `sendPromoPrompt` ×2 (~8727, **~9126**)
   - `renderAdminHistory` ×2 (~8527, **~8811**)
   - `generateMatchEcussonPrompt` ×2, `copyMatchEcusson` ×2, `copyInstaFeedPrompt` ×2, `fmtC` ×2, `closeSuccessPopup` ×2

   Nettoyer ces doublons est une amélioration utile en soi, mais supprime toujours les versions **mortes**, jamais l'active.

3. **Postiz héberge plusieurs comptes Instagram**, dont `hibou.empirefr` (un autre projet, « Nova »), tous avec le même identifiant technique `instagram-standalone`. Un `.find()` sur l'identifiant a déjà publié du contenu Score Master sur le mauvais compte. **Cible toujours l'intégration par son id** :
   - Instagram Score Master (`scoresmeridian.fr`) : `cmtw09jnf0001no72az5xn74h` (variable `POSTIZ_INSTAGRAM_INTEGRATION_ID`)
   - Telegram Score Master : `cmty7liwb0001po6om87a7g8k`
   - **Ne jamais utiliser** `cmu4hc1fi0024po6oq3anp7gm` : c'est hibou.empirefr.

4. **Fuseau horaire : tout raisonne en heure de Paris.** Plusieurs bugs de décalage d'un jour ont déjà été corrigés (`fa7294c`). Pour une date, passe par `Intl.DateTimeFormat` avec `timeZone: 'Europe/Paris'`, jamais par `new Date().toISOString().slice(0,10)` qui donne la date UTC.

5. **Les images générées ne contiennent jamais de texte.** Le texte est posé au canvas côté client, avec une vraie typographie, puis l'image finale est envoyée via `image-bridge.js`. Un modèle d'image écrit mal et avec une police différente à chaque fois. Ne réintroduis pas de texte dans les prompts d'images.

6. **Aucune publication ne part sans validation humaine.** Tout contenu généré arrive en brouillon dans `pending_publications` ; l'admin approuve dans l'onglet Publications. Garde ce principe.

7. **Rédemption de codes et droits : toujours côté serveur.** `is_vip`, `vip_pack_type` et les accès ne doivent jamais être modifiables avec la clé anon depuis le navigateur. `api/redeem-code.js` verrouille le code de façon atomique (condition `used=false` dans la mise à jour) pour empêcher un double usage.

## Carte de `index.html`

Les numéros de ligne sont approximatifs : retrouve la zone par `grep` sur le titre de section.

**Configuration** — lignes ~700–710 : `TELEGRAM_LINK`, `TELEGRAM_DM_USERNAME`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `FOOTBALL_DATA_API_KEY`.

**Pages publiques** (navigation du bas, ~1613)
- `#page-home` ~1190 — accueil, historique public
- `#page-packs` ~1288 — offres Journalier / Hebdo / VIP+
- `#page-matchs` ~1507 — matchs du jour, façon sportmeridian.com
- `#page-vip` ~1549
- `#page-ai` ~1586 — « Pronostics AI »

**Panneau admin** `#admin-page` ~1623, onglets :
- `#admin-tab-dashboard` ~1641 — historique actif / en attente / passé
- `#admin-tab-editor` ~1674 — saisie d'un combiné
- `#admin-tab-aisuggest` ~1716 — suggestions IA
- `#admin-tab-orders` ~1736 — commandes, leads Telegram, codes VIP
- `#admin-tab-validation` ~1769 et `#admin-tab-quickedit` ~1800 — masqués par défaut
- `#admin-tab-notifications` ~1827 — générateurs de textes et prompts
- `#admin-tab-calendar` ~1954 — calendrier de contenu
- `#admin-tab-publications` ~1967 — validation des brouillons avant publication

**Popups et overlays** ~2062–2345 : live du combiné, Content Planner (~2088), panier, commandes, déblocage par code.

**Logique JS, par grande section** (titres en commentaires `// ====`) :
- Légendes Reels ~836 · récupération manuelle des scores ~1032
- Relance des adhérents inactifs ~2491
- Visuels Instagram composés au canvas : Conseil IA ~2810, Victoire Story ~3085, Carrousel Story Time ~3156, Combiné du jour ~3667
- Calendrier de contenu ~4335 · Publications ~4520 · Content Planner ~4625 · génération J+1 ~4727 · sélection multiple de jours ~5061
- Parrainage ~5488 · chargement SofaScore ~5675 · Pronostics AI ~5843 · page Matchs ~6330
- Panier et codes de réduction ~6494 · déblocage temporaire par code (3 h) ~7219
- Live scores et notification Telegram ~7721 · logos TheSportsDB ~7825 · résultats finaux ~7853
- Historique public ~8425 · historique admin ~8524 (et doublon ~8808)
- Victoire Telegram ~8608 / ~8917 · prompts IA premium et promo ~8666 → ~9126
- Combo live flouté ~9263 · promo Telegram ~9628 · générateurs de prompts ~9820 → ~10134 · textes Story et annonces ~10599

## Fonctions serveur (`api/`)

Toutes lisent leurs secrets dans les variables d'environnement Vercel. L'URL Supabase est codée en dur dans chaque fichier.

| Fichier | Appel | Rôle | Variables |
|---|---|---|---|
| `publish.js` | GET `?secret=` (cron) · POST `{id}` + jeton admin | Publie les brouillons approuvés via Postiz ; « Publier maintenant » | `CRON_SECRET`, `POSTIZ_API_KEY`, `POSTIZ_DOMAIN`, `POSTIZ_INSTAGRAM_INTEGRATION_ID` |
| `auto-confirm.js` | GET `?secret=` (cron) | Détecte les matchs terminés, pré-remplit `detected_scores`, prévient l'admin. **Ne publie jamais de verdict** : GAGNÉ/PERDU reste manuel | `CRON_SECRET`, `FOOTBALL_DATA_API_KEY` |
| `generate-content-now.js` | POST (admin) | Génère un contenu à la demande : légende par Claude, image soumise à Higgsfield sans attendre | `ANTHROPIC_API_KEY`, `HF_KEY_ID`, `HF_KEY_SECRET` |
| `generate-story-content.js` | POST (admin) | Conseil IA, victoire classique, story victoire | `HF_KEY_ID`, `HF_KEY_SECRET` |
| `check-generation-status.js` | POST (polling client) | Récupère l'image Higgsfield terminée, passe le brouillon en `pending` | `HF_KEY_ID`, `HF_KEY_SECRET` |
| `image-bridge.js` | POST `action: proxy / upload` | Contourne le CORS pour le canvas ; stocke l'image composée | — |
| `redeem-code.js` | POST (utilisateur) | Utilise un code pack de façon atomique | — |
| `telegram-post.js` | POST (admin) | Publie sur le canal via Postiz, ou DM à un lead via le bot de vente si `chatId` | `POSTIZ_*`, `SALES_BOT_TOKEN` |
| `sales-bot-webhook.js` | Webhook Telegram | Bot de vente conversationnel ; la prise en charge et le paiement restent manuels | `SALES_BOT_TOKEN`, `SALES_ADMIN_CHAT_ID`, `SALES_BOT_WEBHOOK_SECRET` |
| `referral-get-link.js` | POST (utilisateur) | Lien d'invitation Telegram personnel | `REFERRAL_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID` |
| `sync-referral-joins.js` | GET `?secret=` (cron) | Compte les filleuls ; récompense tous les 3 | `CRON_SECRET`, `REFERRAL_BOT_TOKEN` |
| `football.js` | GET | Proxy football-data.org (leur CORS n'autorise que localhost) | `FOOTBALL_DATA_API_KEY` |

Toutes utilisent aussi `SUPABASE_SERVICE_ROLE_KEY`, qui ne doit **jamais** apparaître côté client.

Trois bots Telegram distincts, par obligation (Telegram interdit deux consommateurs actifs sur un même bot) : celui de Postiz, celui de vente (webhook), celui de parrainage (`getUpdates`).

## Base de données

Tables utilisées par l'app, par fréquence : `pending_publications`, `orders`, `profiles`, `combineds_vip`, `combineds_public`, `bot_conversations`, `vip_access_codes`, `telegram_queue`, `contact_messages`. Également `bot_relay_map`, `referral_bot_state`.

**Attention :** `profiles`, `combineds_public`, `combineds_vip`, `telegram_queue` et `contact_messages` **ne sont pas créées** par `supabase_orders_setup.sql` : elles ont été créées à la main au départ. Le fichier ne fait qu'y ajouter des colonnes. Avant de te fier à leur structure, lis les `alter table` du fichier ou demande à l'utilisateur d'exécuter une requête de description dans l'éditeur SQL.

Pour toute évolution de schéma : ajoute-la à `supabase_orders_setup.sql` en `add column if not exists` / `create table if not exists`, puis donne à l'utilisateur **uniquement les nouvelles lignes** à exécuter dans Supabase → SQL Editor. Il ne peut pas deviner qu'une migration est nécessaire : si ton code dépend d'une colonne nouvelle, dis-le explicitement.

## Automatisations

- **crontab du VPS** (non versionné, tu n'y as pas accès) : appelle `/api/publish`, `/api/auto-confirm` et `/api/sync-referral-joins` avec `?secret=CRON_SECRET`, et lance `vps-scripts/generate-content.mjs` chaque soir vers 22 h plus un mode `--mode=urgence` 2 à 3 fois par jour.
- **Routine Claude Code** `trig_011jeqkV2fgwyQ6ozCBdZc9K` « ScoreMaster - Contenu J-1 (22h Paris) », cron `0 20 * * *` (UTC) : prépare le contenu du lendemain selon une rotation de 7 types et le dépose pour l'admin. Consultable et modifiable avec l'outil `RemoteTrigger`.
- Les routines Claude Code tournent dans un environnement cloud avec **liste blanche de domaines** : tout nouveau domaine appelé doit y être ajouté par l'utilisateur (routine → ⋮ → Modifier l'environnement cloud → Domaines autorisés), sinon l'appel est rejeté.
- Les routines lisent le dépôt GitHub : il doit rester **public**, sinon elles échouent avec une erreur d'accès.

## Où sont les secrets

- **Vercel** → projet Score Master → Settings → Environment Variables : toutes les variables listées plus haut.
- **VPS** : `vps-scripts/.env` (modèle dans `.env.example`), jamais commité.
- **Poste de l'utilisateur** : `D:\PROJECT VIDEO\postiz-setup\.env` contient la clé API Postiz et le domaine Postiz. Tu peux t'en servir pour interroger Postiz en lecture (`GET /api/public/v1/integrations`, `GET /api/public/v1/posts?startDate=…&endDate=…&customer=`), sans jamais afficher la clé.

## Vérifier avant de livrer

- Syntaxe du JS de `index.html` (deux blocs `<script>` inline) :
  ```bash
  node -e "const fs=require('fs');const h=fs.readFileSync('index.html','utf8');[...h.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((b,i)=>fs.writeFileSync(require('os').tmpdir()+'/sm'+i+'.js',b[1]))" && for f in "$TEMP"/sm*.js; do node --check "$f"; done
  ```
- Fonctions serveur : `node --check api/<fichier>.js`.
- Avant d'éditer une fonction : `grep -n "function nomDeLaFonction" index.html` pour repérer les doublons.
- Pour voir ce qui est réellement parti sur les réseaux, interroge Postiz : l'état `ERROR` y est visible, alors que l'app peut afficher « publié ».

## Problèmes connus, pistes d'amélioration

- **« Publié » ne veut pas dire « paru ».** `publish.js` marque un post publié dès que Postiz accepte la demande ; si Instagram refuse ensuite, l'app ne le voit pas. Un post Score Master a été refusé le 18/09 à 17h00 sans que l'app le signale. Le projet Nova a résolu ce problème en conservant les ids renvoyés par Postiz puis en relisant leur état à chaque passage du cron (voir `hibouempire/lib/publish-due.js`, fonction `verifyPublished`) : c'est directement transposable.
- **Clé football-data.org exposée côté client** (`FOOTBALL_DATA_API_KEY` ligne ~708 de `index.html`) alors que le proxy `api/football.js` existe justement pour la cacher.
- **Doublons de fonctions** dans `index.html` (voir contrainte n° 2).
- **Schéma incomplet** dans le fichier SQL (voir « Base de données »).
- **Rafales de publications :** un compte Instagram voisin sur le même Postiz s'est fait bloquer après quatre carrousels envoyés dans la même minute. Espace les publications automatiques.

## Projet voisin, à ne pas confondre

Le dossier `D:\PROJECT VIDEO\postiz-setup\hibouempire` est **Nova**, un autre compte (hibou.empirefr), avec son propre Supabase et ses propres routines, mais **le même Postiz**. Ne modifie rien là-bas en travaillant sur Score Master.
