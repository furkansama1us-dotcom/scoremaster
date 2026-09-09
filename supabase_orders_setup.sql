-- À exécuter une seule fois dans Supabase : Dashboard > SQL Editor > New query > Run

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

create policy "Users can insert their own orders"
  on public.orders for insert
  with check (auth.uid() = user_id);

create policy "Users can view their own orders"
  on public.orders for select
  using (auth.uid() = user_id);

create policy "Admins can view all orders"
  on public.orders for select
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));
