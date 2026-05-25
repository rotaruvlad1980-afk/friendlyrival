-- ─── Creare utilizatori FriendlyRival ────────────────────────────────────────
-- Rulează acest script în SQL Editor după schema principală

-- Funcție helper pentru creare user
create or replace function create_fr_user(
  p_username text,
  p_display_name text,
  p_password text,
  p_is_admin boolean default false
) returns void as $$
declare
  v_user_id uuid;
  v_email text := p_username || '@friendlyrival.app';
begin
  -- Creează user în auth.users
  v_user_id := (
    select id from auth.users where email = v_email limit 1
  );

  if v_user_id is null then
    insert into auth.users (
      id, email, encrypted_password, email_confirmed_at,
      created_at, updated_at,
      raw_app_meta_data, raw_user_meta_data,
      is_super_admin, role
    ) values (
      uuid_generate_v4(),
      v_email,
      crypt(p_password, gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}',
      '{}',
      false, 'authenticated'
    )
    returning id into v_user_id;
  end if;

  -- Creează profil
  insert into profiles (id, username, display_name, is_admin)
  values (v_user_id, p_username, p_display_name, p_is_admin)
  on conflict (id) do update
    set display_name = p_display_name, is_admin = p_is_admin;
end;
$$ language plpgsql security definer;

-- Activează extensia pgcrypto pentru crypt()
create extension if not exists pgcrypto;

-- ─── Creare utilizatori ───────────────────────────────────────────────────────
select create_fr_user('admin',  'Admin',  'admin123',  true);
select create_fr_user('vlad',   'Vlad',   'vlad123',   false);
select create_fr_user('tudor',  'Tudor',  'tudor123',  false);
select create_fr_user('cristi', 'Cristi', 'cristi123', false);
select create_fr_user('andrei', 'Andrei', 'andrei123', false);
select create_fr_user('gabi',   'Gabi',   'gabi123',   false);

-- Verificare
select username, display_name, is_admin from profiles order by is_admin desc, display_name;
