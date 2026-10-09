# node-a disks, from /root/HANDOFF.md (2026-10-09): btrfs on md RAID1.
{ ... }:
{
  fileSystems."/" = {
    device = "/dev/disk/by-uuid/9a03773d-24c3-49ca-8937-7296869a6135";
    fsType = "btrfs";
    options = [ "subvol=@" "compress=zstd" "noatime" ];
  };

  # /data (subvolume @data, old Choir-era VM images) was removed 2026-10-09
  # on the owner's decision.

  fileSystems."/boot" = {
    device = "/dev/disk/by-uuid/f0ed2a80-34d0-4f2b-97a7-692fe10f70a7";
    fsType = "ext4";
  };

  fileSystems."/boot/efi" = {
    device = "/dev/disk/by-uuid/BB79-CECF";
    fsType = "vfat";
    options = [ "umask=0077" ];
  };

  swapDevices = [ ];
}
