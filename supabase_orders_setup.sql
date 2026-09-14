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
