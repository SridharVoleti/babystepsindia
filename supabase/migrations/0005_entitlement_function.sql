-- REQ-08 §3.5 — single shared function; every access decision, including
-- the JWT claims generator (§4.1), calls this.

create or replace function fn_has_product_access(p_user_id uuid, p_product_slug text)
returns boolean as $$
  select exists (
    select 1
    from subscriptions s
    join products p on p.slug = p_product_slug
    where s.user_id = p_user_id
      and s.status in ('active','cancelling','past_due')
      and (
        s.type = 'bundle'
        or s.product_id = p.id
      )
      and s.current_period_end > now()
  );
$$ language sql stable security definer;
