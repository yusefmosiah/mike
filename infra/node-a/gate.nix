# A shared password in front of the whole staging site (owner, 2026-10-10).
#
# Caddy asks the gate (./gate/gate.py, on 127.0.0.1:9180) before every
# request; a browser that has entered the password once carries a signed
# cookie for a year. Five wrong passwords from one address within an hour
# block it from ports 80 and 443 for a day (fail2ban). SSH is never banned:
# the jail covers the web ports only, and the default sshd jail is off, so a
# key mix-up can never lock the owner out.
#
# The password is a root-only file the operator writes:
#   install -d -m 700 /var/lib/mike-gate-secret
#   printf '%s' '<password>' > /var/lib/mike-gate-secret/password; chmod 600 it
{ config, lib, pkgs, ... }:

let
  port = 9180;
  # Loopback only. node-a's own requests to its public URL arrive from an
  # internal container address, and trusting those would let a container or
  # VM skip the gate; its health check probes paths that need no password.
  trusted = [ "127.0.0.1" "::1" ];
in
{
  systemd.services.mike-gate = {
    description = "Shared-password gate for the staging site";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    environment = {
      GATE_PORT = toString port;
      GATE_TRUSTED_IPS = lib.concatStringsSep "," trusted;
    };
    serviceConfig = {
      ExecStart = "${pkgs.python3}/bin/python3 -I ${./gate/gate.py}";
      DynamicUser = true;
      StateDirectory = "mike-gate";
      LoadCredential = "password:/var/lib/mike-gate-secret/password";
      Restart = "always";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
    };
  };

  systemd.tmpfiles.rules = [ "d /var/lib/mike-gate-secret 0700 root root -" ];

  environment.etc."fail2ban/filter.d/mike-gate.conf".text = ''
    [Definition]
    failregex = ^gate: wrong password from <HOST>$
    ignoreregex =
  '';

  services.fail2ban = {
    enable = true;
    # Only the web ports, and never the owner's way in.
    jails.sshd.settings.enabled = false;
    jails.mike-gate.settings = {
      enabled = true;
      filter = "mike-gate";
      backend = "systemd";
      journalmatch = "_SYSTEMD_UNIT=mike-gate.service";
      port = "http,https";
      maxretry = 5;
      findtime = "1h";
      bantime = "1d";
    };
    ignoreIP = trusted;
  };
}
