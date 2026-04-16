-- Enforce uniqueness on Provider.contactEmail so register/login cannot
-- race into duplicate accounts. If this migration fails because existing
-- rows already have duplicate emails, dedupe the offending rows manually
-- (e.g. SELECT "contactEmail", COUNT(*) FROM "Provider" GROUP BY 1 HAVING COUNT(*) > 1)
-- before re-running.

CREATE UNIQUE INDEX "Provider_contactEmail_key" ON "Provider"("contactEmail");
