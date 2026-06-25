#!/bin/bash
# ============================================================
# FuelTracks — Server Hardening Script
# Phase 5 of SCALING_ROADMAP.md
#
# Run once per EC2 instance (idempotent). Sets the OS-level
# limits and network tuning required for 10K+ concurrent
# device TCP connections.
#
# What this fixes:
#   - File descriptor ceiling (default 1024 is FAR too low)
#   - SYN backlog (default 4096 will saturate during
#     regional cellular reconnect storms)
#   - MSS clamp persistence — without this, the MSS=8961
#     fix from the field test is LOST on every reboot/redeploy
#     and silently breaks every Concox device handshake
#   - tcp_mtu_probing as a belt-and-braces backup for MSS
#
# Run:
#   sudo bash deploy/setup-server.sh
# ============================================================

set -e

echo "[SETUP] Applying FuelTracks server hardening..."

# ----- 1. File descriptor limit -----
# PM2 systemd unit and limits.conf both need this. 65535 is
# enough for 30K sockets + Postgres pool + Redis connections +
# PM2 internals.
LIMITS_FILE="/etc/security/limits.conf"
LIMITS_LINE="* soft nofile 65535"
LIMITS_LINE2="* hard nofile 65535"

if ! grep -qF "$LIMITS_LINE" "$LIMITS_FILE"; then
  echo "[SETUP] Adding fd limits to $LIMITS_FILE"
  echo "$LIMITS_LINE" >> "$LIMITS_FILE"
  echo "$LIMITS_LINE2" >> "$LIMITS_FILE"
else
  echo "[SETUP] fd limits already in $LIMITS_FILE"
fi

# ----- 2. Sysctl network tuning -----
SYSCTL_FILE="/etc/sysctl.d/99-fueltracks.conf"
cat > "$SYSCTL_FILE" <<'EOF'
# FuelTracks network tuning (Phase 5)

# SYN backlog — raise from default 4096 to absorb regional
# cellular reconnect storms (10K+ devices reconnecting in
# a 30-second window after a tower handoff).
net.core.somaxconn = 16384
net.ipv4.tcp_max_syn_backlog = 16384

# Accept connections faster under burst load.
net.ipv4.tcp_abort_on_overflow = 0
net.ipv4.tcp_tw_reuse = 1

# MSS auto-probing — this is the KEY fix for the MSS=8961
# bug found in the field test. With this set, the kernel
# probes the path MTU itself and clamps MSS automatically,
# so we don't need iptables at all. Belt-and-braces: we
# still apply the iptables rule below for paranoia.
net.ipv4.tcp_mtu_probing = 1
net.ipv4.tcp_no_metrics_save = 1

# Buffer sizes for high-throughput sockets.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 87380 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216

# Keepalive defaults for cellular clients (devices often
# NAT through carrier-grade NAT with short timeouts).
net.ipv4.tcp_keepalive_time = 60
net.ipv4.tcp_keepalive_intvl = 10
net.ipv4.tcp_keepalive_probes = 6
EOF

echo "[SETUP] Loading $SYSCTL_FILE"
sysctl -p "$SYSCTL_FILE" || echo "[SETUP] (some sysctls may require reboot)"

# ----- 3. Persistent iptables MSS clamp -----
# Belt-and-braces backup to tcp_mtu_probing. Without this,
# on kernels where tcp_mtu_probing is disabled (e.g. some
# AMIs), Concox devices with MSS=8961 will fail handshake.
MSS_RULE="iptables -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu"

# Install iptables-persistent if not already
if ! dpkg -l iptables-persistent >/dev/null 2>&1 && \
   ! rpm -q iptables-services >/dev/null 2>&1; then
  echo "[SETUP] Installing iptables-persistent..."
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
  elif command -v yum >/dev/null 2>&1; then
    yum install -y iptables-services
    systemctl enable iptables
  fi
fi

# Apply rule (idempotent — check first)
if ! iptables -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
  echo "[SETUP] Applying MSS clamp rule"
  iptables -A FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
else
  echo "[SETUP] MSS clamp rule already present"
fi

# Same for OUTPUT (locally-originated connections)
if ! iptables -C OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu 2>/dev/null; then
  iptables -A OUTPUT -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu
fi

# Persist the rules across reboots.
if command -v netfilter-persistent >/dev/null 2>&1; then
  echo "[SETUP] Saving iptables rules via netfilter-persistent"
  netfilter-persistent save
elif command -v iptables-save >/dev/null 2>&1; then
  echo "[SETUP] Saving iptables rules via iptables-save"
  iptables-save > /etc/iptables/rules.v4 2>/dev/null || \
    mkdir -p /etc/iptables && iptables-save > /etc/iptables/rules.v4
fi

# ----- 4. Verify and report -----
echo ""
echo "[SETUP] ============== VERIFICATION =============="
echo "fd limit (ulimit -n):"
ulimit -n
echo ""
echo "SYN backlog (sysctl):"
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_max_syn_backlog
echo ""
echo "MTU probing:"
sysctl net.ipv4.tcp_mtu_probing
echo ""
echo "MSS clamp rule:"
iptables -C FORWARD -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu && echo "  FORWARD: present" || echo "  FORWARD: MISSING"
iptables -C OUTPUT  -p tcp --tcp-flags SYN,RST SYN -j TCPMSS --clamp-mss-to-pmtu && echo "  OUTPUT:  present" || echo "  OUTPUT:  MISSING"
echo ""
echo "[SETUP] Done. Run 'pm2 restart all' to pick up the new fd limits."
