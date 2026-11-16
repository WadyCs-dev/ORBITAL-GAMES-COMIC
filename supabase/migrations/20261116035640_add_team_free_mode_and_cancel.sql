-- Team-wide free-fuel setting and safe cancellation of active cooperative missions.
begin;

alter table public.orbital_teams
  add column if not exists game_mode text not null default 'standard';

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orbital_teams'::regclass
      and conname = 'orbital_teams_game_mode_check'
  ) then
    alter table public.orbital_teams
      add constraint orbital_teams_game_mode_check check (game_mode in ('standard','free'));
  end if;
end $$;

create or replace function public.orbital_set_team_game_mode(target_team uuid, selected_mode text)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_mode text := lower(btrim(coalesce(selected_mode,'')));
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if v_mode not in ('standard','free') then raise exception 'Invalid team game mode'; end if;
  update public.orbital_teams set game_mode=v_mode where id=target_team and owner_id=v_user;
  if not found then raise exception 'Only the team owner may change its game mode' using errcode='42501'; end if;
  return v_mode;
end $$;

create or replace function public.orbital_start_team_mission(target_team uuid,target_mission text)
returns public.orbital_team_sessions language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session public.orbital_team_sessions%rowtype;
  v_connected_count integer;
  v_ready_count integer;
  v_game_mode text;
begin
  if v_user is null or not exists(select 1 from public.orbital_team_members where team_id=target_team and user_id=v_user) then
    raise exception 'Not a team member' using errcode='42501';
  end if;
  if target_mission is null or target_mission not in ('earth','moon','mercury','venus','mars','jupiter','europa','saturn','titan','uranus','neptune','sun','asteroid') then
    raise exception 'Invalid mission';
  end if;

  select * into v_session from public.orbital_team_sessions where team_id=target_team for update;
  if not found then raise exception 'Team session is not connected'; end if;
  if v_session.host_user_id<>v_user then raise exception 'Only the current host may start the mission' using errcode='42501'; end if;
  if v_session.status='active' then raise exception 'Mission already active'; end if;

  -- A saved team plan is a reference, not a restriction on which unlocked mission can start.
  select game_mode into v_game_mode from public.orbital_teams where id=target_team;
  v_game_mode := case when v_game_mode='free' then 'free' else 'standard' end;

  select count(*) into v_connected_count
  from public.orbital_team_members m
  join public.orbital_team_session_players p using(team_id,user_id)
  where m.team_id=target_team and p.last_seen>now()-interval '15 seconds';

  select count(*) into v_ready_count
  from public.orbital_team_members m
  join public.orbital_team_session_players p using(team_id,user_id)
  where m.team_id=target_team and p.ready and p.last_seen>now()-interval '15 seconds';

  if v_connected_count not between 2 and 4 then raise exception 'At least two team members must be connected'; end if;
  if v_ready_count<>v_connected_count then raise exception 'Every connected team member must be ready'; end if;
  if not exists(
    select 1 from public.orbital_team_session_players
    where team_id=target_team and user_id=v_user and ready and last_seen>now()-interval '15 seconds'
  ) then raise exception 'The host must be connected and ready'; end if;

  update public.orbital_team_sessions set mission_id=target_mission,status='active',revision=revision+1,
    state=jsonb_build_object('route',target_mission,'game_mode',v_game_mode,'repairs',0,'samples','[]'::jsonb,'scans','[]'::jsonb,'transmitted',false,'interactions','[]'::jsonb,
      'resources',jsonb_build_object('fuel',100,'energy',100,'integrity',100),'contributions',jsonb_build_object(v_user::text,1)),
    started_at=now(),completed_at=null,updated_at=now()
  where team_id=target_team returning * into v_session;
  return v_session;
end $$;

create or replace function public.orbital_cancel_team_mission(target_team uuid)
returns public.orbital_team_sessions language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session public.orbital_team_sessions%rowtype;
begin
  if v_user is null or not exists(select 1 from public.orbital_team_members where team_id=target_team and user_id=v_user) then
    raise exception 'Not a team member' using errcode='42501';
  end if;
  select * into v_session from public.orbital_team_sessions where team_id=target_team for update;
  if not found or v_session.status<>'active' then raise exception 'No team mission is active'; end if;
  if v_session.host_user_id<>v_user then raise exception 'Only the current host may cancel the mission' using errcode='42501'; end if;
  update public.orbital_team_sessions set status='lobby',state='{}'::jsonb,started_at=null,completed_at=null,
    revision=revision+1,updated_at=now()
  where team_id=target_team returning * into v_session;
  return v_session;
end $$;

revoke all on function public.orbital_set_team_game_mode(uuid,text),public.orbital_cancel_team_mission(uuid) from public,anon;
grant execute on function public.orbital_set_team_game_mode(uuid,text),public.orbital_cancel_team_mission(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
