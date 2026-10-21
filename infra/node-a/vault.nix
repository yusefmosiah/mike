# The secrets vault (../vault/README.md): a service on this host that holds
# users' secrets and attaches them to requests the workstation VMs make, so
# no VM ever holds one.
#
#  - /run/mike-vault/control.sock: the control API. Only the backend
#    container mounts this directory. Manages secrets, issues leases;
#    nothing on it returns a value.
#  - /var/lib/microvms/<vm>/notify.vsock_8200: one per VM. Cloud Hypervisor
#    connects a guest's vsock connection to host port 8200 here, so the
#    socket a request arrives on is the VM it came from. Inside the guest a
#    relay serves it on http://127.0.0.1:8200 ($MIKE_VAULT_URL).
#  - /var/lib/mike-vault: the master key, the sealing key and the encrypted
#    store, readable by this service alone (a dynamic user). Back it up with
#    the master key, or not at all: one without the other is useless.
{ lib, pkgs, workstationVms, ... }:

let
  vms = workstationVms;
  port = 8200;
  # The service's own files only; Node runs the TypeScript directly.
  src = builtins.path {
    name = "mike-vault";
    path = ../vault;
    filter = path: type: !(type == "directory" && builtins.elem (baseNameOf path) [ "test" "node_modules" ]);
  };
  vmSocket = vm: "mike-vault-${vm}";
  socketUnits = [ "mike-vault-control.socket" ] ++ map (vm: "${vmSocket vm}.socket") vms;
in
{
  systemd.sockets = {
    mike-vault-control = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ "/run/mike-vault/control.sock" ];
      socketConfig = {
        Service = "mike-vault.service";
        FileDescriptorName = "control";
        SocketMode = "0600";
        DirectoryMode = "0700";
      };
    };
  } // lib.listToAttrs (map (vm: lib.nameValuePair (vmSocket vm) {
    wantedBy = [ "sockets.target" ];
    # microvm-run removes only notify.vsock and notify.vsock_8888 on start,
    # so this socket survives VM restarts.
    listenStreams = [ "/var/lib/microvms/${vm}/notify.vsock_${toString port}" ];
    socketConfig = {
      Service = "mike-vault.service";
      FileDescriptorName = "vm-${vm}";
      # Cloud Hypervisor runs as microvm and connects here for the guest.
      SocketUser = "microvm";
      SocketGroup = "kvm";
      SocketMode = "0600";
      RemoveOnStop = true;
    };
  }) vms);

  systemd.services.mike-vault = {
    description = "Mike secrets vault";
    requires = socketUnits;
    after = socketUnits ++ [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];
    environment.NODE_ENV = "production";
    serviceConfig = {
      ExecStart = "${pkgs.nodejs_22}/bin/node --max-old-space-size=256 ${src}/src/main.ts";
      Sockets = socketUnits;
      Restart = "on-failure";
      RestartSec = 2;
      DynamicUser = true;
      StateDirectory = "mike-vault";
      StateDirectoryMode = "0700";
      UMask = "0077";
      # It only answers on the sockets above and makes HTTPS requests to
      # public addresses; the kernel enforces the second half too, whatever
      # a name resolves to.
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" ];
      IPAddressDeny = [
        "localhost" "link-local" "multicast" "0.0.0.0/8" "10.0.0.0/8" "100.64.0.0/10" "172.16.0.0/12"
        "192.0.0.0/24" "192.0.2.0/24" "192.168.0.0/16" "198.18.0.0/15" "198.51.100.0/24" "203.0.113.0/24" "240.0.0.0/4"
      ];
      # One VM's requests cannot take the host's memory, threads or file
      # descriptors; the service caps each VM's share itself (data.ts).
      MemoryMax = "512M";
      TasksMax = 64;
      LimitNOFILE = 4096;
      CapabilityBoundingSet = "";
      NoNewPrivileges = true;
      PrivateTmp = true;
      PrivateDevices = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectProc = "invisible";
      ProcSubset = "pid";
      ProtectHostname = true;
      ProtectClock = true;
      ProtectKernelTunables = true;
      ProtectKernelModules = true;
      ProtectKernelLogs = true;
      ProtectControlGroups = true;
      RestrictNamespaces = true;
      RestrictRealtime = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = [ "@system-service" "~@privileged" "~@resources" ];
      # Node's JIT needs writable, executable memory.
      MemoryDenyWriteExecute = false;
      LimitCORE = 0;
    };
  };
}
