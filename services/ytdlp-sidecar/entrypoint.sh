#!/bin/sh
# Start the WARP SOCKS5 tunnel when a WireGuard profile is baked in, then serve.
# wireproxy is userspace (gVisor netstack) — no TUN device or capabilities needed.
if [ -s /app/wgcf-profile.conf ]; then
  wireproxy -c /app/wgcf-profile.conf &
fi
exec uvicorn app:app --host 0.0.0.0 --port 8080
