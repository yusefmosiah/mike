# The employee workstation guest: a full NixOS userland for Mike's agent to
# work in (bash, Python, git, Node, office-file libraries). It holds no
# secrets: the harness stays on the host and reaches the guest over ssh.
#
# /home lives on the VM's data disk, which the host snapshots. Everything
# else is rebuilt from this file: the Nix store is a read-only disk image
# shared by every VM.
{ config, lib, pkgs, ... }:

let
  cfg = config.workstation;
  # Code mode (Mission 11) runs the agent's Python here: dill keeps a
  # conversation's variables across kernel restarts; the rest is for web
  # data, documents and analysis larger than memory.
  python = pkgs.python3.withPackages (ps: with ps; [
    beautifulsoup4
    dill
    duckdb
    httpx
    lxml
    matplotlib
    openpyxl
    pandas
    pdfplumber
    polars
    pyarrow
    pypdf
    python-docx
    requests
    xlsxwriter
  ]);
in
{
  options.workstation = {
    authorizedKeys = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = "Public keys the harness uses to reach the agent account.";
    };
    homeDiskMiB = lib.mkOption {
      type = lib.types.int;
      default = 8192;
      description = "Size of a freshly created home disk image (dev runners only).";
    };
  };

  config = {
    system.stateVersion = lib.trivial.release;
    networking.hostName = "workstation";

    microvm = {
      vcpu = lib.mkDefault 2;
      mem = lib.mkDefault 2048;
      # Plain LZ4 lets mkfs.erofs use every core; the default adds
      # fragments/dedupe, which forces a slow single-threaded pack.
      storeDiskErofsFlags = [ "-zlz4" ];
      volumes = [{
        image = "home.img";
        mountPoint = "/home";
        size = cfg.homeDiskMiB;
        label = "home";
      }];
    };

    # The agent's account. Not root, no sudo: system state comes from this
    # file, and the agent's own work lives in /home/agent.
    users.mutableUsers = false;
    # Deliberately no root or wheel login: the system is rebuilt from this
    # file, never administered from inside.
    users.allowNoPasswordLogin = true;
    users.users.agent = {
      isNormalUser = true;
      home = "/home/agent";
      createHome = true;
      shell = pkgs.bashInteractive;
      openssh.authorizedKeys.keys = cfg.authorizedKeys;
    };

    # The home disk is mounted over /home after NixOS creates home
    # directories, and starts empty; create the agent's home once it is there.
    systemd.tmpfiles.rules = [ "d /home/agent 0700 agent users -" ];

    services.openssh = {
      enable = true;
      # The dev lane opens 22 itself; in production ssh rides vsock only.
      openFirewall = false;
      settings = {
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        PermitRootLogin = "no";
        AllowUsers = [ "agent" ];
      };
    };

    environment.systemPackages = with pkgs; [
      bashInteractive
      coreutils
      curl
      file
      findutils
      git
      gnugrep
      gnused
      jq
      nodejs_22
      python
      ripgrep
      unzip
      zip
    ];

    nix.enable = false;
    documentation.enable = false;
  };
}
