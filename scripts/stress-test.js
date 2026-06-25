// ============================================================
// STRESS TEST — FuelTracks
// Ramps up 0 -> 10K (configurable) concurrent device connections
// across all 3 protocols and sustains a configurable packet rate.
// Designed to validate the scaling changes BEFORE onboarding real
// fleet devices.
//
// Usage:
//   node scripts/stress-test.js                       # defaults
//   node scripts/stress-test.js --devices 5000        # 5k devices
//   node scripts/stress-test.js --ramp-step 100 --ramp-interval-ms 500
//                                                   # add 100 devices every 500ms
//   node scripts/stress-test.js --packet-rate 0.2     # 1 pkt / 5 sec
//   node scripts/stress-test.js --duration-sec 3600   # 1 hour soak
//   node scripts/stress-test.js --protocols bstpl     # only BSTPL
//   node scripts/stress-test.js --split 0.5,0.3,0.2   # 50/30/20 split
//
// Environment overrides (lower precedence than CLI):
//   STRESS_HOST          (default: 127.0.0.1)
//   STRESS_DEVICES       (default: 10000)
//   STRESS_PACKET_RATE   (default: 0.033 = ~1 per 30s)
//   STRESS_RAMP_INTERVAL_MS (default: 200)
//   STRESS_RAMP_STEP     (default: 50)
//
// Outputs every 5 seconds:
//   - Active connections per protocol
//   - Packets sent / sec per protocol
//   - Errors / reconnects
//   - p50/p95/p99 packet send latency (local clock only)
// ============================================================

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const net = require('net');
const { crcItu } = require('../tcp-server/parser/concoxCrc');

// -------------------- CLI parsing --------------------
const argv = process.argv.slice(2);
function getArg(name, defaultVal) {
  const i = argv.indexOf(`--${name}`);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return defaultVal;
}

const CONFIG = {
  host: getArg('host', process.env.STRESS_HOST || '127.0.0.1'),
  devices: parseInt(getArg('devices', process.env.STRESS_DEVICES || '10000')),
  packetRate: parseFloat(getArg('packet-rate', process.env.STRESS_PACKET_RATE || '0.033')),
  rampStep: parseInt(getArg('ramp-step', process.env.STRESS_RAMP_STEP || '50')),
  rampIntervalMs: parseInt(getArg('ramp-interval-ms', process.env.STRESS_RAMP_INTERVAL_MS || '200')),
  durationSec: parseInt(getArg('duration-sec', '0')),     // 0 = unlimited
  protocolsArg: getArg('protocols', 'all'),                // all | bstpl | ais140 | concox
  // Realistic fleet mix: 50% BSTPL, 30% AIS140, 20% Concox
  split: (getArg('split', '0.5,0.3,0.2')).split(',').map(Number),
  ports: {
    BSTPL:  parseInt(process.env.TCP_PORT)        || 5000,
    AIS140: parseInt(process.env.AIS140_TCP_PORT) || 5001,
    CONCOX: parseInt(process.env.CONCOX_TCP_PORT) || 5002,
  },
};

const ACTIVE_PROTOCOLS = CONFIG.protocolsArg === 'all'
  ? ['BSTPL', 'AIS140', 'CONCOX']
  : [CONFIG.protocolsArg.toUpperCase()];

// -------------------- Metrics --------------------
const metrics = {
  startTime: Date.now(),
  // Per-protocol
  byProtocol: {},
  // Per-device send latency
  sendLatencyMs: [],   // rolling window of last 1000 sends
};

// Initialize per-protocol metric buckets
for (const proto of ACTIVE_PROTOCOLS) {
  metrics.byProtocol[proto] = {
    active: 0,
    connectAttempts: 0,
    connectFailures: 0,
    packetsSent: 0,
    packetsFailed: 0,
    reconnects: 0,
    bytesIn: 0,
  };
}

// -------------------- Device generation --------------------
// Generate a deterministic IMEI pool of size N. We use a deterministic
// generator so re-runs produce the same IMEIs (useful for comparing
// runs). Format: 15 digits, prefix that looks like a real TAC.
function generateImei(index) {
  // TAC range: 8650060 (BSTPL-style), 8699 (AIS140), 3590 (Concox)
  const tacPrefix = ['8650060', '8699990', '3590000'][index % 3];
  const serial = String(1000000000 + index).padStart(9, '0');
  const imei14 = tacPrefix + serial;
  // Luhn checksum digit
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = parseInt(imei14[13 - i]);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  const checkDigit = (10 - (sum % 10)) % 10;
  return imei14 + checkDigit;
}

// -------------------- Packet builders --------------------
// Reuse the real parser's expectations. Lat/Lng near a real Indian
// metro (Hyderabad) so the gps_points rows look realistic.

const BASE_LAT = 17.3850;
const BASE_LNG = 78.4867;

function jitterLatLng() {
  return {
    lat: BASE_LAT + (Math.random() - 0.5) * 0.1,
    lng: BASE_LNG + (Math.random() - 0.5) * 0.1,
  };
}

function ddmFromDecimal(decimal) {
  const abs = Math.abs(decimal);
  const deg = Math.floor(abs);
  const min = (abs - deg) * 60;
  return `${String(deg).padStart(2, '0')}${min.toFixed(4).padStart(7, '0')}`;
}

function ddmDir(decimal, isLng) {
  if (isLng) return decimal >= 0 ? 'E' : 'W';
  return decimal >= 0 ? 'N' : 'S';
}

function nowDdm() {
  const d = new Date();
  const date = `${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCFullYear()).slice(-2)}`;
  const time = `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}`;
  return { date, time };
}

function makeBstplPacket(imei) {
  const { lat, lng } = jitterLatLng();
  const { date, time } = nowDdm();
  const speed = Math.floor(Math.random() * 80);
  const odo = 10000 + Math.floor(Math.random() * 50000);
  const dir = Math.floor(Math.random() * 360);
  const sats = 8 + Math.floor(Math.random() * 5);
  const gsm = 18 + Math.floor(Math.random() * 7);
  const batt = 70 + Math.floor(Math.random() * 25);
  const ign = Math.random() > 0.4 ? 1 : 0;
  const fuel = (40 + Math.random() * 30).toFixed(2);
  const volt = (12.5 + Math.random() * 2).toFixed(2);
  return `$10,${imei},A,${date},${time},${ddmFromDecimal(lat)},${ddmDir(lat, false)},${ddmFromDecimal(lng)},${ddmDir(lng, true)},${speed},${odo},${dir},${sats},${gsm},${batt},${ign},0,0,1234,${fuel},${volt},L#`;
}

function makeAis140Packet(imei) {
  const { lat, lng } = jitterLatLng();
  const { date, time } = nowDdm();
  const speed = Math.floor(Math.random() * 80);
  const dir = Math.floor(Math.random() * 360);
  const sats = 8 + Math.floor(Math.random() * 5);
  // AIS140 uses $NRM header
  return `$NRM,${imei},A,${date},${time},${ddmFromDecimal(lat)},${ddmDir(lat, false)},${ddmFromDecimal(lng)},${ddmDir(lng, true)},${speed},${dir},${sats}*`;
}

// Concox 0x22 location packet builder.
// Frame: [0x78 0x79] [len_hi len_lo] [0x22] [info...] [serial_hi serial_lo] [crc_hi crc_lo] [0x0D 0x0A]
function makeConcoxFrame(imei, serial) {
  const { lat, lng } = jitterLatLng();
  // 4 bytes lat: decimal degrees * 1800000
  const latInt = Math.round(lat * 1800000);
  const lngInt = Math.round(lng * 1800000);
  const speed = Math.floor(Math.random() * 80);
  // Course
  const course = Math.floor(Math.random() * 360);

  // Info content: datetime(6) + lat(4) + lng(4) + speed(1) + course(2) = 17 bytes
  const d = new Date();
  const yr = d.getUTCFullYear() - 2000;
  const mo = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const hr = d.getUTCHours();
  const mi = d.getUTCMinutes();
  const se = d.getUTCSeconds();

  const info = Buffer.alloc(17);
  info[0] = yr; info[1] = mo; info[2] = day; info[3] = hr; info[4] = mi; info[5] = se;
  // lat
  info.writeUInt32BE(latInt, 6);
  // lng
  info.writeUInt32BE(lngInt, 10);
  info[14] = speed;
  info.writeUInt16BE(course, 15);

  // Total frame: start(2) + length(2) + protocol(1) + info(17) + serial(2) + crc(2) + stop(2) = 26 bytes
  const length = info.length + 5; // protocol + serial + crc
  const frame = Buffer.alloc(26);
  frame[0] = 0x78;
  frame[1] = 0x79;
  frame[2] = (length >> 8) & 0xff;
  frame[3] = length & 0xff;
  frame[4] = 0x22; // location packet
  info.copy(frame, 5);
  // serial
  frame.writeUInt16BE(serial & 0xffff, 22);
  // crc over [length bytes through serial]
  const crc = crcItu(frame.slice(2, 24));
  frame.writeUInt16BE(crc, 24);
  // stop bytes
  frame[24] = 0x0d;
  frame[25] = 0x0a;
  return frame;
}

// -------------------- Device worker --------------------
function makeDeviceWorker(protocol, deviceIndex) {
  const imei = generateImei(deviceIndex);
  const port = CONFIG.ports[protocol];
  let socket = null;
  let serial = 0;
  let stopFlag = false;
  let reconnectDelay = 1000;
  let lastPacketAt = 0;
  let packetInterval = null;

  function connect() {
    if (stopFlag) return;
    metrics.byProtocol[protocol].connectAttempts++;
    const s = net.createConnection({ host: CONFIG.host, port, localAddress: undefined });
    socket = s;

    s.on('connect', () => {
      metrics.byProtocol[protocol].active++;
      reconnectDelay = 1000;
      // Send first packet right away so the server processes it.
      sendOne();
      // Schedule subsequent packets.
      const intervalMs = (1 / CONFIG.packetRate) * 1000 * (0.7 + Math.random() * 0.6);
      packetInterval = setInterval(sendOne, intervalMs);
    });
    s.on('data', (buf) => {
      // Track bytes received but don't parse — that's the server's job.
      metrics.byProtocol[protocol].bytesIn += buf.length;
    });
    s.on('error', () => {
      metrics.byProtocol[protocol].connectFailures++;
    });
    s.on('close', () => {
      metrics.byProtocol[protocol].active = Math.max(0, metrics.byProtocol[protocol].active - 1);
      if (packetInterval) { clearInterval(packetInterval); packetInterval = null; }
      if (!stopFlag) {
        // Reconnect with exponential backoff up to 30s.
        metrics.byProtocol[protocol].reconnects++;
        setTimeout(connect, reconnectDelay);
        reconnectDelay = Math.min(30000, reconnectDelay * 1.5);
      }
    });
  }

  function sendOne() {
    if (!socket || socket.destroyed) return;
    const sendStart = Date.now();
    let packet;
    try {
      if (protocol === 'BSTPL') {
        packet = makeBstplPacket(imei);
      } else if (protocol === 'AIS140') {
        packet = makeAis140Packet(imei);
      } else if (protocol === 'CONCOX') {
        packet = makeConcoxFrame(imei, serial++);
      }
      const ok = socket.write(packet);
      if (ok) {
        metrics.byProtocol[protocol].packetsSent++;
        lastPacketAt = Date.now();
        // Record send latency (just socket.write synchronous path).
        metrics.sendLatencyMs.push(Date.now() - sendStart);
        if (metrics.sendLatencyMs.length > 1000) metrics.sendLatencyMs.shift();
      } else {
        metrics.byProtocol[protocol].packetsFailed++;
      }
    } catch (err) {
      metrics.byProtocol[protocol].packetsFailed++;
    }
  }

  function stop() {
    stopFlag = true;
    if (packetInterval) clearInterval(packetInterval);
    if (socket && !socket.destroyed) socket.destroy();
  }

  return { start: connect, stop, protocol, imei, deviceIndex };
}

// -------------------- Distribution --------------------
// Split devices across ACTIVE_PROTOCOLS (which honors --protocols).
function distributeDevices(total) {
  const splitIdx = { BSTPL: 0, AIS140: 1, CONCOX: 2 };
  const activeIdx = ACTIVE_PROTOCOLS.map((p) => splitIdx[p]);
  const weights = activeIdx.map((i) => CONFIG.split[i] || 0);
  const sum = weights.reduce((s, w) => s + w, 0) || 1;
  const counts = {};
  let allocated = 0;
  for (let i = 0; i < ACTIVE_PROTOCOLS.length - 1; i++) {
    const n = Math.floor(total * weights[i] / sum);
    counts[ACTIVE_PROTOCOLS[i]] = n;
    allocated += n;
  }
  // Remaining to last protocol to ensure total is exact.
  counts[ACTIVE_PROTOCOLS[ACTIVE_PROTOCOLS.length - 1]] = total - allocated;
  return counts;
}

// -------------------- Ramp --------------------
async function rampUp(workers) {
  const targetPerProtocol = distributeDevices(CONFIG.devices);
  let started = 0;

  const distStr = ACTIVE_PROTOCOLS.map((p) => `${p}:${targetPerProtocol[p]}`).join(', ');
  console.log(`[STRESS] Ramping to ${CONFIG.devices} devices (${distStr})`);
  console.log(`[STRESS] Step: +${CONFIG.rampStep} devices every ${CONFIG.rampIntervalMs}ms, packet rate ${CONFIG.packetRate}/s per device`);

  const perProtocolRemaining = { ...targetPerProtocol };
  for (const proto of ACTIVE_PROTOCOLS) perProtocolRemaining[proto] = targetPerProtocol[proto] || 0;

  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (started >= CONFIG.devices) {
        clearInterval(interval);
        resolve();
        return;
      }
      // Pick the protocol with the largest remaining count
      let pickProto = null;
      let pickRemaining = -1;
      for (const proto of ACTIVE_PROTOCOLS) {
        if (perProtocolRemaining[proto] > pickRemaining) {
          pickProto = proto;
          pickRemaining = perProtocolRemaining[proto];
        }
      }
      if (!pickProto) {
        clearInterval(interval);
        resolve();
        return;
      }
      const worker = makeDeviceWorker(pickProto, started);
      workers.push(worker);
      worker.start();
      perProtocolRemaining[pickProto]--;
      started++;
      if (started % 1000 === 0 || started === CONFIG.devices) {
        console.log(`[STRESS] Started ${started}/${CONFIG.devices} devices...`);
      }
    }, CONFIG.rampIntervalMs);
  });
}

// -------------------- Reporting --------------------
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function reportLoop(workers) {
  let lastReportAt = Date.now();
  let lastReportPackets = {};
  for (const proto of ACTIVE_PROTOCOLS) lastReportPackets[proto] = 0;

  return setInterval(() => {
    const now = Date.now();
    const dt = (now - lastReportAt) / 1000;
    console.log(`\n[STRESS] ===== ${new Date().toISOString()} ===== (t+${Math.round((now - metrics.startTime) / 1000)}s)`);
    console.log(`[STRESS] Workers: ${workers.length} | packet rate target: ${(CONFIG.packetRate * 1000).toFixed(0)}/s/device`);
    let totalActive = 0, totalPps = 0;
    for (const proto of ACTIVE_PROTOCOLS) {
      const m = metrics.byProtocol[proto];
      const pps = (m.packetsSent - lastReportPackets[proto]) / dt;
      lastReportPackets[proto] = m.packetsSent;
      totalActive += m.active;
      totalPps += pps;
      console.log(
        `[STRESS]   ${proto.padEnd(7)} active=${m.active}  ` +
        `pps=${pps.toFixed(0)}  ` +
        `sent=${m.packetsSent}  ` +
        `failed=${m.packetsFailed}  ` +
        `reconnects=${m.reconnects}  ` +
        `bytes_in=${m.bytesIn}`
      );
    }
    console.log(`[STRESS]   TOTAL active=${totalActive} pps=${totalPps.toFixed(0)}`);
    const sendP50 = percentile(metrics.sendLatencyMs, 50);
    const sendP95 = percentile(metrics.sendLatencyMs, 95);
    const sendP99 = percentile(metrics.sendLatencyMs, 99);
    console.log(`[STRESS]   local send latency p50=${sendP50}ms p95=${sendP95}ms p99=${sendP99}ms`);
    lastReportAt = now;
  }, 5000);
}

// -------------------- Duration enforcement --------------------
function durationLoop(workers) {
  if (CONFIG.durationSec <= 0) return null;
  return setTimeout(() => {
    console.log(`[STRESS] Duration ${CONFIG.durationSec}s reached — stopping.`);
    shutdown(workers);
  }, CONFIG.durationSec * 1000);
}

// -------------------- Shutdown --------------------
let shuttingDown = false;
function shutdown(workers) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[STRESS] Shutting down ${workers.length} workers...`);
  for (const w of workers) w.stop();
  setTimeout(() => {
    console.log(`[STRESS] Final stats:`);
    for (const proto of ACTIVE_PROTOCOLS) {
      const m = metrics.byProtocol[proto];
      console.log(`  ${proto}: sent=${m.packetsSent} failed=${m.packetsFailed} reconnects=${m.reconnects} bytes_in=${m.bytesIn}`);
    }
    process.exit(0);
  }, 2000);
}

// Module-level workers registry so signal handlers can access it.
let workers = [];

process.on('SIGINT', () => shutdown(workers));
process.on('SIGTERM', () => shutdown(workers));

// -------------------- Main --------------------
(async () => {
  console.log(`[STRESS] === FuelTracks stress test ===`);
  console.log(`[STRESS] host=${CONFIG.host} devices=${CONFIG.devices} packetRate=${CONFIG.packetRate}/s protocols=${ACTIVE_PROTOCOLS.join(',')}`);
  console.log(`[STRESS] rampStep=${CONFIG.rampStep} rampInterval=${CONFIG.rampIntervalMs}ms duration=${CONFIG.durationSec || 'unlimited'}s`);
  workers = [];   // module-level, so signal handlers see it
  reportLoop(workers);
  durationLoop(workers);
  await rampUp(workers);
  console.log(`[STRESS] Ramp complete — ${workers.length} workers active. Sustaining for ${CONFIG.durationSec > 0 ? CONFIG.durationSec + 's' : 'indefinitely'}.`);
  console.log(`[STRESS] Ctrl-C to stop.`);
})();
