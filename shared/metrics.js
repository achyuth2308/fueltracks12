// ============================================================
// PROMETHEUS METRICS MODULE
// Phase 7.1 of SCALING_ROADMAP.md
//
// Lightweight in-process counters exported as a Prometheus
// text-format endpoint. No external deps — we just keep a
// Map<string, Counter|Gauge> and serialise on /metrics scrape.
//
// Used by:
//   - tcp-server (server.js): packets/sec per protocol, sockets,
//     backpressure pauses, rejects-by-cap, parse errors.
//   - backend/server.js (optional): request rate, Socket.io
//     connection count, DB pool wait time.
//   - writer/server.js: already has inline /metrics — could be
//     migrated here for consistency.
// ============================================================

class Counter {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.type = 'counter';
    this.value = 0;
  }
  inc(n = 1) { this.value += n; }
}

class Gauge {
  constructor(name, help) {
    this.name = name;
    this.help = help;
    this.type = 'gauge';
    this.value = 0;
    this.peak = 0;
  }
  set(v) { this.value = v; if (v > this.peak) this.peak = v; }
  inc(n = 1) { this.value += n; if (this.value > this.peak) this.peak = this.value; }
  dec(n = 1) { this.value = Math.max(0, this.value - n); }
}

// Histogram helper (cumulative buckets) — small but enough to
// spot tail-latency issues without pulling in prom-client.
class Histogram {
  constructor(name, help, buckets = [10, 50, 100, 250, 500, 1000, 2500, 5000]) {
    this.name = name;
    this.help = help;
    this.type = 'histogram';
    this.buckets = buckets.slice().sort((a, b) => a - b);
    this.counts = new Array(this.buckets.length).fill(0);
    this.plusInf = 0;
    this.sum = 0;
  }
  observe(v) {
    this.sum += v;
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (v <= this.buckets[i]) {
        for (let j = i; j < this.buckets.length; j++) this.counts[j]++;
        placed = true;
        break;
      }
    }
    if (!placed) this.plusInf++;
  }
}

class MetricsRegistry {
  constructor() { this.items = []; }

  counter(name, help) {
    const c = new Counter(name, help);
    this.items.push(c);
    return c;
  }
  gauge(name, help) {
    const g = new Gauge(name, help);
    this.items.push(g);
    return g;
  }
  histogram(name, help, buckets) {
    const h = new Histogram(name, help, buckets);
    this.items.push(h);
    return h;
  }

  render() {
    const lines = [];
    for (const it of this.items) {
      if (it instanceof Counter || it instanceof Gauge) {
        lines.push(`# HELP ${it.name} ${it.help}`);
        lines.push(`# TYPE ${it.name} ${it.type}`);
        lines.push(`${it.name} ${it.value}`);
      } else if (it instanceof Histogram) {
        lines.push(`# HELP ${it.name} ${it.help}`);
        lines.push(`# TYPE ${it.name} histogram`);
        let cumulative = 0;
        for (let i = 0; i < it.buckets.length; i++) {
          cumulative = it.counts[i];
          lines.push(`${it.name}_bucket{le="${it.buckets[i]}"} ${cumulative}`);
        }
        lines.push(`${it.name}_bucket{le="+Inf"} ${it.plusInf}`);
        lines.push(`${it.name}_sum ${it.sum}`);
        lines.push(`${it.name}_count ${it.plusInf + cumulative}`);
      }
    }
    return lines.join('\n') + '\n';
  }
}

// Singleton registry for the running process.
const registry = new MetricsRegistry();

module.exports = { registry, Counter, Gauge, Histogram, MetricsRegistry };
