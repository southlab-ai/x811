# x811 Production Deployment Runbook

Step-by-step guide to deploy the x811 Protocol server to production at `api.x811.org`.

**Target infrastructure:** Hostinger KVM 2 VPS, Ubuntu 22.04, Docker + Dokploy

---

## 1. VPS Provisioning

1. Order Hostinger KVM 2: 2 vCPU, 4 GB RAM, 80 GB NVMe SSD (~$12/month)
2. Select Ubuntu 22.04 LTS as the operating system
3. During setup, add your SSH public key for root access
4. Note the VPS public IP address (referred to as `VPS_IP` below)

## 2. SSH Hardening

Connect to the VPS and secure SSH:

```bash
ssh root@VPS_IP

# Create a non-root user
adduser deploy
usermod -aG sudo deploy

# Copy SSH key to new user
mkdir -p /home/deploy/.ssh
cp ~/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Harden SSH config by editing `/etc/ssh/sshd_config`:

```
PermitRootLogin no
PasswordAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
```

```bash
systemctl restart sshd
```

**IMPORTANT:** Test login as the deploy user before logging out of root!
From another terminal:

```bash
ssh deploy@VPS_IP
```

## 3. Firewall Configuration

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (Let's Encrypt + redirect)
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable

# Verify
sudo ufw status verbose
```

## 4. fail2ban

```bash
sudo apt update && sudo apt install -y fail2ban

# Create local config
sudo cp /etc/fail2ban/jail.conf /etc/fail2ban/jail.local
```

Edit `/etc/fail2ban/jail.local`, in the `[sshd]` section:

```
enabled = true
port = ssh
filter = sshd
logpath = /var/log/auth.log
maxretry = 5
bantime = 600
```

```bash
sudo systemctl enable fail2ban
sudo systemctl start fail2ban
```

## 5. Automatic Security Updates

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
# Select "Yes" to enable automatic updates
```

## 6. Docker + Dokploy Installation

```bash
# Install Dokploy (installs Docker + Traefik automatically)
curl -sSL https://dokploy.com/install.sh | sh

# Verify Docker is running
docker version
docker compose version

# Verify Traefik is running
docker ps | grep traefik

# Access Dokploy UI at http://VPS_IP:3000 (initial setup)
# Create admin account, then close port 3000 if desired
```

## 7. DNS Configuration

In Cloudflare dashboard for x811.org:

1. Go to DNS > Records
2. Add record:
   - Type: A
   - Name: api
   - Content: VPS_IP
   - Proxy status: DNS only (orange cloud OFF)
   - TTL: Auto

**IMPORTANT:** DNS-only mode (orange cloud OFF) is required.
Cloudflare proxy buffers SSE streams which breaks real-time message delivery.

```bash
# Verify DNS resolution
dig api.x811.org
# Should return VPS_IP, NOT Cloudflare proxy IPs (104.x.x.x)
```

## 8. SSL/TLS via Let's Encrypt

Traefik (installed by Dokploy) handles SSL automatically via ACME.

The `docker-compose.yml` includes Traefik labels:
- `traefik.http.routers.x811.tls.certresolver=letsencrypt`
- Traefik requests and auto-renews certificates from Let's Encrypt

```bash
# Verify after deployment:
curl -I https://api.x811.org
# Should show: HTTP/2 200, valid Let's Encrypt certificate
```

## 9. Environment Variables

Set these in Dokploy's encrypted environment (Project > Environment):

| Variable | Value | Notes |
|----------|-------|-------|
| `NODE_ENV` | `production` | |
| `PORT` | `3811` | |
| `DATABASE_URL` | `/data/x811.db` | Inside Docker volume |
| `LOG_LEVEL` | `info` | |
| `BASE_RPC_URL` | `https://mainnet.base.org` | Base L2 RPC |
| `CONTRACT_ADDRESS` | (empty) | Set in Phase 2 after contract deployment |
| `RELAYER_PRIVATE_KEY` | (empty) | Set in Phase 2 after wallet setup |
| `SERVER_DOMAIN` | `api.x811.org` | Used in DID documents |
| `DID_DOMAIN` | `x811.org` | Used in DID resolution |

**SECURITY:** Never put `RELAYER_PRIVATE_KEY` in `docker-compose.yml` or any file committed to git.
When `RELAYER_PRIVATE_KEY` is empty, the server uses `MockRelayerService` (safe for initial deployment).

## 10. Deploy the Application

### Option A: Via Dokploy Git integration

In Dokploy UI: Create Project > Add Service > GitHub repo > Configure build.

### Option B: Manual deployment on VPS

```bash
cd /opt
git clone https://github.com/YOUR_ORG/x811-mvp.git x811
cd x811
docker compose up -d --build

# Verify container is running
docker ps
docker logs x811-server --tail 20

# Verify health endpoint
curl https://api.x811.org/health
# Expected: {"status":"ok"}
```

## 11. Database Persistence

The `docker-compose.yml` uses a named Docker volume:

```yaml
volumes:
  x811-data:
    driver: local
```

This volume persists at `/var/lib/docker/volumes/x811_x811-data/_data` on the host.
Data survives container rebuilds, restarts, and redeployments.

```bash
# Verify persistence:
# 1. Register a test agent via the API
# 2. Restart the container:
docker compose restart
# 3. Query the agent again — it should still exist
```

## 12. Backup Setup

```bash
# Copy backup script to VPS
sudo mkdir -p /opt/x811
sudo cp scripts/backup.sh /opt/x811/backup.sh
sudo chmod +x /opt/x811/backup.sh

# Test manual backup
sudo /opt/x811/backup.sh

# Add cron job for daily backup at 3 AM
sudo crontab -e
# Add line:
# 0 3 * * * /opt/x811/backup.sh >> /var/log/x811-backup.log 2>&1

# Verify cron is set
sudo crontab -l
```

## 13. SSE Verification

Test that Server-Sent Events work without buffering:

```bash
# Open a long-lived SSE connection (replace AGENT_ID with a registered agent)
curl -N https://api.x811.org/api/v1/messages/AGENT_ID/stream \
  -H "Authorization: DID-Signature BASE64_AUTH_TOKEN"

# In another terminal, send a message to that agent
# The SSE connection should receive the event immediately (< 1 second)

# Verify Traefik is not buffering:
curl -I https://api.x811.org/health
# Check for: X-Accel-Buffering: no
```

## 14. Smoke Test Checklist

Run through this checklist after deployment:

- [ ] `curl https://api.x811.org/health` returns `{"status":"ok"}`
- [ ] `curl -I https://api.x811.org` shows valid Let's Encrypt cert
- [ ] `dig api.x811.org` resolves to VPS IP (not Cloudflare proxy)
- [ ] Only ports 22, 80, 443 are open externally
- [ ] SSH with password fails (key-only)
- [ ] SSH as root fails (PermitRootLogin no)
- [ ] Container auto-restarts after `docker kill x811-server`
- [ ] Agent data persists after `docker compose restart`
- [ ] SSE events delivered in real-time (no buffering)
- [ ] fail2ban is active: `sudo fail2ban-client status sshd`
- [ ] Automatic updates configured: `apt-config dump | grep Unattended`
- [ ] Backup script runs successfully: `sudo /opt/x811/backup.sh`
