-- PRG-042: approved_app_icons.id was declared uuid, but icon keys are text identifiers ('icon-open-book', ...) everywhere in the code, in
-- apps' icon_asset_key values, and in the SQLite bootstrap list (src/lib/db/client.ts APPROVED_APP_ICONS). On PostgreSQL every icon check
-- failed with 'invalid input syntax for type uuid'. Convert the key to text (like approved_avatars.id) and seed the same approved icons.
-- No table references approved_app_icons(id) by foreign key. BR-003: reviewed-breaking-change
begin;
alter table approved_app_icons alter column id drop default;
alter table approved_app_icons alter column id type text using id::text;
insert into approved_app_icons (id, label, active) values
  ('icon-chess-piece', 'Chess piece', true),
  ('icon-abacus', 'Abacus', true),
  ('icon-open-book', 'Open book', true)
on conflict (id) do update set label = excluded.label, active = true;
commit;
