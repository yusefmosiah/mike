# node-a hardware, from /root/HANDOFF.md (2026-10-09).
{ config, lib, pkgs, modulesPath, ... }:
{
  imports = [ (modulesPath + "/installer/scan/not-detected.nix") ];

  boot.initrd.availableKernelModules = [ "ahci" "nvme" "usb_storage" "usbhid" ];
  boot.kernelModules = [ "kvm-intel" ];
  boot.swraid.enable = true;
  boot.swraid.mdadmConf = "MAILADDR root";

  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
  hardware.cpu.intel.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
}
