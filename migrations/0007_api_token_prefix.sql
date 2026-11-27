-- SCRUM-69 (FR-API-07): a token is shown in full only once, when it is created.
-- Afterwards the web app shows its name and this short prefix, so an admin can
-- tell tokens apart. The prefix is the start of the token (e.g. "bpc_3fA9kQ2x")
-- and is not enough to use it; the full token is never stored, only its hash.
-- Tokens created before this migration have no prefix (NULL).

ALTER TABLE api_tokens ADD COLUMN prefix TEXT;
