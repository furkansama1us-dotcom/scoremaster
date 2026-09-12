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

module.exports = async function handler(req, res) {
    if (!SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET || !REFERRAL_BOT_TOKEN) {
        return res.status(500).json({ error: 'Variables d\'environnement manquantes (SUPABASE_SERVICE_ROLE_KEY, CRON_SECRET, REFERRAL_BOT_TOKEN).' });
    }
    if ((req.query.secret || '') !== CRON_SECRET) {
        return res.status(401).json({ error: 'Secret invalide' });
    }

    const summary = { updatesChecked: 0, joinsRecorded: 0, rewardsGranted: 0, errors: [] };

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
                const profiles = await sbFetch(`profiles?referral_invite_link=eq.${encodeURIComponent(inviteLink)}&select=id,referral_joins_count,referral_rewards_claimed`);
                const profile = profiles && profiles[0];
                if (!profile) continue;

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
