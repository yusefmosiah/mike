# Workstation VMs on node-a (goals/mission-13-workstation-vms.md, phase 3).
#
# Each VM: Cloud Hypervisor via microvm.nix, guest from ../workstation/guest.nix.
#  - Channel: ssh over vsock only. The harness on this host connects with
#    `ProxyCommand=systemd-ssh-proxy vsock-mux/<state>/notify.vsock 22`.
#  - Storage: /var/lib/microvms/<name> is a btrfs subvolume holding home.img;
#    `ws-snapshot` takes read-only snapshots after flushing the guest, and
#    `ws-restore` rolls the disk back to one.
#  - Network: a tap per VM with NAT to the internet. The VM cannot reach this
#    host (input from ws-* is dropped), other VMs, or private and link-local
#    ranges. An egress proxy with logging is phase 4.
{ config, lib, pkgs, microvm, ... }:

let
  harnessKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL2zWuvPSHPJUbiy7JysOXsQ/HARKlZNM86hFz/geLZ mike-harness@node-a";

  # name -> { index (1..250), vcpu, mem MiB, home disk MiB }
  workstations = {
    ws-owner = { index = 1; vcpu = 4; mem = 6144; homeMiB = 65536; };
  };

  subnet = ws: "10.77.${toString ws.index}";
  mac = ws: "02:00:00:77:00:${lib.fixedWidthString 2 "0" (lib.toHexString ws.index)}";

  guest = name: ws: {
    # The guest gets its own pkgs from this host's nixpkgs.
    inherit pkgs;
    config = {
      imports = [ ../workstation/guest.nix ];
      workstation.authorizedKeys = [ harnessKey ];
      workstation.homeDiskMiB = ws.homeMiB;
      microvm = {
        hypervisor = "cloud-hypervisor";
        vcpu = ws.vcpu;
        mem = ws.mem;
        vsock.cid = 100 + ws.index;
        vsock.ssh.enable = true;
        interfaces = [{ type = "tap"; id = name; mac = mac ws; }];
      };
      networking.hostName = lib.mkForce name;
      networking.useNetworkd = true;
      networking.useDHCP = false;
      systemd.network.networks."10-uplink" = {
        matchConfig.MACAddress = mac ws;
        address = [ "${subnet ws}.2/24" ];
        gateway = [ "${subnet ws}.1" ];
        dns = [ "1.1.1.1" "9.9.9.9" ];
      };
    };
  };

  stateDir = "/var/lib/microvms";
  snapshotDir = "/var/lib/workstation-snapshots";
  sshProxy = "${config.systemd.package}/lib/systemd/systemd-ssh-proxy";
  sshToGuest = name: ''${pkgs.openssh}/bin/ssh -F /dev/null -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=10 -i /var/lib/mike-workstations/harness_ed25519 -o ProxyUseFdpass=yes -o "ProxyCommand=${sshProxy} vsock-mux/${stateDir}/${name}/notify.vsock 22" agent@${name}'';

  wsTools = pkgs.writeShellApplication {
    name = "ws";
    runtimeInputs = [ pkgs.btrfs-progs pkgs.coreutils pkgs.e2fsprogs pkgs.gnugrep pkgs.systemd ];
    text = ''
      # ws ssh <vm> [command...]     run a command in the VM as agent
      # ws snapshot <vm> [label]     flush the guest, then snapshot its disk
      # ws snapshots <vm>            list snapshots
      # ws restore <vm> <snapshot>   stop the VM, roll its disk back, start it
      cmd=''${1:-}; vm=''${2:-}
      [ -n "$cmd" ] && [ -n "$vm" ] || { sed -n '2,6p' "$0"; exit 2; }
      case "$vm" in ${lib.concatStringsSep "|" (lib.attrNames workstations)}) ;; *) echo "unknown vm: $vm" >&2; exit 2;; esac
      ssh_vm() {
        case "$vm" in
          ${lib.concatStringsSep "\n          " (lib.mapAttrsToList (name: _: "${name}) ${sshToGuest name} \"$@\" ;;") workstations)}
        esac
      }
      case "$cmd" in
        ssh) shift 2; ssh_vm "$@" ;;
        snapshot)
          label=''${3:-manual}
          # Flush the guest's dirty pages so the snapshot holds what it wrote
          # (sync(2) flushes every filesystem; the agent needs no root for it).
          ssh_vm sync || echo "warning: guest not reachable, snapshot is crash-consistent only" >&2
          mkdir -p "${snapshotDir}/$vm"
          dest="${snapshotDir}/$vm/$(date -u +%Y%m%dT%H%M%SZ)-$label"
          btrfs subvolume snapshot -r "${stateDir}/$vm" "$dest" >/dev/null
          echo "$dest" ;;
        snapshots) ls -1 "${snapshotDir}/$vm" 2>/dev/null ;;
        restore)
          snap=''${3:?snapshot name}
          src="${snapshotDir}/$vm/$snap/home.img"
          [ -f "$src" ] || { echo "no such snapshot: $snap" >&2; exit 1; }
          dest="${stateDir}/$vm/home.img.restore"
          rm -f "$dest"
          # btrfs clones only between files with the same no-copy-on-write
          # attribute, and VM images carry it (+C).
          touch "$dest"
          if lsattr -d "$src" | cut -d' ' -f1 | grep -q C; then chattr +C "$dest"; fi
          systemctl stop "microvm@$vm.service"
          cp --reflink=always "$src" "$dest"
          chown microvm:kvm "${stateDir}/$vm/home.img.restore"
          mv "${stateDir}/$vm/home.img.restore" "${stateDir}/$vm/home.img"
          systemctl start "microvm@$vm.service"
          echo "restored $vm to $snap" ;;
        *) echo "unknown command: $cmd" >&2; exit 2 ;;
      esac
    '';
  };
in
{
  imports = [ microvm.nixosModules.host ];

  microvm.vms = lib.mapAttrs guest workstations;
  microvm.autostart = lib.attrNames workstations;

  # Each VM's state directory is a btrfs subvolume, so its disk can be
  # snapshotted atomically.
  systemd.tmpfiles.rules =
    [ "d ${snapshotDir} 0700 root root -" ]
    ++ lib.mapAttrsToList (name: _: "v ${stateDir}/${name} 0755 microvm kvm -") workstations;

  networking.interfaces = lib.mapAttrs' (name: ws:
    lib.nameValuePair name { ipv4.addresses = [{ address = "${subnet ws}.1"; prefixLength = 24; }]; }
  ) workstations;

  networking.nat = {
    enable = true;
    externalInterface = "eno1";
    internalInterfaces = lib.attrNames workstations;
  };

  networking.nftables.enable = true;
  networking.nftables.tables.workstation-egress = {
    family = "inet";
    content = ''
      chain input {
        # The host talks to a VM over vsock only; nothing a VM sends to any
        # of the host's addresses is accepted (ssh on 22 is open globally).
        type filter hook input priority filter - 1; policy accept;
        iifname "ws-*" drop
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        # A VM reaches the internet through eno1 and nothing else: not
        # another VM, not private, loopback, link-local or CGNAT ranges.
        iifname "ws-*" oifname != "eno1" drop
        iifname "ws-*" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8 } drop
        iifname "ws-*" meta nfproto ipv6 drop
      }
    '';
  };

  environment.systemPackages = [ wsTools ];
}
