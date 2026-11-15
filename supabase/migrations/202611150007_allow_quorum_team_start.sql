-- Allow the host to launch a cooperative mission with the connected, ready subset of a team.
begin;

create or replace function public.orbital_start_team_mission(target_team uuid,target_mission text)
returns public.orbital_team_sessions language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_user uuid := auth.uid();
  v_session public.orbital_team_sessions%rowtype;
  v_connected_count integer;
  v_ready_count integer;
  v_plan text;
begin
  if v_user is null or not exists(select 1 from public.orbital_team_members where team_id=target_team and user_id=v_user) then
    raise exception 'Not a team member' using errcode='42501';
  end if;
  if target_mission not in ('earth','moon','mercury','venus','mars','jupiter','europa','saturn','titan','uranus','neptune','sun','asteroid') then
    raise exception 'Invalid mission';
  end if;

  select * into v_session from public.orbital_team_sessions where team_id=target_team for update;
  if not found then raise exception 'Team session is not connected'; end if;
  if v_session.host_user_id<>v_user then raise exception 'Only the current host may start the mission' using errcode='42501'; end if;
  if v_session.status='active' then raise exception 'Mission already active'; end if;

  select mission_id into v_plan from public.orbital_team_plans where team_id=target_team;
  if v_plan is not null and v_plan<>target_mission then raise exception 'Mission does not match the shared team plan'; end if;

  select count(*) into v_connected_count
  from public.orbital_team_members m
  join public.orbital_team_session_players p using(team_id,user_id)
  where m.team_id=target_team and p.last_seen>now()-interval '15 seconds';

  select count(*) into v_ready_count
  from public.orbital_team_members m
  join public.orbital_team_session_players p using(team_id,user_id)
  where m.team_id=target_team and p.ready and p.last_seen>now()-interval '15 seconds';

  if v_connected_count not between 2 and 4 then
    raise exception 'At least two team members must be connected';
  end if;
  if v_ready_count<>v_connected_count then
    raise exception 'Every connected team member must be ready';
  end if;
  if not exists(
    select 1 from public.orbital_team_session_players
    where team_id=target_team and user_id=v_user and ready and last_seen>now()-interval '15 seconds'
  ) then
    raise exception 'The host must be connected and ready';
  end if;

  update public.orbital_team_sessions set mission_id=target_mission,status='active',revision=revision+1,
    state=jsonb_build_object('route',target_mission,'repairs',0,'samples','[]'::jsonb,'scans','[]'::jsonb,'transmitted',false,'interactions','[]'::jsonb,
      'resources',jsonb_build_object('fuel',100,'energy',100,'integrity',100),'contributions',jsonb_build_object(v_user::text,1)),
    started_at=now(),completed_at=null,updated_at=now()
  where team_id=target_team returning * into v_session;
  return v_session;
end $$;

commit;
