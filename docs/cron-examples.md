# Cron / Launchd / Systemd Examples

Run Prism unattended on a schedule.

## Cron (Linux/macOS)

### Every 10 minutes (default scan interval)

```bash
# Edit crontab
crontab -e

# Add line:
*/10 * * * * cd /path/to/prism-liquidity-agent && bun run dev >> /var/log/prism.log 2>&1
```

### Every hour (conservative)

```bash
0 * * * * cd /path/to/prism-liquidity-agent && bun run dev >> /var/log/prism.log 2>&1
```

### With log rotation

```bash
# Use logrotate for /var/log/prism.log
# /etc/logrotate.d/prism
/var/log/prism.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## Launchd (macOS)

Create `~/Library/LaunchAgents/com.prism.dlmm.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.prism.dlmm</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/bun</string>
        <string>run</string>
        <string>dev</string>
    </array>
    <key>WorkingDirectory</key>
    <string>/path/to/prism-liquidity-agent</string>
    <key>StartInterval</key>
    <integer>600</integer>
    <key>StandardOutPath</key>
    <string>/var/log/prism.log</string>
    <key>StandardErrorPath</key>
    <string>/var/log/prism.error.log</string>
</dict>
</plist>
```

Load and start:

```bash
launchctl load ~/Library/LaunchAgents/com.prism.dlmm.plist
launchctl start com.prism.dlmm
```

## Systemd (Linux)

Create `/etc/systemd/system/prism-liquidity-agent.service`:

```ini
[Unit]
Description=Prism DLMM Trading Agent
After=network.target

[Service]
Type=simple
User=prism
WorkingDirectory=/path/to/prism-liquidity-agent
ExecStart=/usr/local/bin/bun run dev
Restart=always
RestartSec=600
StandardOutput=append:/var/log/prism.log
StandardError=append:/var/log/prism.error.log

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable prism-liquidity-agent
sudo systemctl start prism-liquidity-agent
```

## Docker (Optional)

```dockerfile
FROM oven/bun:1.2
WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "run", "dev"]
```

```bash
docker build -t prism-liquidity-agent .
docker run -d --env-file .env -v $(pwd)/prism.db:/app/prism.db prism-liquidity-agent
```

## Monitoring

Check if the agent is running:

```bash
# Cron
ps aux | grep "bun run dev"

# Launchd
launchctl list | grep com.prism.dlmm

# Systemd
sudo systemctl status prism-liquidity-agent
```
