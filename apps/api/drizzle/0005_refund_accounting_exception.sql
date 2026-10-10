-- Add a durable disposition for confirmed evidence awaiting accounting review.
-- Existing claim/retry queries do not select this state. No scope is activated.
-- ALTER TYPE takes an enum-object lock; apply through the normal transactional
-- migrator. Use the new label only after migration commit (including fresh installs).
ALTER TYPE public.inbox_status ADD VALUE 'ACCOUNTING_EXCEPTION';
