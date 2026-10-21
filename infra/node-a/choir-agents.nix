# The Choir agents VM: a scratch machine where Claude Code works on go-choir,
# signed in to the owner's Claude Max account. Mostly driven by an
# orchestrating Claude Code on the owner's iMac, which runs `claude -p` here
# over ssh as a subagent; `claude remote-control` also keeps it reachable
# from claude.ai/code and the Claude app.
#
# It is not one of Mike's workstations: not in the pool the backend hands
# out, not served by the vault, no relay socket for the backend. It reuses
# their boundary (workstations.nix): its tap is named ws-agents so the "ws-*"
# nftables rules apply, so it reaches nothing on this host but the logging
# egress proxy, and nothing internal through that.
#
# From the iMac (~/.ssh/config):
#   Host choir-agents
#     User agent
#     ProxyCommand ssh node-a choir-agents-vsock
#     # The hop to node-a is host-key checked; this one is a local vsock
#     # socket, and the guest's host key is new on every boot.
#     StrictHostKeyChecking no
#     UserKnownHostsFile /dev/null
#     LogLevel ERROR
#
# One-time setup, inside the VM: `claude auth login` (prints a URL; sign in,
# paste the code back), a deploy key for go-choir, the go-choir clone in
# ~/go-choir, and the first `tmux attach -t remote-control` to accept its
# trust prompts.
{ lib, pkgs, ... }:

let
  name = "agents";
  tap = "ws-agents";
  # Clear of the workstations' 1..5; 10.77.200.0/24, vsock CID 300.
  index = 200;
  subnet = "10.77.${toString index}";
  proxyUrl = "http://${subnet}.1:3128";
  tmpDir = "/home/agent/.tmp";
  stateDir = "/var/lib/microvms/${name}";
  # 6 GiB beside the workstations' 18: 24 of the host's 31.
  vcpu = 4;
  mem = 6144;
  homeMiB = 131072;
  ownerKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILN3IIn6TzBBExWiJTJ7aDlA/LlEMXvjFlSfkKkV02TZ wiz@choiros-ovh";

  # Environment for shells, ssh commands and services alike: the egress
  # proxy, and go-choir's dev shell (ICU for Dolt's cgo) without Nix.
  agentEnv = gpkgs: {
    http_proxy = proxyUrl;
    https_proxy = proxyUrl;
    HTTP_PROXY = proxyUrl;
    HTTPS_PROXY = proxyUrl;
    no_proxy = "localhost,127.0.0.1";
    NO_PROXY = "localhost,127.0.0.1";
    NODE_USE_ENV_PROXY = "1";
    # Claude Code's bundled ripgrep is not built for NixOS.
    USE_BUILTIN_RIPGREP = "0";
    # / and /tmp are a ~3 GB RAM-backed rootfs; go-choir's links fill it.
    # Temporary files go on the home disk instead.
    TMPDIR = tmpDir;
    GOTMPDIR = tmpDir;
    PKG_CONFIG_PATH = "${gpkgs.icu.dev}/lib/pkgconfig";
    CGO_CFLAGS = "-I${gpkgs.icu.dev}/include";
    CGO_CXXFLAGS = "-I${gpkgs.icu.dev}/include";
    CGO_LDFLAGS = "-L${gpkgs.icu}/lib -licui18n -licuuc -licudata";
    LD_LIBRARY_PATH = "${gpkgs.icu}/lib";
  };

  # Cloud Hypervisor's vsock socket wants `CONNECT 22` before it carries
  # bytes; systemd-ssh-proxy does that only for a local ssh (it passes the
  # socket back), so a remote ProxyCommand needs this instead.
  vsockRelay = pkgs.writers.writePython3Bin "choir-agents-vsock" { flakeIgnore = [ "E501" ]; } ''
    import os
    import socket
    import sys

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.connect("${stateDir}/notify.vsock")
    s.sendall(b"CONNECT 22\n")
    reply = b""
    while not reply.endswith(b"\n"):
        chunk = s.recv(1)
        if not chunk:
            sys.exit("the agents VM closed the connection")
        reply += chunk
    if not reply.startswith(b"OK "):
        sys.exit("the agents VM refused: " + reply.decode(errors="replace"))
    os.set_inheritable(s.fileno(), True)
    socat = "${pkgs.socat}/bin/socat"
    os.execv(socat, ["socat", "STDIO", "FD:%d" % s.fileno()])
  '';

  guest = { pkgs, ... }:
    let
      env = agentEnv pkgs;
      exports = lib.concatStrings (lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}\n") env);
      # Claude Code's native install lives on the home disk and updates
      # itself; this puts it on every PATH (ssh commands included) with the
      # VM's environment.
      claude = pkgs.writeShellScriptBin "claude" ''
        ${exports}
        exec "$HOME/.local/bin/claude" "$@"
      '';
      tools = with pkgs; [
        bashInteractive coreutils curl diffutils dolt file findutils gcc gh git
        gnugrep gnumake gnused gnutar go gzip icu jq nodejs_22 pkg-config
        pnpm procps python3 ripgrep tmux unzip which xz zip
      ];
    in
    {
      system.stateVersion = lib.trivial.release;
      networking.hostName = name;

      microvm = {
        hypervisor = "cloud-hypervisor";
        inherit vcpu mem;
        vsock.cid = 100 + index;
        vsock.ssh.enable = true;
        interfaces = [{ type = "tap"; id = tap; mac = "02:00:00:77:00:c8"; }];
        storeDiskErofsFlags = [ "-zlz4" ];
        volumes = [{ image = "home.img"; mountPoint = "/home"; size = homeMiB; label = "home"; }];
      };

      networking.useNetworkd = true;
      networking.useDHCP = false;
      systemd.network.networks."10-uplink" = {
        matchConfig.MACAddress = "02:00:00:77:00:c8";
        address = [ "${subnet}.2/24" ];
        gateway = [ "${subnet}.1" ];
      };
      environment.variables = env;
      # git over ssh (GitHub) through the proxy, as on the workstations.
      programs.ssh.extraConfig = ''
        Host *
          ProxyCommand ${pkgs.netcat-openbsd}/bin/nc -X connect -x ${subnet}.1:3128 %h %p
      '';

      users.mutableUsers = false;
      users.allowNoPasswordLogin = true;
      users.users.agent = {
        isNormalUser = true;
        home = "/home/agent";
        createHome = true;
        shell = pkgs.bashInteractive;
        openssh.authorizedKeys.keys = [ ownerKey ];
      };
      systemd.tmpfiles.rules = [ "d /home/agent 0700 agent users -" "d ${tmpDir} 0700 agent users -" ];

      services.openssh = {
        enable = true;
        openFirewall = false;
        settings = {
          PasswordAuthentication = false;
          KbdInteractiveAuthentication = false;
          PermitRootLogin = "no";
          AllowUsers = [ "agent" ];
        };
      };

      # Claude Code's native binary is linked for a usual Linux layout.
      programs.nix-ld.enable = true;
      environment.systemPackages = tools ++ [ claude ];

      systemd.services.claude-code-install = {
        description = "Install Claude Code into the agent's home";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [ "network-online.target" "home.mount" ];
        path = tools;
        environment = env;
        serviceConfig = { Type = "oneshot"; RemainAfterExit = true; User = "agent"; };
        script = ''
          [ -x "$HOME/.local/bin/claude" ] && exit 0
          curl -fsSL https://claude.ai/install.sh | bash
        '';
      };

      # Waits (restarting every minute) until there is a login and a
      # checkout; `tmux attach -t remote-control` shows it.
      systemd.services.claude-remote-control = {
        description = "Claude Code Remote Control for ~/go-choir";
        wantedBy = [ "multi-user.target" ];
        wants = [ "network-online.target" ];
        after = [ "network-online.target" "claude-code-install.service" ];
        path = tools ++ [ claude ];
        environment = env;
        unitConfig.StartLimitIntervalSec = 0;
        serviceConfig = {
          Type = "forking";
          User = "agent";
          WorkingDirectory = "/home/agent/go-choir";
          ExecStart = "${pkgs.tmux}/bin/tmux new-session -d -s remote-control claude remote-control --spawn worktree --capacity 4";
          ExecStop = "${pkgs.tmux}/bin/tmux kill-session -t remote-control";
          Restart = "always";
          RestartSec = 60;
        };
      };

      nix.enable = false;
      documentation.enable = false;
    };
in
{
  microvm.vms.${name} = {
    inherit pkgs;
    config = guest;
  };

  # A btrfs subvolume like the workstations', so `btrfs subvolume snapshot`
  # works on it by hand.
  systemd.tmpfiles.rules = [ "v ${stateDir} 0755 microvm kvm -" ];
  networking.interfaces.${tap}.ipv4.addresses = [{ address = "${subnet}.1"; prefixLength = 24; }];
  networking.firewall.interfaces.${tap}.allowedTCPPorts = [ 3128 ];

  environment.systemPackages = [ vsockRelay ];
}
