# node-a: shared NixOS host. Choir's Node B uses it as a Nix remote builder
# (./choir-builder.nix, keep verbatim); the rest is Mike's staging and
# workstation-VM host (goals/mission-13-workstation-vms.md). Rules from
# /root/HANDOFF.md: root key-only ssh on 22, Nix enabled, the store is shared
# (GC is fine), `nixos-rebuild test` and a fresh ssh login before `switch`.
{ pkgs, ... }:
{
  imports = [
    ./hardware.nix
    ./disks.nix
    ./choir-builder.nix
    ./workstations.nix
    ./vault.nix
    ./staging.nix
    ./gate.nix
    # Choir off-host backup target (Choir owner, 2026-10-20; handover:
    # go-choir docs/reports/node-a-backup-handover-2026-10-20.md). Ciphertext
    # only; loopback rest-server reached through a restricted ssh forward.
    ./choir-backup-target.nix
    # A scratch VM where Claude Code works on go-choir (owner, 2026-10-21).
    ./choir-agents.nix
  ];

  boot.loader.efi.canTouchEfiVariables = true;
  boot.loader.efi.efiSysMountPoint = "/boot/efi";
  boot.loader.grub = {
    enable = true;
    efiSupport = true;
    devices = [ "nodev" ];
  };

  networking.hostName = "node-a";
  networking.useDHCP = true;
  networking.firewall = {
    enable = true;
    allowedTCPPorts = [ 22 ];
  };

  services.openssh = {
    enable = true;
    openFirewall = true;
    settings = {
      PermitRootLogin = "prohibit-password";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
    };
  };

  # The owner's key.
  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILN3IIn6TzBBExWiJTJ7aDlA/LlEMXvjFlSfkKkV02TZ wiz@choiros-ovh"
  ];

  nix.settings.auto-optimise-store = true;
  nix.gc = {
    automatic = true;
    dates = "weekly";
    options = "--delete-older-than 14d";
  };

  environment.systemPackages = with pkgs; [ git vim curl htop ];

  services.choirBackupTarget = {
    enable = true;
    nodeBPublicKeys = [ "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILivRWaikcbZzRs6qO4yhmvl+WDqVZjXKsjFVZIHHC3R node-b-offhost-backup" ];
    # /data does not exist on this host; /srv is a btrfs subvolume.
    dataDir = "/srv/choir-backup";
    # Quotas (qgroups) are off on this filesystem and slow btrfs with many
    # snapshots (the workstation snapshots); rest-server's --max-size (95%
    # of quotaGiB) is the limit instead.
    enforceBtrfsQuota = false;
  };

  time.timeZone = "UTC";
  system.stateVersion = "25.11";
}
