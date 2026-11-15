-- Publish team-room changes so members, roles, invitations and shared plans
-- refresh immediately. The client still polls as a recovery path.
begin;

do $$
declare
  target_table text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise exception 'Supabase Realtime publication is missing';
  end if;

  foreach target_table in array array[
    'orbital_teams',
    'orbital_team_members',
    'orbital_team_plans',
    'orbital_team_campaigns'
  ] loop
    if to_regclass(format('public.%I', target_table)) is not null
      and not exists (
        select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = target_table
      ) then
      execute format('alter publication supabase_realtime add table public.%I', target_table);
    end if;
  end loop;
end $$;

commit;

