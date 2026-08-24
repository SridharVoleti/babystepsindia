-- BI-005 refund idempotency and retryable immutable adjustment documents.
alter table refund_cases add column if not exists confirmation_idempotency_key text;
alter table refund_cases add column if not exists confirmation_request_hash text;
alter table refund_cases add column if not exists confirmation_result_json jsonb;

create table if not exists refund_adjustment_documents (
  id uuid primary key,
  refund_case_id uuid not null unique references refund_cases(id),
  document_number text not null unique,
  document_type text not null check(document_type='credit_note'),
  amount integer not null check(amount>0),
  currency text not null,
  template_version text not null,
  status text not null check(status in ('pending','failed','issued')),
  attempt_count integer not null default 0,
  storage_ref text,
  last_error_code text,
  issued_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
alter table refund_adjustment_documents enable row level security;
alter table refund_adjustment_documents force row level security;

create or replace function reject_refund_document_context_change()
returns trigger language plpgsql as $$ begin
  raise exception 'refund adjustment document context is immutable';
end $$;
drop trigger if exists refund_adjustment_documents_context_immutable on refund_adjustment_documents;
create trigger refund_adjustment_documents_context_immutable
before update of refund_case_id,document_number,document_type,amount,currency,template_version,created_at
on refund_adjustment_documents for each row execute function reject_refund_document_context_change();

drop trigger if exists refund_adjustment_documents_no_delete on refund_adjustment_documents;
create trigger refund_adjustment_documents_no_delete before delete on refund_adjustment_documents
for each row execute function reject_financial_evidence_delete();
