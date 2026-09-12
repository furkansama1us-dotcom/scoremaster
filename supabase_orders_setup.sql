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

alter table public.pending_publications enable row level security;

drop policy if exists "Admins can view all pending publications" on public.pending_publications;
create policy "Admins can view all pending publications"
  on public.pending_publications for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

drop policy if exists "Admins can update pending publications" on public.pending_publications;
create policy "Admins can update pending publications"
  on public.pending_publications for update
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
