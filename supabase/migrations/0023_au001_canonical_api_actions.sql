alter table authorization_actions
  drop constraint if exists authorization_actions_required_mode_check;

alter table authorization_actions
  add constraint authorization_actions_required_mode_check
  check(required_mode in ('parent_management','learner_mode','app_service','administrator','service'));

comment on table authorization_actions is
  'AU-001 permanent canonical action catalog covering parent, learner, administrator and managed-service APIs.';
