# Choir off-host backup target for node-a (a stopgap, owner ruling 2026-10-14).
#
# SELF-CONTAINED NixOS module for node-a's own administrators. Choir does not
# deploy it and never touches node-a; the other project's agent imports it:
#
#   imports = [ ./node-a-choir-backup-target.nix ];
#   services.choirBackupTarget = {
#     enable = true;
#     nodeBPublicKeys = [ "ssh-ed25519 AAAA... node-b-offhost-backup" ];
#   };
#
# What it creates: a quota-limited btrfs subvolume, one append-only restic
# rest-server on loopback, one restricted SSH user that can only forward a
# TCP connection to that server, and a resource slice. What it never does:
# see a decryption key (Node B holds the restic password; it never arrives
# here), listen on a public address, open a firewall port, touch your other
# services, or give Choir a shell.
#
# Everything stored here is restic ciphertext. You have root and can read,
# delete or corrupt it; you cannot decrypt it. Handover note, verification
# commands and the removal procedure:
#   docs/reports/node-a-backup-handover-2026-10-20.md
# Design: docs/problems/no-off-host-backup-2026-10-20.md
{ config, lib, pkgs, ... }:
let
  cfg = config.services.choirBackupTarget;
  inherit (lib) mkEnableOption mkIf mkOption types optionalString concatStringsSep;

  user = "choir-backup";
  pruneUser = "choir-backup-prune";
  slice = "choir-backup";

  # The key may be used only from Node B, only to forward to one loopback
  # port, and never to run anything.
  fromOpt = optionalString (cfg.allowedFrom != [ ])
    ''from="${concatStringsSep "," cfg.allowedFrom}",'';
  keyOptions = withFrom: port: key:
    ''${optionalString withFrom fromOpt}restrict,port-forwarding,permitopen="127.0.0.1:${toString port}",command="${pkgs.coreutils}/bin/false" ${key}'';

  maxSizeBytes = cfg.quotaGiB * 1073741824 * 95 / 100;

  restServerCommon = ''${pkgs.restic-rest-server}/bin/rest-server --path ${cfg.dataDir} --private-repos --log -'';

  hardening = {
    User = user;
    Group = user;
    Slice = "${slice}.slice";
    ReadWritePaths = [ cfg.dataDir ];
    ProtectSystem = "strict";
    ProtectHome = true;
    PrivateTmp = true;
    PrivateDevices = true;
    NoNewPrivileges = true;
    ProtectKernelTunables = true;
    ProtectKernelModules = true;
    ProtectControlGroups = true;
    RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
    # Loopback only, whatever the service is told to bind.
    IPAddressDeny = "any";
    IPAddressAllow = "localhost";
    CapabilityBoundingSet = "";
    LockPersonality = true;
    MemoryDenyWriteExecute = true;
    RestrictRealtime = true;
    SystemCallArchitectures = "native";
  };
in
{
  options.services.choirBackupTarget = {
    enable = mkEnableOption "the Choir off-host backup target (append-only restic rest-server, ciphertext only)";

    dataDir = mkOption {
      type = types.path;
      default = "/data/choir-backup";
      description = ''
        Where the repositories live. Must be on btrfs. The module creates it
        as a btrfs subvolume (refusing if a plain directory already exists
        there) and limits it with a qgroup.
      '';
    };

    quotaGiB = mkOption {
      type = types.ints.positive;
      default = 450;
      description = ''
        Hard size limit for the subvolume, in GiB. The owner offered half to
        two thirds of the disk; the other project keeps the rest. The
        rest-server also refuses writes above 95% of this, so a full quota
        is an error to Choir's client, not a full disk for you.
      '';
    };

    enforceBtrfsQuota = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Enable btrfs quotas (qgroups) and set the limit. Qgroups have a
        known cost on very busy filesystems with many snapshots. If you
        object, set this to false: the application limit (95% of quotaGiB)
        still applies, but only the filesystem can enforce it against a bug.
      '';
    };

    nodeBPublicKeys = mkOption {
      type = types.listOf types.str;
      description = "SSH public keys of Choir's Node B backup client, one per line, as printed by its keygen. Required.";
      example = [ "ssh-ed25519 AAAA... node-b-offhost-backup" ];
    };

    allowedFrom = mkOption {
      type = types.listOf types.str;
      default = [ "147.135.70.196" ];
      description = "Source addresses the Node B key may log in from (OpenSSH from= list). Node B is 147.135.70.196. Empty disables the check.";
    };

    restUser = mkOption {
      type = types.str;
      default = "nodeb";
      description = "HTTP basic-auth user (and repository directory name) for the Node B client.";
    };

    htpasswdFile = mkOption {
      type = types.path;
      default = "/var/lib/choir-backup/htpasswd";
      description = ''
        An htpasswd file with one line, "<restUser>:<hash>", supplied by the
        Choir owner (the hash of a random password; the password stays on
        Node B). Create it by hand, root-owned, mode 0600; the module
        never writes it and never puts it in the Nix store.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 8000;
      description = "Loopback port of the append-only rest-server.";
    };

    prune = {
      keys = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          SSH public keys for the monthly, owner-supervised prune window. These
          are held by the owner, never by Node B's automatic jobs. Empty
          (the default) defines no prune server at all, so nothing can ever be
          deleted by Choir through this module.
        '';
      };
      port = mkOption { type = types.port; default = 8001; };
      htpasswdFile = mkOption {
        type = types.path;
        default = "/var/lib/choir-backup/htpasswd-prune";
        description = "Same format as htpasswdFile, a different password (the owner's delete credential).";
      };
      maxRuntime = mkOption {
        type = types.str;
        default = "2h";
        description = "The non-append-only server stops itself after this long.";
      };
    };

    memoryMax = mkOption { type = types.str; default = "2G"; };
    cpuQuota = mkOption { type = types.str; default = "100%"; description = "100% is one core."; };
    ioWeight = mkOption { type = types.ints.between 1 10000; default = 20; description = "Default weight is 100: this is low priority."; };
  };

  config = mkIf cfg.enable {
    assertions = [
      { assertion = config.services.openssh.enable; message = "choirBackupTarget reaches rest-server through sshd; services.openssh must be enabled."; }
      { assertion = cfg.nodeBPublicKeys != [ ]; message = "choirBackupTarget.nodeBPublicKeys must list Node B's backup key."; }
    ];

    users.groups.${user} = { };
    users.users.${user} = {
      isSystemUser = true;
      group = user;
      home = "/var/empty";
      shell = "${pkgs.shadow}/bin/nologin";
      description = "Choir off-host backup (forward to one loopback port only)";
      openssh.authorizedKeys.keys = map (keyOptions true cfg.port) cfg.nodeBPublicKeys;
    };
    users.users.${pruneUser} = mkIf (cfg.prune.keys != [ ]) {
      isSystemUser = true;
      group = user;
      home = "/var/empty";
      shell = "${pkgs.shadow}/bin/nologin";
      description = "Choir backup prune window (forward to the prune port only)";
      openssh.authorizedKeys.keys = map (keyOptions false cfg.prune.port) cfg.prune.keys;
    };

    # Belt and braces behind the per-key options. "Match all" ends our scope
    # so lines other modules add after ours are not captured by it.
    services.openssh.extraConfig = lib.mkAfter ''
      Match User ${user}
        AuthenticationMethods publickey
        AllowTcpForwarding local
        PermitOpen 127.0.0.1:${toString cfg.port}
        AllowAgentForwarding no
        X11Forwarding no
        PermitTTY no
        PermitTunnel no
        GatewayPorts no
        ForceCommand ${pkgs.coreutils}/bin/false
      ${optionalString (cfg.prune.keys != [ ]) ''
      Match User ${pruneUser}
        AuthenticationMethods publickey
        AllowTcpForwarding local
        PermitOpen 127.0.0.1:${toString cfg.prune.port}
        AllowAgentForwarding no
        X11Forwarding no
        PermitTTY no
        PermitTunnel no
        GatewayPorts no
        ForceCommand ${pkgs.coreutils}/bin/false
      ''}
      Match all
    '';

    # Home of the htpasswd files the Choir owner supplies. Root only.
    systemd.tmpfiles.rules = [ "d /var/lib/choir-backup 0700 root root -" ];

    systemd.slices.${slice} = {
      description = "Choir off-host backup target (capped; the other project comes first)";
      sliceConfig = {
        MemoryMax = cfg.memoryMax;
        CPUQuota = cfg.cpuQuota;
        IOWeight = cfg.ioWeight;
      };
    };

    # Creates the subvolume once and (re)applies the quota. Never deletes.
    systemd.services.choir-backup-subvolume = {
      description = "Choir backup subvolume and quota";
      wantedBy = [ "multi-user.target" ];
      path = [ pkgs.btrfs-progs pkgs.coreutils ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Slice = "${slice}.slice";
      };
      script = ''
        set -eu
        dir=${lib.escapeShellArg cfg.dataDir}
        if ! btrfs subvolume show "$dir" >/dev/null 2>&1; then
          if [ -e "$dir" ]; then
            echo "choir-backup: $dir exists and is not a btrfs subvolume; refusing to touch it" >&2
            exit 1
          fi
          btrfs subvolume create "$dir"
        fi
        chown ${user}:${user} "$dir"
        chmod 0700 "$dir"
        ${optionalString cfg.enforceBtrfsQuota ''
        btrfs quota enable "$dir" 2>/dev/null || true
        btrfs qgroup limit ${toString cfg.quotaGiB}G "$dir"
        ''}
        echo "choir-backup: $dir ready, quota ${toString cfg.quotaGiB} GiB (enforced by btrfs: ${if cfg.enforceBtrfsQuota then "yes" else "no"})"
      '';
    };

    # The only thing Node B's daily job can reach. Append-only: it can add
    # packs, indexes and snapshots; it cannot delete or overwrite them.
    systemd.services.choir-backup-rest = {
      description = "Choir append-only restic rest-server (loopback, ciphertext only)";
      wantedBy = [ "multi-user.target" ];
      after = [ "choir-backup-subvolume.service" ];
      requires = [ "choir-backup-subvolume.service" ];
      # Stays inactive (visible as "condition failed") until the owner's
      # htpasswd line has been placed; it never starts without authentication.
      unitConfig.ConditionPathExists = cfg.htpasswdFile;
      serviceConfig = hardening // {
        LoadCredential = [ "htpasswd:${cfg.htpasswdFile}" ];
        ExecStart = "${restServerCommon} --listen 127.0.0.1:${toString cfg.port} --append-only --max-size ${toString maxSizeBytes} --htpasswd-file %d/htpasswd";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };

    # NOT started by default and not wanted by anything. Present only when a
    # prune key exists. Started on the owner's request for a monthly window,
    # stops itself, and is the only path through which backups can be deleted.
    systemd.services.choir-backup-rest-prune = mkIf (cfg.prune.keys != [ ]) {
      description = "Choir restic rest-server, delete allowed (owner-supervised window)";
      after = [ "choir-backup-subvolume.service" ];
      requires = [ "choir-backup-subvolume.service" ];
      unitConfig.ConditionPathExists = cfg.prune.htpasswdFile;
      serviceConfig = hardening // {
        LoadCredential = [ "htpasswd:${cfg.prune.htpasswdFile}" ];
        ExecStart = "${restServerCommon} --listen 127.0.0.1:${toString cfg.prune.port} --htpasswd-file %d/htpasswd";
        RuntimeMaxSec = cfg.prune.maxRuntime;
      };
    };
  };
}
