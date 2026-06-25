# Legacy debug scripts — DO NOT USE IN PRODUCTION

These files were moved here from the repo root during the scaling
audit cleanup. They contain **hardcoded credentials** and were
used for ad-hoc debugging during development.

They are kept ONLY for historical reference. Do not run any of
them against production.

| File | Original purpose | Why it's here |
|---|---|---|
| `check_hash.js` | Verify bcrypt hash against `'password123'` | Hardcoded hash, debug-only |
| `check_sahithi.js` | Look up a test user named "sahithi" | Hardcoded DB password `'achyu'` |
| `createDevicesTable.js` | One-off devices table creation | Superseded by `database/migrations/devices_migration.sql` |
| `query_group_vehicles.js` | Dump vehicle-group join rows | Debug query, hardcoded DB password |
| `test.js` | Print all users | Throwaway test |
| `test_id.js` | Query one vehicle's metadata | Throwaway test |
| `wipe_seed.js` | **Delete all non-super-admin org data** | Hardcoded DB password `'postgres'`, destructive — accidental run would wipe everything |

## Why these aren't just deleted

We keep them so future engineers can see what NOT to do
(hardcoded creds, throwaway scripts at root, destructive scripts
without env-var safety checks). They are NOT load-bearing and
should not be referenced by the deploy pipeline.

## What to use instead

For any DB inspection, use `psql` directly with the `.env` credentials:

```bash
sudo -u postgres psql -d fueltracks -c "SELECT id, name FROM vehicles;"
```

For data wipe (if absolutely needed), use `scripts/_debug_legacy/wipe_seed.js`
ONLY after confirming `NODE_ENV !== 'production'`. We should add
a guard to that script before re-using it.
