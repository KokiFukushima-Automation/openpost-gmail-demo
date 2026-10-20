# systemd packaging

Four commands to install openpost as a systemd service on a Debian/Ubuntu host with Node 22
already installed:

```sh
sudo useradd --system --home /var/lib/openpost --create-home openpost
sudo mkdir -p /opt/openpost /etc/openpost
sudo cp -r dist node_modules package.json /opt/openpost/
sudo install -m 600 -o openpost -g openpost packaging/openpost.env.example /etc/openpost/openpost.env
sudo install -m 644 packaging/openpost.service /etc/systemd/system/openpost.service
sudo systemctl daemon-reload
sudo systemctl enable --now openpost
```

Edit `/etc/openpost/openpost.env` before starting (`TRACKING_SECRET`, `FROM_EMAIL`, transport
credentials, `DASHBOARD_PASSWORD`). `UMask=0077` in the unit keeps the SQLite file and the master
keyfile private by default; the hardening directives (`ProtectSystem=strict`,
`RestrictAddressFamilies`, `NoNewPrivileges`, etc.) confine the process to
`/var/lib/openpost` and the network.

Check status and logs with `systemctl status openpost` and `journalctl -u openpost -f`.
