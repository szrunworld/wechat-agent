-- Attempts a proven notSent error ends: the reason, beside unknown_reason.
ALTER TABLE attempts ADD COLUMN not_sent_reason TEXT;
