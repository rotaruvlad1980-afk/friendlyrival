-- ─── FriendlyRival — Schema bază de date ────────────────────────────────────

-- Activează extensia pentru UUID-uri
create extension if not exists "uuid-ossp";

-- ─── GRUPURI ─────────────────────────────────────────────────────────────────
create table groups (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  invite_code text unique not null default substring(md5(random()::text), 1, 8),
  created_at timestamptz default now()
);

-- ─── PROFILURI UTILIZATORI ───────────────────────────────────────────────────
-- Extinde auth.users din Supabase cu date extra
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  display_name text not null,
  is_admin boolean default false,
  group_id uuid references groups(id) on delete set null,
  created_at timestamptz default now()
);

-- ─── MECIURI ─────────────────────────────────────────────────────────────────
create table matches (
  id integer primary key,
  home text not null,
  away text not null,
  match_date timestamptz not null,
  match_group text,
  round text not null,
  score_home integer,
  score_away integer,
  is_manual boolean default false,
  updated_at timestamptz default now()
);

-- ─── PARIURI ─────────────────────────────────────────────────────────────────
create table predictions (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) on delete cascade,
  match_id integer references matches(id) on delete cascade,
  score_home integer,
  score_away integer,
  locked boolean default false,
  locked_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique(user_id, match_id)
);

-- ─── FINALISTE ───────────────────────────────────────────────────────────────
create table finalists (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles(id) on delete cascade unique,
  team1 text,
  team2 text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Finalistele reale (setate de admin)
create table actual_finalists (
  id integer primary key default 1,
  team1 text,
  team2 text,
  updated_at timestamptz default now()
);
insert into actual_finalists (id) values (1) on conflict do nothing;

-- ─── ROW LEVEL SECURITY (RLS) ────────────────────────────────────────────────
-- Protejează datele — fiecare user vede doar ce trebuie

alter table profiles enable row level security;
alter table matches enable row level security;
alter table predictions enable row level security;
alter table finalists enable row level security;
alter table actual_finalists enable row level security;
alter table groups enable row level security;

-- Profiles: fiecare vede toate profilurile din grupul său
create policy "Profiles vizibile pentru toti" on profiles
  for select using (true);

create policy "Utilizatorul isi editeaza propriul profil" on profiles
  for update using (auth.uid() = id);

create policy "Insert profil la inregistrare" on profiles
  for insert with check (auth.uid() = id);

-- Matches: toată lumea vede meciurile, doar adminul le modifică
create policy "Meciuri vizibile pentru toti" on matches
  for select using (true);

create policy "Admin poate modifica meciuri" on matches
  for all using (
    exists (select 1 from profiles where id = auth.uid() and is_admin = true)
  );

-- Predictions: 
-- Înainte de blocare: fiecare vede doar ale lui
-- După blocare: toți văd
create policy "Vad propriile pariuri" on predictions
  for select using (
    user_id = auth.uid() or locked = true
  );

create policy "Insert pariu propriu" on predictions
  for insert with check (user_id = auth.uid());

create policy "Update pariu propriu neblocat" on predictions
  for update using (
    user_id = auth.uid() and locked = false
  );

create policy "Admin poate debloca pariuri" on predictions
  for update using (
    exists (select 1 from profiles where id = auth.uid() and is_admin = true)
  );

-- Finalists:
-- Înainte de start: fiecare vede doar ale lui
-- După start campionat: toți văd
create policy "Finaliste vizibile" on finalists
  for select using (
    user_id = auth.uid() or
    now() > '2026-06-11T19:00:00Z'::timestamptz
  );

create policy "Insert finaliste proprii" on finalists
  for insert with check (user_id = auth.uid());

create policy "Update finaliste proprii" on finalists
  for update using (
    user_id = auth.uid() and
    now() < '2026-06-11T19:00:00Z'::timestamptz
  );

-- Actual finalists: toată lumea vede, doar adminul modifică
create policy "Toti vad finalistele reale" on actual_finalists
  for select using (true);

create policy "Admin seteaza finalistele reale" on actual_finalists
  for update using (
    exists (select 1 from profiles where id = auth.uid() and is_admin = true)
  );

-- Groups: toată lumea vede
create policy "Grupuri vizibile" on groups
  for select using (true);

create policy "Admin creeaza grupuri" on groups
  for insert with check (
    exists (select 1 from profiles where id = auth.uid() and is_admin = true)
  );

-- ─── FUNCȚII HELPER ──────────────────────────────────────────────────────────

-- Blocare automată pariuri cu 30 min înainte de meci
create or replace function lock_predictions_for_match(match_id_param integer)
returns void as $$
  update predictions
  set locked = true, locked_at = now()
  where match_id = match_id_param and locked = false;
$$ language sql security definer;

-- Trigger: actualizează updated_at automat
create or replace function update_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger predictions_updated_at
  before update on predictions
  for each row execute function update_updated_at();

create trigger finalists_updated_at
  before update on finalists
  for each row execute function update_updated_at();
