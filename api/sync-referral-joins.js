// Appelé périodiquement par le cron VPS (GET /api/sync-referral-joins?secret=...).
// Interroge le bot Telegram dédié au parrainage (getUpdates) pour détecter
// les nouveaux membres ayant rejoint le canal via un lien personnel, met à
// jour le compteur de chaque parrain, et débloque une récompense (un
// pronostic VIP+ gratuit, via le système de code de déblocage existant)
// tous les 3 filleuls.

const SUPABASE_URL = 'https://pytqquerlktxnfnohwmg.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const REFERRAL_BOT_TOKEN = process.env.REFERRAL_BOT_TOKEN;
const REWARD_THRESHOLD = 3;
const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || '-1001477645066';

// Campagne « 5 filleuls = un combiné score exact ». Les valeurs ci-dessous ne
// servent que si la table de réglages n'est pas encore en place : l'admin
// pilote tout depuis le Content Planner.
const CAMPAGNE_DEFAUT = { campagne_active: true, campagne_seuil: 5, campagne_fin: '2026-10-31', campagne_delai_h: 72, campagne_max_jour: 2 };

async function reglagesCampagne() {
    try {
        const rows = await sbFetch('automation_settings?id=eq.singleton&select=campagne_active,campagne_fin,campagne_seuil,campagne_delai_h,campagne_max_jour');
        const r = rows && rows[0];
        return r ? Object.assign({}, CAMPAGNE_DEFAUT, r) : CAMPAGNE_DEFAUT;
    } catch (e) {
        return CAMPAGNE_DEFAUT;
    }
}
// Un filleul n'est compté qu'après ce délai de présence sur le canal : un
// compte créé pour faire nombre et supprimé aussitôt ne passe pas la barre.
const DELAI_CONFIRMATION_H = 72;
// Au-delà, les arrivées ressemblent à une rafale de comptes créés à la suite.
const RAFALE_MINUTES = 60;
const RAFALE_SEUIL = 3;
// Rythme maximal retenu pour un même parrain : un parrainage réel s'étale.
const VALIDATIONS_PAR_JOUR = 2;

async function sbFetch(path, options) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, options, {
        headers: Object.assign({
            'apikey': SUPABASE_SERVICE_ROLE_KEY,
            'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
            'Content-Type': 'application/json'
        }, (options && options.headers) || {})
    }));
    if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}: ${await res.text()}`);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
}

function generateCode(prefix) {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let out = '';
    for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
    return `${prefix}-${out}`;
}

function comboKickoff(snapshot) {
    if (!snapshot || !snapshot.date || !snapshot.matches) return null;
    let earliest = null;
    snapshot.matches.forEach(function (m) {
        const t = m.time ? String(m.time).match(/\d{2}:\d{2}/) : null;
        if (t) {
            const dt = new Date(`${snapshot.date}T${t[0]}:00`);
            if (!earliest || dt < earliest) earliest = dt;
        }
    });
    return earliest;
}

async function getCurrentComboSnapshot() {
    const pub = await sbFetch('combineds_public?status=eq.en-cours&select=*&order=created_at.desc&limit=1');
    const combo = pub && pub[0];
    if (!combo) return null;
    const vip = await sbFetch(`combineds_vip?id=eq.${combo.id}&select=*`);
    const vipData = vip && vip[0];
    if (!vipData) return null;
    return {
        date: combo.date,
        time: combo.time,
        matches: vipData.matches,
        total_odds: vipData.total_odds,
        mise: vipData.mise,
        gains: vipData.gains
    };
}

async function grantReward(profile) {
    const snapshot = await getCurrentComboSnapshot();
    if (!snapshot) return false; // pas de combiné en cours -> on retentera au prochain passage

    const kickoff = comboKickoff(snapshot);
    if (kickoff && kickoff.getTime() <= Date.now()) return false; // combiné déjà commencé, on attend le prochain

    const unlockCode = generateCode('PARRAIN');
    const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000);

    await sbFetch('orders', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
            user_id: profile.id,
            reference: generateCode('REF'),
            items: [{ name: 'Récompense parrainage — pronostic VIP+ offert', price: 0 }],
            total: 0,
            status: 'confirmee',
            unlock_code: unlockCode,
            unlock_expires_at: expiresAt.toISOString(),
            unlock_content: JSON.stringify(snapshot)
        }])
    });

    await sbFetch(`profiles?id=eq.${profile.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ referral_rewards_claimed: profile.referral_rewards_claimed + 1 })
    });

    return true;
}

async function estEncoreMembre(telegramUserId) {
    try {
        const r = await fetch('https://api.telegram.org/bot' + REFERRAL_BOT_TOKEN
            + '/getChatMember?chat_id=' + encodeURIComponent(TELEGRAM_CHANNEL_ID) + '&user_id=' + telegramUserId);
        const d = await r.json();
        if (!d || !d.ok || !d.result) return false;
        return ['member', 'administrator', 'creator', 'restricted'].includes(d.result.status);
    } catch (e) {
        return false; // dans le doute, on ne valide pas : on réessaiera au passage suivant
    }
}

async function prevenirAdminParrainage(message) {
    try {
        await sbFetch('telegram_queue', {
            method: 'POST',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify([{ message }])
        });
    } catch (e) { /* notification au mieux */ }
}

// Récompense de la campagne : un combiné score exact offert, une seule fois
// par membre, et seulement si la campagne est encore ouverte.
async function recompenseCampagne(profile, reglages) {
    if (profile.campagne_recompense_le) return false;
    if (!reglages.campagne_active) return false;
    if (new Date().toISOString().slice(0, 10) > String(reglages.campagne_fin)) return false;

    const snapshot = await getCurrentComboSnapshot();
    if (!snapshot) return false;
    const kickoff = comboKickoff(snapshot);
    if (kickoff && kickoff.getTime() <= Date.now()) return false;

    const unlockCode = generateCode('CAMPAGNE');
    await sbFetch('orders', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
            user_id: profile.id,
            reference: generateCode('REF'),
            items: [{ name: 'Campagne parrainage — combiné score exact offert', price: 0 }],
            total: 0,
            status: 'confirmee',
            unlock_code: unlockCode,
            unlock_expires_at: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
            unlock_content: JSON.stringify(snapshot)
        }])
    });
    await sbFetch('profiles?id=eq.' + profile.id, {
        method: 'PATCH',
        body: JSON.stringify({ campagne_recompense_le: new Date().toISOString() })
    });
    await prevenirAdminParrainage('🎁 Campagne parrainage : ' + (profile.username || profile.id.slice(0, 8))
        + ' a atteint ' + reglages.campagne_seuil + ' filleuls validés. Le combiné offert vient d\'être crédité.');
    return true;
}

// Passe de confirmation : ce qui attend depuis assez longtemps est validé si
// le filleul est toujours sur le canal, dans la limite du rythme autorisé.
async function confirmerFilleuls(summary) {
    const reglages = await reglagesCampagne();
    const limite = new Date(Date.now() - (reglages.campagne_delai_h || DELAI_CONFIRMATION_H) * 3600000).toISOString();
    const enAttente = await sbFetch('referral_joins?statut=eq.en_attente&rejoint_le=lt.' + limite
        + '&select=id,parrain_id,telegram_user_id&order=rejoint_le.asc&limit=50') || [];
    if (!enAttente.length) return;

    const aujourdhui = new Date().toISOString().slice(0, 10);
    const dejaAujourdhui = {};

    for (const f of enAttente) {
        try {
            if (!(await estEncoreMembre(f.telegram_user_id))) {
                await sbFetch('referral_joins?id=eq.' + f.id, {
                    method: 'PATCH',
                    body: JSON.stringify({ statut: 'rejete', motif: 'A quitté le canal avant la confirmation' })
                });
                summary.filleulsRejetes++;
                continue;
            }

            if (dejaAujourdhui[f.parrain_id] === undefined) {
                const duJour = await sbFetch('referral_joins?parrain_id=eq.' + f.parrain_id
                    + '&statut=eq.valide&valide_le=gte.' + aujourdhui + 'T00:00:00Z&select=id') || [];
                dejaAujourdhui[f.parrain_id] = duJour.length;
            }
            if (dejaAujourdhui[f.parrain_id] >= (reglages.campagne_max_jour || VALIDATIONS_PAR_JOUR)) continue; // repris demain
            dejaAujourdhui[f.parrain_id]++;

            await sbFetch('referral_joins?id=eq.' + f.id, {
                method: 'PATCH',
                body: JSON.stringify({ statut: 'valide', valide_le: new Date().toISOString(), motif: null })
            });
            summary.filleulsValides++;

            const profils = await sbFetch('profiles?id=eq.' + f.parrain_id + '&select=id,username,campagne_filleuls,campagne_recompense_le');
            const profil = profils && profils[0];
            if (!profil) continue;
            const total = (profil.campagne_filleuls || 0) + 1;
            await sbFetch('profiles?id=eq.' + profil.id, {
                method: 'PATCH',
                body: JSON.stringify({ campagne_filleuls: total })
            });
            if (total >= reglages.campagne_seuil && await recompenseCampagne(profil, reglages)) summary.campagneRecompenses++;
        } catch (e) {
            summary.errors.push(String(e));
        }
    }
}

// Rattrapage : un parrain peut atteindre le seuil parce que l'admin a validé
// lui-même un filleul signalé. On vérifie donc à chaque passage qui a droit à
// sa récompense sans l'avoir encore reçue.
async function recompensesEnRetard(summary) {
    const reglages = await reglagesCampagne();
    if (!reglages.campagne_active) return;
    const profils = await sbFetch('profiles?campagne_filleuls=gte.' + reglages.campagne_seuil
        + '&campagne_recompense_le=is.null&select=id,username,campagne_filleuls,campagne_recompense_le&limit=20') || [];
    for (const p of profils) {
        try {
            if (await recompenseCampagne(p, reglages)) summary.campagneRecompenses++;
        } catch (e) {
            summary.errors.push(String(e));
        }
    }
}

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET || !REFERRAL_BOT_TOKEN) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, REFERRAL_BOT_TOKEN).' });
    }
    if ((req.query.secret || '') !== CRON_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    const summary = { updatesChecked: 0, joinsRecorded: 0, rewardsGranted: 0, filleulsValides: 0, filleulsRejetes: 0, filleulsDoublons: 0, filleulsAVerifier: 0, campagneRecompenses: 0, errors: [] };

    try {
        const stateRows = await sbFetch('referral_bot_state?id=eq.singleton&select=last_update_id');
        const lastUpdateId = (stateRows && stateRows[0] && stateRows[0].last_update_id) || 0;

        const tgRes = await fetch(`https://api.telegram.org/bot${REFERRAL_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&allowed_updates=["chat_member"]`);
        const tgData = await tgRes.json();
        if (!tgRes.ok || !tgData.ok) throw new Error('Telegram getUpdates -> ' + JSON.stringify(tgData));

        const updates = tgData.result || [];
        summary.updatesChecked = updates.length;
        let maxUpdateId = lastUpdateId;

        for (const update of updates) {
            if (update.update_id > maxUpdateId) maxUpdateId = update.update_id;

            const cm = update.chat_member;
            if (!cm) continue;
            const joined = cm.new_chat_member && ['member', 'administrator', 'restricted'].includes(cm.new_chat_member.status);
            const wasAlready = cm.old_chat_member && ['member', 'administrator', 'restricted'].includes(cm.old_chat_member.status);
            if (!joined || wasAlready) continue;
            const inviteLink = cm.invite_link && cm.invite_link.invite_link;
            if (!inviteLink) continue;

            try {
                const profiles = await sbFetch(`profiles?referral_invite_link=eq.${encodeURIComponent(inviteLink)}&select=id,referral_joins_count,referral_rewards_claimed,telegram_user_id`).catch(async () =>
                    await sbFetch(`profiles?referral_invite_link=eq.${encodeURIComponent(inviteLink)}&select=id,referral_joins_count,referral_rewards_claimed`));
                const profile = profiles && profiles[0];
                if (!profile) continue;

                const filleul = (cm.new_chat_member && cm.new_chat_member.user) || {};

                // On ne se parraine pas soi-même.
                if (profile.telegram_user_id && String(profile.telegram_user_id) === String(filleul.id)) {
                    summary.filleulsRejetes++;
                    continue;
                }

                // Rafale : plusieurs arrivées en moins d'une heure chez le même
                // parrain, c'est le motif typique des faux comptes créés à la
                // chaîne. On n'écarte pas, on fait relire par l'admin.
                const debutRafale = new Date(Date.now() - RAFALE_MINUTES * 60000).toISOString();
                const recentes = await sbFetch('referral_joins?parrain_id=eq.' + profile.id
                    + '&rejoint_le=gte.' + debutRafale + '&select=id') || [];
                const suspect = !filleul.username || recentes.length >= RAFALE_SEUIL - 1;

                // La contrainte d'unicité sur telegram_user_id fait le reste :
                // un compte déjà compté, ici ou chez un autre parrain, repart
                // en erreur et n'incrémente rien.
                let nouveau = true;
                try {
                    await sbFetch('referral_joins', {
                        method: 'POST',
                        headers: { Prefer: 'return=minimal' },
                        body: JSON.stringify([{
                            parrain_id: profile.id,
                            telegram_user_id: filleul.id,
                            telegram_username: filleul.username || null,
                            telegram_nom: [filleul.first_name, filleul.last_name].filter(Boolean).join(' ') || null,
                            statut: suspect ? 'a_verifier' : 'en_attente',
                            motif: suspect ? (!filleul.username ? 'Compte Telegram sans pseudo' : 'Plusieurs arrivées en moins d\'une heure') : null
                        }])
                    });
                } catch (e) {
                    nouveau = false; // compte déjà enregistré : il ne compte qu'une fois
                }
                if (!nouveau) { summary.filleulsDoublons++; continue; }
                if (suspect) {
                    summary.filleulsAVerifier++;
                    await prevenirAdminParrainage('🕵️ Campagne parrainage : un filleul de '
                        + (profile.username || profile.id.slice(0, 8)) + ' demande une vérification ('
                        + (!filleul.username ? 'compte sans pseudo' : 'arrivées en rafale')
                        + '). Table referral_joins, statut « a_verifier ».');
                }

                const newCount = profile.referral_joins_count + 1;
                await sbFetch(`profiles?id=eq.${profile.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ referral_joins_count: newCount })
                });
                summary.joinsRecorded++;

                const rewardsEarned = Math.floor(newCount / REWARD_THRESHOLD);
                if (rewardsEarned > profile.referral_rewards_claimed) {
                    const granted = await grantReward(Object.assign({}, profile, { referral_joins_count: newCount }));
                    if (granted) summary.rewardsGranted++;
                }
            } catch (innerErr) {
                summary.errors.push(String(innerErr));
            }
        }

        try {
            await confirmerFilleuls(summary);
            await recompensesEnRetard(summary);
        } catch (e) {
            summary.errors.push('confirmation : ' + String(e));
        }

        if (maxUpdateId > lastUpdateId) {
            await sbFetch('referral_bot_state?id=eq.singleton', {
                method: 'PATCH',
                body: JSON.stringify({ last_update_id: maxUpdateId })
            });
        }

        res.status(200).json(summary);
    } catch (error) {
        res.status(500).json({ error: String(error) });
    }
};
