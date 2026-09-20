-- Ce script est idempotent : tu peux le relancer entièrement sans risque,
-- même si tu as déjà exécuté une version précédente.
-- Supabase : Dashboard > SQL Editor > New query > colle tout > Run

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  user_id uuid not null references auth.users(id) on delete cascade,
  reference text not null unique,
  items jsonb not null,
  total numeric not null default 0,
  status text not null default 'en_attente',
  discount_code text
);

alter table public.orders enable row level security;

drop policy if exists "Users can insert their own orders" on public.orders;
create policy "Users can insert their own orders"
  on public.orders for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can view their own orders" on public.orders;
create policy "Users can view their own orders"
  on public.orders for select
  using (auth.uid() = user_id);

drop policy if exists "Admins can view all orders" on public.orders;
create policy "Admins can view all orders"
  on public.orders for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ============================================================
-- Validation admin + code de déblocage temporaire (3h)
-- ============================================================

alter table public.orders
  add column if not exists customer_phone text,
  add column if not exists unlock_code text,
  add column if not exists unlock_expires_at timestamptz,
  add column if not exists unlock_content text;

-- Permet aux admins de mettre à jour n'importe quelle commande
-- (nécessaire pour valider une commande et générer le code de déblocage)
drop policy if exists "Admins can update all orders" on public.orders;
create policy "Admins can update all orders"
  on public.orders for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Permet aux admins de supprimer une commande depuis le panel admin
-- (sans cette policy, DELETE renvoie un "succès" silencieux sans rien supprimer)
drop policy if exists "Admins can delete orders" on public.orders;
create policy "Admins can delete orders"
  on public.orders for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ============================================================
-- Détection automatique des scores réels (sans publication auto)
-- Le cron ne fait plus que détecter + pré-remplir ; c'est toujours
-- l'admin qui valide manuellement via "Appliquer et publier".
-- ============================================================

alter table public.combineds_vip
  add column if not exists detected_scores jsonb;

-- ============================================================
-- Application réelle du code de réduction -20% au panier
-- ============================================================

alter table public.orders
  add column if not exists discount_code_used boolean not null default false;

-- Permet à l'utilisateur de marquer SON PROPRE code promo comme utilisé
-- une fois appliqué à une nouvelle commande (empêche la réutilisation)
drop policy if exists "Users can update their own orders" on public.orders;
create policy "Users can update their own orders"
  on public.orders for update
  using (auth.uid() = user_id);

-- ============================================================
-- Publications automatisées (Claude + Higgsfield + Postiz)
-- Le script VPS (service_role) dépose des brouillons ici chaque soir.
-- L'admin approuve/rejette depuis le Panel Admin > Publications.
-- Un endpoint Vercel (service_role) publie via Postiz les items approuvés.
-- ============================================================

create table if not exists public.pending_publications (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  scheduled_for date not null,
  content_type text not null,
  platform text not null,
  caption text not null,
  image_url text not null default '',
  status text not null default 'pending',
  reviewed_at timestamptz,
  published_at timestamptz,
  error text,
  hf_status_url text
);

-- Migration (si la table existait déjà avant ces colonnes) :
alter table public.pending_publications alter column image_url set default '';
alter table public.pending_publications add column if not exists hf_status_url text;
-- Textes du conseil (kicker/headline/sub/scène) habillés en Canvas côté client
-- pour la fonctionnalité "Conseil IA" (visuels Instagram avec texte réel superposé).
alter table public.pending_publications add column if not exists overlay_data jsonb;

-- Contenu Instagram généré en double format (Story 9:16 + Post 4:5 pour un
-- rendu net dans les deux emplacements) : deux URLs distinctes + le choix de
-- l'admin (fait au moment d'approuver) sur lequel publier.
alter table public.pending_publications add column if not exists image_url_story text;
alter table public.pending_publications add column if not exists image_url_post text;
alter table public.pending_publications add column if not exists publish_as_story boolean;
alter table public.pending_publications add column if not exists publish_as_post boolean;

-- Carrousel Instagram "Story Time" (6 slides swipeables, texte réel sur bande
-- unie, fonds Higgsfield SANS TEXTE) : tableau des URLs des slides composées,
-- dans l'ordre (l'index 0 = slide 1). Publié comme un carrousel via Postiz
-- (plusieurs images dans un seul post, swipeables).
alter table public.pending_publications add column if not exists carousel_images jsonb;

-- Heure de publication prévue (ex: "11:00"), assignée à la génération selon
-- le planning-type du Content Planner. Le cron ne publie une ligne
-- "approved" qu'une fois cette heure atteinte (heure de Paris) -- sans ça,
-- approuver à l'avance publiait immédiatement au prochain passage du cron,
-- quelle que soit l'heure affichée dans le planning.
alter table public.pending_publications add column if not exists scheduled_time text;

-- Bucket public pour héberger les visuels "Conseil IA" une fois le texte habillé
-- (fond Higgsfield + typographie réelle composés en un seul PNG côté client).
insert into storage.buckets (id, name, public)
values ('content-images', 'content-images', true)
on conflict (id) do nothing;

-- Autorise la lecture publique du bucket (nécessaire pour que Postiz/Instagram
-- puissent récupérer l'image via son URL publique).
drop policy if exists "Public read content-images" on storage.objects;
create policy "Public read content-images"
  on storage.objects for select
  using (bucket_id = 'content-images');

alter table public.pending_publications enable row level security;

drop policy if exists "Admins can view all pending publications" on public.pending_publications;
create policy "Admins can view all pending publications"
  on public.pending_publications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

drop policy if exists "Admins can update pending publications" on public.pending_publications;
create policy "Admins can update pending publications"
  on public.pending_publications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Permet aux admins de nettoyer l'historique (supprimer une entrée ou tout vider)
-- depuis l'onglet Publications du Panel Admin.
drop policy if exists "Admins can delete pending publications" on public.pending_publications;
create policy "Admins can delete pending publications"
  on public.pending_publications for delete
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- ============================================================
-- Parrainage Telegram — lien d'invitation personnel par membre,
-- suivi des amis qui rejoignent le canal, récompense tous les 3 filleuls
-- (déblocage d'un pronostic VIP+ via le système de code existant).
-- ============================================================

alter table public.profiles
  add column if not exists referral_invite_link text,
  add column if not exists referral_joins_count integer not null default 0,
  add column if not exists referral_rewards_claimed integer not null default 0;

-- État du bot de parrainage (offset getUpdates), une seule ligne.
create table if not exists public.referral_bot_state (
  id text primary key default 'singleton',
  last_update_id bigint not null default 0
);
insert into public.referral_bot_state (id) values ('singleton') on conflict do nothing;
alter table public.referral_bot_state enable row level security;

-- ============================================================
-- Bot conversationnel de vente (Telegram) — guide un client Telegram
-- (avec ou sans compte sur l'app) à travers le choix d'un pack puis du
-- mode de paiement, jusqu'à la prise en charge par un admin. Aucune
-- écriture dans "orders" ici : tout part en notification Telegram privée
-- (telegram_queue) pour rester géré manuellement, comme demandé.
-- ============================================================

create table if not exists public.bot_conversations (
  chat_id bigint primary key,
  state text not null default 'start',
  pack_type text,
  payment_method text,
  pcs_code text,
  telegram_username text,
  telegram_name text,
  order_ref text,
  relaunch_count integer not null default 0,
  last_relaunch_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.bot_conversations add column if not exists relaunch_count integer not null default 0;
alter table public.bot_conversations add column if not exists last_relaunch_at timestamptz;
-- Petites questions posées en attendant la prise en charge admin (plateforme/sport
-- de pari habituels), pour personnaliser l'échange et aider à la négociation.
alter table public.bot_conversations add column if not exists betting_platform text;
alter table public.bot_conversations add column if not exists betting_sport text;
alter table public.bot_conversations add column if not exists betting_experience text;
alter table public.bot_conversations add column if not exists betting_luck text;
alter table public.bot_conversations enable row level security;

-- Horodatage du premier contact admin (informatif) + historique complet de
-- l'échange (messages du lead ET réponses de l'admin, dans l'ordre) pour la
-- section "Leads Telegram en attente" du Panel Admin > Commandes -- permet un
-- vrai aller-retour au lieu d'un message unique. lead_resolved contrôle
-- l'affichage dans la liste "à traiter" (l'admin le coche une fois l'échange
-- terminé), indépendamment de admin_contacted_at.
alter table public.bot_conversations add column if not exists admin_contacted_at timestamptz;
alter table public.bot_conversations add column if not exists messages jsonb not null default '[]'::jsonb;
alter table public.bot_conversations add column if not exists lead_resolved boolean not null default false;

drop policy if exists "Admins can view bot conversations" on public.bot_conversations;
create policy "Admins can view bot conversations"
  on public.bot_conversations for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

drop policy if exists "Admins can update bot conversations" on public.bot_conversations;
create policy "Admins can update bot conversations"
  on public.bot_conversations for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Table de correspondance "message relayé dans le chat perso de l'admin avec
-- le bot" -> "lead d'origine" (voir relayLeadMessageToAdmin dans
-- sales-bot-webhook.js). Permet à l'admin de répondre directement à un
-- message Telegram (fonction "Répondre") pour relayer sa réponse au lead,
-- sans jamais ouvrir l'app. Accès service_role uniquement (webhook), aucune
-- policy client nécessaire.
create table if not exists public.bot_relay_map (
  relay_message_id bigint primary key,
  lead_chat_id bigint not null,
  created_at timestamptz not null default now()
);
alter table public.bot_relay_map enable row level security;

-- ============================================================
-- Codes d'accès pack (Journalier / Hebdo / SM VIP+) — générés
-- manuellement par l'admin depuis Panel Admin > Commandes, puis
-- transmis à la main (WhatsApp, en personne, etc.) au client.
-- Un code est à usage unique : une fois saisi dans "Débloquer mon
-- accès", il change le rôle du compte (is_vip) pour la durée du pack,
-- et se marque comme utilisé pour ne plus jamais être réutilisable.
-- ============================================================

alter table public.profiles
  add column if not exists vip_expires_at timestamptz,
  add column if not exists vip_pack_type text;

create table if not exists public.vip_access_codes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  pack_type text not null,
  code text not null unique,
  duration_days integer,
  used boolean not null default false,
  used_by uuid references auth.users(id),
  used_at timestamptz
);
alter table public.vip_access_codes enable row level security;

drop policy if exists "Admins can manage vip access codes" on public.vip_access_codes;
create policy "Admins can manage vip access codes"
  on public.vip_access_codes for all
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Nécessaire pour que n'importe quel utilisateur connecté puisse vérifier
-- un code saisi dans "Débloquer mon accès" (le code lui a été transmis à
-- la main, il n'est jamais affiché dans l'app pour un autre utilisateur).
drop policy if exists "Users can look up an unused code to redeem it" on public.vip_access_codes;
create policy "Users can look up an unused code to redeem it"
  on public.vip_access_codes for select
  using (used = false or used_by = auth.uid());

drop policy if exists "Users can redeem an unused code" on public.vip_access_codes;
create policy "Users can redeem an unused code"
  on public.vip_access_codes for update
  using (used = false)
  with check (used_by = auth.uid() and used = true);

-- ============================================================
-- Date de création du compte, directement sur profiles (jusqu'ici
-- uniquement dans auth.users, pas consultable facilement depuis le
-- Table Editor). Rétro-remplie depuis auth.users pour les comptes
-- déjà existants ; les nouveaux comptes prennent la valeur par défaut.
-- ============================================================

alter table public.profiles
  add column if not exists created_at timestamptz not null default now();

update public.profiles p
set created_at = u.created_at
from auth.users u
where u.id = p.id
  and p.created_at is distinct from u.created_at;

-- ============================================================
-- Confirmation d'adresse mail (Visiteur -> Membre SM) — vérifiée via un
-- code OTP envoyé par email (indépendant de la connexion par mot de passe,
-- qui reste inchangée). Voir sendEmailConfirmationCode/verifyEmailConfirmationCode.
-- ============================================================

alter table public.profiles
  add column if not exists email_confirmed boolean not null default false;

-- ============================================================
-- Avatar de profil — réservé au logo SM pour les admins ; les comptes
-- normaux reçoivent un animal aléatoire à l'inscription et peuvent en
-- changer depuis les paramètres du profil.
-- ============================================================

alter table public.profiles
  add column if not exists avatar_key text;

-- ============================================================
-- Verrouillage colonne par colonne de public.profiles (defense-in-depth).
--
-- Peu importe les policies RLS existantes (qui autorisent une ligne, pas une
-- colonne précise), un utilisateur connecté avec la clé anon pourrait sinon
-- appeler directement l'API REST Supabase (hors de l'app) et faire
-- `update profiles set is_vip=true, is_admin=true where id=auth.uid()` —
-- s'auto-accorder le VIP+ ou les droits admin gratuitement, sans code ni
-- validation. Ici on retire le droit UPDATE générique du rôle "authenticated"
-- puis on ne le redonne que sur les colonnes strictement cosmétiques que le
-- client doit pouvoir modifier lui-même. is_vip/vip_expires_at/vip_pack_type/
-- is_admin ne sont modifiables que par le service_role (Panel Admin, et
-- /api/redeem-code.js pour la rédemption de code), qui contourne toujours RLS.
revoke update on public.profiles from authenticated;
grant update (username, avatar_key, email_confirmed) on public.profiles to authenticated;

-- ============================================================
-- Interrupteurs pratiques pour valider un client manuellement depuis le
-- Table Editor Supabase, sans écrire de SQL : coche TRUE sur une ligne,
-- le trigger applique le pack (is_vip + durée) et remet la case à FALSE
-- automatiquement. Volontairement PAS accordées au rôle "authenticated"
-- (voir revoke plus haut) : seul un admin dans le Dashboard peut les cocher.
-- ============================================================

alter table public.profiles
  add column if not exists set_pack_journalier boolean not null default false,
  add column if not exists set_pack_hebdo boolean not null default false,
  add column if not exists set_pack_vip boolean not null default false;

create or replace function public.apply_profile_pack_toggle()
returns trigger as $$
begin
  if new.set_pack_journalier is true then
    new.is_vip := true;
    new.vip_pack_type := 'journalier';
    new.vip_expires_at := now() + interval '1 day';
    new.set_pack_journalier := false;
  end if;

  if new.set_pack_hebdo is true then
    new.is_vip := true;
    new.vip_pack_type := 'hebdo';
    new.vip_expires_at := now() + interval '7 days';
    new.set_pack_hebdo := false;
  end if;

  if new.set_pack_vip is true then
    new.is_vip := true;
    new.vip_pack_type := 'vip';
    new.vip_expires_at := null;
    new.set_pack_vip := false;
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_apply_profile_pack_toggle on public.profiles;
create trigger trg_apply_profile_pack_toggle
  before update on public.profiles
  for each row execute function public.apply_profile_pack_toggle();

-- ============================================================
-- Heure de publication des combinés publics (page « Mes tickets »).
-- Colonne ajoutée sans défaut pour ne pas dater les anciens combinés
-- à l'heure de la migration ; le défaut vaut pour les nouveaux.
-- ============================================================

alter table public.combineds_public
  add column if not exists created_at timestamptz;

alter table public.combineds_public
  alter column created_at set default now();

-- ============================================================
-- SM points (phase de test) — monnaie fictive de Score Master.
-- Solde sur profiles.sm_points, historique dans sm_points_transactions,
-- règles (bonus d'inscription, parrainage) dans sm_points_settings.
-- Le solde n'est jamais modifiable depuis le navigateur (voir le
-- verrouillage colonne par colonne de profiles plus haut) : tout passe
-- par les fonctions admin_* ci-dessous, qui vérifient is_admin.
-- ============================================================

alter table public.profiles
  add column if not exists sm_points numeric(12,2) not null default 0;

create table if not exists public.sm_points_transactions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  amount numeric(12,2) not null,
  reason text not null,
  balance_after numeric(12,2) not null,
  created_by uuid,
  created_at timestamptz not null default now()
);
alter table public.sm_points_transactions enable row level security;

drop policy if exists "Users can view their own sm points history" on public.sm_points_transactions;
create policy "Users can view their own sm points history"
  on public.sm_points_transactions for select
  using (user_id = auth.uid());

drop policy if exists "Admins can view all sm points history" on public.sm_points_transactions;
create policy "Admins can view all sm points history"
  on public.sm_points_transactions for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

create table if not exists public.sm_points_settings (
  id text primary key default 'singleton',
  enabled boolean not null default false,
  welcome_bonus integer not null default 100,
  referral_friends integer not null default 3,
  referral_reward integer not null default 50,
  updated_at timestamptz not null default now()
);
insert into public.sm_points_settings (id) values ('singleton') on conflict do nothing;
alter table public.sm_points_settings enable row level security;

drop policy if exists "Anyone can read sm points settings" on public.sm_points_settings;
create policy "Anyone can read sm points settings"
  on public.sm_points_settings for select
  using (true);

drop policy if exists "Admins can update sm points settings" on public.sm_points_settings;
create policy "Admins can update sm points settings"
  on public.sm_points_settings for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

-- Liste des membres et de leur solde (admin uniquement).
create or replace function public.admin_list_sm_points(p_search text default '')
returns table (id uuid, username text, email text, sm_points numeric, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where profiles.id = auth.uid() and is_admin = true) then
    raise exception 'Réservé aux admins';
  end if;
  return query
    select p.id, p.username, p.email, p.sm_points, p.created_at
    from profiles p
    where coalesce(p_search, '') = ''
       or p.username ilike '%' || p_search || '%'
       or p.email ilike '%' || p_search || '%'
    order by p.sm_points desc, p.created_at desc
    limit 100;
end $$;

-- Crédit / débit atomique : met à jour le solde et journalise en une transaction.
create or replace function public.admin_adjust_sm_points(p_user uuid, p_amount numeric, p_reason text)
returns numeric
language plpgsql security definer set search_path = public as $$
declare v_balance numeric;
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_admin = true) then
    raise exception 'Réservé aux admins';
  end if;
  if p_amount is null or p_amount = 0 then
    raise exception 'Montant nul';
  end if;
  update profiles set sm_points = sm_points + p_amount where id = p_user
    returning sm_points into v_balance;
  if v_balance is null then
    raise exception 'Membre introuvable';
  end if;
  if v_balance < 0 then
    raise exception 'Solde insuffisant';
  end if;
  insert into sm_points_transactions (user_id, amount, reason, balance_after, created_by)
    values (p_user, p_amount, coalesce(nullif(trim(p_reason), ''), 'Ajustement admin'), v_balance, auth.uid());
  return v_balance;
end $$;

-- Dernières opérations avec le pseudo du membre (admin uniquement).
create or replace function public.admin_sm_points_history(p_limit integer default 30)
returns table (id bigint, username text, email text, amount numeric, reason text, balance_after numeric, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where profiles.id = auth.uid() and is_admin = true) then
    raise exception 'Réservé aux admins';
  end if;
  return query
    select t.id, p.username, p.email, t.amount, t.reason, t.balance_after, t.created_at
    from sm_points_transactions t
    join profiles p on p.id = t.user_id
    order by t.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 200);
end $$;

revoke all on function public.admin_list_sm_points(text) from public;
revoke all on function public.admin_adjust_sm_points(uuid, numeric, text) from public;
revoke all on function public.admin_sm_points_history(integer) from public;
grant execute on function public.admin_list_sm_points(text) to authenticated;
grant execute on function public.admin_adjust_sm_points(uuid, numeric, text) to authenticated;
grant execute on function public.admin_sm_points_history(integer) to authenticated;

-- ============================================================
-- Alerte Telegram « fin de match imminente » (api/auto-confirm.js) :
-- marque le combiné pour n'envoyer le message qu'une seule fois.
-- ============================================================

alter table public.combineds_public
  add column if not exists end_notified_at timestamptz;

-- ============================================================
-- Rôle « Testeur » : code à usage unique (préfixe SMT) qui donne pendant
-- 5 minutes le libellé de rôle « Testeur » au compte qui le saisit, et
-- rien d'autre. Aucun accès supplémentaire : is_vip et vip_pack_type ne
-- sont pas touchés. La date de fin est écrite uniquement par
-- api/redeem-code.js (clé service_role) ; la colonne n'est pas dans la
-- liste des colonnes modifiables par le client (voir le grant plus haut).
-- ============================================================

alter table public.profiles
  add column if not exists tester_until timestamptz;

-- ============================================================
-- Rôle « Membre SM » par code : code à usage unique (préfixe SMM) qui
-- passe définitivement le compte en « Membre SM ». Comme le rôle Testeur,
-- il n'accorde AUCUN droit supplémentaire (mêmes permissions qu'un
-- visiteur) : seul le libellé du rôle change. Écrit uniquement par
-- api/redeem-code.js (clé service_role).
-- ============================================================

alter table public.profiles
  add column if not exists is_member boolean not null default false;
