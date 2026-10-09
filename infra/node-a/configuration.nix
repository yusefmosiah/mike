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

  time.timeZone = "UTC";
  system.stateVersion = "25.11";
}
