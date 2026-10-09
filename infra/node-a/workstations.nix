# Workstation VMs on node-a (goals/mission-13-workstation-vms.md, phase 3).
#
# Each VM: Cloud Hypervisor via microvm.nix, guest from ../workstation/guest.nix.
#  - Channel: ssh over vsock only. The harness on this host connects with
#    `ProxyCommand=systemd-ssh-proxy vsock-mux/<state>/notify.vsock 22`.
#  - Storage: /var/lib/microvms/<name> is a btrfs subvolume holding home.img;
#    `ws-snapshot` takes read-only snapshots after flushing the guest, and
#    `ws-restore` rolls the disk back to one.
#  - Network: a tap per VM, and no route out except the egress proxy
#    (tinyproxy on this host, port 3128 on the VM's gateway address), which
#    logs every request to the journal (`journalctl -u tinyproxy`). The guest
#    has proxy settings for HTTP(S), git, pip, npm, Node and ssh, and no DNS:
#    the proxy resolves names. The proxy itself cannot open connections to
#    loopback, private, link-local or CGNAT addresses, so a VM cannot use it
#    to reach this host's services or anything internal. A VM with
#    `directEgress = true` also gets filtered NAT to the internet.
#  - The Mike backend (a container) reaches a VM through
#    /run/mike-workstations/<vm>.sock, a socket-activated relay to the VM's
#    vsock socket, and asks for snapshots on /run/mike-workstations/control.sock.
#    Only that directory is shared with it, not the VM's state directory.
{ config, lib, pkgs, microvm, ... }:

let
  harnessKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL2zWuvPSHPJUbiy7JysOXsQ/HARKlZNM86hFz/geLZ mike-harness@node-a";

  # name -> { index (1..250), vcpu, mem MiB, home disk MiB, directEgress }
  workstations = {
    ws-owner = { index = 1; vcpu = 4; mem = 6144; homeMiB = 65536; directEgress = false; };
  };

  proxyPort = 3128;
  # Fixed so the nftables rules can name it: the ruleset is checked at build
  # time, where the user does not exist.
  proxyUid = 931;
  proxyUrl = ws: "http://${subnet ws}.1:${toString proxyPort}";
  privateV4 = "10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8";

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
        dns = lib.optionals ws.directEgress [ "1.1.1.1" "9.9.9.9" ];
      };
      # Everything leaves through the host's logging proxy.
      environment.variables = {
        http_proxy = proxyUrl ws;
        https_proxy = proxyUrl ws;
        HTTP_PROXY = proxyUrl ws;
        HTTPS_PROXY = proxyUrl ws;
        no_proxy = "localhost,127.0.0.1";
        NO_PROXY = "localhost,127.0.0.1";
        NODE_USE_ENV_PROXY = "1";
      };
      programs.ssh.extraConfig = ''
        Host *
          ProxyCommand ${pkgs.netcat-openbsd}/bin/nc -X connect -x ${subnet ws}.1:${toString proxyPort} %h %p
      '';
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
  relayDir = "/run/mike-workstations";
  vmNames = lib.attrNames workstations;

  # One request per connection on stdin: `snapshot <vm> <turn|daily>`.
  # Answers `ok <vm>/<snapshot>` or `error <reason>`. A turn snapshot taken in
  # the last two minutes is reused; retention is the newest 48 turn and 14
  # daily snapshots per VM (manual ones are never pruned).
  wsControl = pkgs.writeShellApplication {
    name = "ws-control";
    runtimeInputs = [ wsTools pkgs.btrfs-progs pkgs.coreutils pkgs.util-linux ];
    text = ''
      read -r -t 10 verb vm label || { echo "error bad request"; exit 0; }
      [ "$verb" = snapshot ] || { echo "error unknown request"; exit 0; }
      case "$vm" in ${lib.concatStringsSep "|" vmNames}) ;; *) echo "error unknown vm"; exit 0 ;; esac
      case "$label" in turn) keep=48 ;; daily) keep=14 ;; *) echo "error bad label"; exit 0 ;; esac
      dir="${snapshotDir}/$vm"
      exec 9>"/run/lock/ws-control-$vm.lock"
      flock 9
      shopt -s nullglob
      export LC_ALL=C
      # Names start with a UTC timestamp, so glob order is age order.
      snaps=("$dir"/*-"$label")
      cutoff=$(date -u -d '2 minutes ago' +%Y%m%dT%H%M%SZ)
      if [ "$label" = turn ] && [ ''${#snaps[@]} -gt 0 ]; then
        latest=$(basename "''${snaps[-1]}")
        if [[ "$latest" > "$cutoff" ]]; then echo "ok $vm/$latest"; exit 0; fi
      fi
      if ! out=$(ws snapshot "$vm" "$label" 2>/dev/null); then echo "error snapshot failed"; exit 0; fi
      snaps=("$dir"/*-"$label")
      for (( i = 0; i < ''${#snaps[@]} - keep; i++ )); do
        btrfs subvolume delete "''${snaps[i]}" >/dev/null
      done
      echo "ok $vm/$(basename "$out")"
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
    internalInterfaces = lib.attrNames (lib.filterAttrs (_: ws: ws.directEgress) workstations);
  };

  # nftables runs every base chain on a hook, so the accept below does not
  # get past the NixOS firewall's own input chain; open the port there too.
  networking.firewall.interfaces = lib.mapAttrs (_: _: { allowedTCPPorts = [ proxyPort ]; }) workstations;

  users.users.tinyproxy.uid = proxyUid;
  services.tinyproxy = {
    enable = true;
    settings = {
      # All addresses; the host firewall admits port 3128 only from the VMs'
      # taps (below), and `Allow` repeats that.
      Listen = null;
      Port = proxyPort;
      Allow = "10.77.0.0/16";
      # CONNECT to https and ssh (git) only.
      ConnectPort = [ 443 22 ];
      Timeout = 600;
      MaxClients = 200;
      LogLevel = "Info";
      DisableViaHeader = true;
    };
  };

  networking.nftables.enable = true;
  networking.nftables.tables.workstation-egress = {
    family = "inet";
    content = ''
      chain input {
        # The host talks to a VM over vsock only; the one thing a VM may
        # reach on the host is the egress proxy. Everything else from a tap
        # is dropped here, before the NixOS firewall (which opens ssh on 22
        # to every interface) is consulted.
        type filter hook input priority filter - 1; policy accept;
        iifname "ws-*" tcp dport ${toString proxyPort} accept
        iifname "ws-*" drop
      }
      chain forward {
        type filter hook forward priority filter - 1; policy accept;
        # Only a VM with directEgress is forwarded at all, and then only to
        # the internet through eno1: not another VM, not private, loopback,
        # link-local or CGNAT ranges, no IPv6.
        ${lib.concatStrings (lib.mapAttrsToList (name: ws: lib.optionalString ws.directEgress ''
        iifname "${name}" oifname "eno1" ip daddr != { ${privateV4} } accept
        '') workstations)}
        iifname "ws-*" drop
      }
      chain output {
        # The proxy acts for the VMs, so it gets their limits: no new
        # connections to this host or anything internal, whatever a name
        # resolves to. Replies to the VMs are established traffic.
        type filter hook output priority filter - 1; policy accept;
        meta skuid ${toString proxyUid} ct state new ip daddr { ${privateV4} } drop
        meta skuid ${toString proxyUid} ct state new meta nfproto ipv6 drop
      }
    '';
  };

  systemd.sockets = {
    ws-control = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ "${relayDir}/control.sock" ];
      socketConfig = { Accept = true; SocketMode = "0600"; DirectoryMode = "0700"; MaxConnections = 8; };
    };
  } // lib.mapAttrs' (name: _: lib.nameValuePair "ws-relay-${name}" {
    wantedBy = [ "sockets.target" ];
    listenStreams = [ "${relayDir}/${name}.sock" ];
    socketConfig = { Accept = true; SocketMode = "0600"; DirectoryMode = "0700"; MaxConnections = 32; };
  }) workstations;

  systemd.services = {
    "ws-control@" = {
      description = "Workstation snapshot request";
      serviceConfig = {
        ExecStart = "${wsControl}/bin/ws-control";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        RuntimeMaxSec = 300;
      };
    };
    # A daily snapshot of every VM, kept for two weeks.
    ws-daily-snapshot = {
      description = "Daily workstation snapshots";
      serviceConfig.Type = "oneshot";
      script = lib.concatMapStringsSep "\n" (name: "echo 'snapshot ${name} daily' | ${wsControl}/bin/ws-control") vmNames;
    };
  } // lib.mapAttrs' (name: _: lib.nameValuePair "ws-relay-${name}@" {
    description = "Relay to workstation ${name}'s vsock socket";
    serviceConfig = {
      # Bytes only: the client does Cloud Hypervisor's CONNECT handshake.
      ExecStart = "${pkgs.socat}/bin/socat STDIO UNIX-CONNECT:${stateDir}/${name}/notify.vsock";
      StandardInput = "socket";
      StandardOutput = "socket";
      StandardError = "journal";
    };
  }) workstations;

  systemd.timers.ws-daily-snapshot = {
    wantedBy = [ "timers.target" ];
    timerConfig = { OnCalendar = "daily"; RandomizedDelaySec = "30m"; Persistent = true; };
  };

  environment.systemPackages = [ wsTools wsControl ];
}
