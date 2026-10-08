-- Serialize installation/preflight with financial writers. Drizzle runs this
-- forward migration in a transaction; do not execute it statement by statement.
LOCK TABLE public.ledger_transactions, public.ledger_entries IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
-- Never silently bless previously corrupted posted evidence or rewrite it.
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
    RAISE EXCEPTION 'Existing POSTED ledger transactions must be balanced in one currency before sealing migration';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION public.protect_ledger_entry_insert() RETURNS trigger AS $$
BEGIN
  -- A real parent UPDATE both serializes against posting and changes the row
  -- version: a stale REPEATABLE READ/SERIALIZABLE writer must abort. A SELECT
  -- FOR UPDATE alone would not invalidate its snapshot of the entries.
  UPDATE public.ledger_transactions
    SET status = status
    WHERE id = NEW.transaction_id AND status = 'DRAFT';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ledger entries can only be inserted into DRAFT transactions; post a compensating journal';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_draft_insert
  BEFORE INSERT ON public.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION public.protect_ledger_entry_insert();
--> statement-breakpoint
-- TRUNCATE bypasses row UPDATE/DELETE and deferred balance triggers entirely.
CREATE FUNCTION public.reject_ledger_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Cannot truncate ledger history; post a compensating journal';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON public.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ledger_truncate();
--> statement-breakpoint
CREATE TRIGGER ledger_transactions_no_truncate
  BEFORE TRUNCATE ON public.ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION public.reject_ledger_truncate();
