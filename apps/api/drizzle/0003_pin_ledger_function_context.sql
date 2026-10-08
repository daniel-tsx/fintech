-- Run through the transactional migrator after draining financial writers.
-- Revalidate persistent history while blocking competing ledger writes.
SET LOCAL search_path = pg_catalog, pg_temp;
--> statement-breakpoint
LOCK TABLE public.ledger_transactions, public.ledger_entries IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.ledger_transactions t
    LEFT JOIN public.ledger_entries e ON e.transaction_id = t.id
    WHERE t.status = 'POSTED'
    GROUP BY t.id, t.currency
    HAVING count(e.id) < 2
      OR coalesce(sum(e.debit), 0) <= 0
      OR coalesce(sum(e.debit), 0) <> coalesce(sum(e.credit), 0)
      OR count(DISTINCT e.currency) <> 1
      OR bool_or(e.currency <> t.currency)
  ) THEN
    RAISE EXCEPTION 'Existing POSTED ledger transactions must be balanced in one currency before function hardening migration';
  END IF;
END;
$$;
--> statement-breakpoint
-- Preserve the function identity, grants and existing deferred trigger bindings.
CREATE OR REPLACE FUNCTION public.assert_ledger_transaction_balanced() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  target_id uuid;
  tx_status public.ledger_status;
  tx_currency text;
  debit_total numeric;
  credit_total numeric;
  entry_count integer;
  currency_count integer;
BEGIN
  IF TG_TABLE_NAME = 'ledger_entries' THEN
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.transaction_id ELSE NEW.transaction_id END;
  ELSE
    target_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  END IF;

  SELECT status, currency INTO tx_status, tx_currency
    FROM public.ledger_transactions WHERE id = target_id;
  IF tx_status = 'POSTED' THEN
    SELECT coalesce(sum(debit), 0), coalesce(sum(credit), 0), count(*), count(distinct currency)
      INTO debit_total, credit_total, entry_count, currency_count
      FROM public.ledger_entries WHERE transaction_id = target_id;
    IF entry_count < 2 OR debit_total <= 0 OR debit_total <> credit_total OR currency_count <> 1
      OR EXISTS (SELECT 1 FROM public.ledger_entries WHERE transaction_id = target_id AND currency <> tx_currency) THEN
      RAISE EXCEPTION 'Ledger transaction % is not balanced in one currency (debit %, credit %, entries %)', target_id, debit_total, credit_total, entry_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION public.protect_ledger_entry_insert()
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.protect_immutable_financial_rows()
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp;
--> statement-breakpoint
ALTER FUNCTION public.reject_ledger_truncate()
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp;
