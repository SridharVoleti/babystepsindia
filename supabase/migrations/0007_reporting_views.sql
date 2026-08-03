-- REQ-08 §8 — admin reporting dashboard views.

create view v_daily_revenue_by_product as
select
  date_trunc('day', p.paid_at) as day,
  coalesce(pr.slug, 'bundle') as product_slug,
  sum(p.amount_inr) as revenue_inr,
  count(*) as payment_count
from payments p
join subscriptions s on s.id = p.subscription_id
left join products pr on pr.id = s.product_id
group by 1, 2;

create view v_active_subscribers_by_product as
select
  coalesce(pr.slug, 'bundle') as product_slug,
  count(*) as active_subscribers
from subscriptions s
left join products pr on pr.id = s.product_id
where s.status in ('active','cancelling')
group by 1;

-- Views inherit RLS from their underlying tables only when
-- security_invoker is set; the admin dashboard queries these with the
-- service-role key, so that's the intended access path rather than
-- per-row policies here.
