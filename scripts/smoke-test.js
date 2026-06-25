// ============================================================
// SMOKE TEST — verify scaling changes load without runtime errors.
// Runs no real DB / Redis ops; just requires every changed module
// and reports whether the require graph is internally consistent.
// Catches issues like:
//   - missing exports (e.g. typo on TRACKING_STREAM)
//   - circular requires
//   - syntax errors that survived `node -c`
// Run: node scripts/smoke-test.js
// ============================================================

'use strict';

const tests = [];
const results = { pass: 0, fail: 0, errors: [] };

function test(name, fn) {
  tests.push({ name, fn });
}

test('shared/metrics exports Counter/Gauge/Histogram/registry', () => {
  const m = require('../shared/metrics');
  if (!m.registry) throw new Error('missing registry');
  if (!m.Counter) throw new Error('missing Counter');
  if (!m.Gauge) throw new Error('missing Gauge');
  if (!m.Histogram) throw new Error('missing Histogram');
  const c = m.registry.counter('test_counter', 'help');
  c.inc(5);
  if (c.value !== 5) throw new Error('counter inc broken');
  const out = m.registry.render();
  if (!out.includes('test_counter 5')) throw new Error('render broken');
});

test('tcp-server/publisher exports XADD-based API + stream names', () => {
  const p = require('../tcp-server/publisher');
  if (typeof p.init !== 'function') throw new Error('missing init');
  if (typeof p.publishLocation !== 'function') throw new Error('missing publishLocation');
  if (typeof p.publishAlert !== 'function') throw new Error('missing publishAlert');
  if (typeof p.publishRawMessage !== 'function') throw new Error('missing publishRawMessage');
  if (p.TRACKING_STREAM !== 'tracking:stream') throw new Error('TRACKING_STREAM wrong');
  if (p.ALERTS_STREAM !== 'alerts:stream') throw new Error('ALERTS_STREAM wrong');
  if (p.RAW_STREAM !== 'raw:stream') throw new Error('RAW_STREAM wrong');
});

test('backend/streams/redisStreams exports XREADGROUP helpers', () => {
  const s = require('../backend/streams/redisStreams');
  if (typeof s.ensureGroup !== 'function') throw new Error('missing ensureGroup');
  if (typeof s.readNew !== 'function') throw new Error('missing readNew');
  if (typeof s.readPending !== 'function') throw new Error('missing readPending');
  if (typeof s.ack !== 'function') throw new Error('missing ack');
  if (typeof s.runConsumerLoop !== 'function') throw new Error('missing runConsumerLoop');
});

test('backend/middleware/rateLimit exports token-bucket API', () => {
  const rl = require('../backend/middleware/rateLimit');
  if (typeof rl.rateLimit !== 'function') throw new Error('missing rateLimit');
  if (typeof rl.TokenBucket !== 'function') throw new Error('missing TokenBucket');
  // Functional check
  const b = new rl.TokenBucket(2, 1);
  if (!b.take()) throw new Error('bucket did not take first token');
  if (!b.take()) throw new Error('bucket did not take second token');
  if (b.take()) throw new Error('bucket took a third token from empty');
});

test('backend/config/env validates defaults', () => {
  // Just require it; we don't want to validate the runtime check
  // because that may exit in production. Just make sure it loads.
  delete require.cache[require.resolve('../backend/config/env')];
  const env = require('../backend/config/env');
  if (typeof env.API_PORT !== 'number') throw new Error('API_PORT not numeric');
  if (typeof env.TCP_PORT !== 'number') throw new Error('TCP_PORT not numeric');
});

test('backend/config/db pool config has raised max', () => {
  // We can't actually instantiate the pool without DB creds, but
  // we can require the module to ensure it loads.
  // We don't actually invoke db.query to avoid hitting DB.
  delete require.cache[require.resolve('../backend/config/db')];
  const db = require('../backend/config/db');
  if (typeof db.query !== 'function') throw new Error('missing query');
  if (typeof db.getClient !== 'function') throw new Error('missing getClient');
  if (!db.pool) throw new Error('missing pool');
  if (db.pool.options.max < 30) throw new Error('pool max not raised to >=30');
});

test('backend/models/gpsModel has batch helpers', () => {
  delete require.cache[require.resolve('../backend/models/gpsModel')];
  const m = require('../backend/models/gpsModel');
  if (typeof m.savePointsBatch !== 'function') throw new Error('missing savePointsBatch');
  if (typeof m.updateLatestStatesBatch !== 'function') throw new Error('missing updateLatestStatesBatch');
  if (typeof m.savePoint !== 'function') throw new Error('missing savePoint (legacy)');
});

test('writer/server can require without env errors', () => {
  // We require the module but don't call start() (that would try
  // to connect to Redis). The require itself must succeed.
  delete require.cache[require.resolve('../writer/server')];
  // The module calls require('dotenv').config() which is OK even
  // without .env.
  require('../writer/server');
});

(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`  PASS  ${t.name}`);
      results.pass++;
    } catch (err) {
      console.log(`  FAIL  ${t.name}: ${err.message}`);
      results.fail++;
      results.errors.push({ test: t.name, error: err.message });
    }
  }
  console.log('');
  console.log(`Smoke test results: ${results.pass} passed, ${results.fail} failed.`);
  if (results.fail > 0) {
    console.log('FAILURES:');
    for (const e of results.errors) console.log(`  - ${e.test}: ${e.error}`);
    process.exit(1);
  }
  process.exit(0);
})();
