alter table authorization_actions
  drop constraint if exists authorization_actions_required_mode_check;

alter table authorization_actions
  add constraint authorization_actions_required_mode_check
  check(required_mode in ('parent_management','learner_mode','app_service','administrator','support','service'));

comment on column authorization_actions.required_mode is
  'AU-001 unified verified principal category required for the canonical action.';
