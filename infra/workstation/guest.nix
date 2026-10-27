# The employee workstation guest: a full NixOS userland for Mike's agent to
# work in (bash, Python, git, Node, office-file libraries). It holds no
# secrets: the harness stays on the host and reaches the guest over ssh, and
# a stored secret is used through the host's vault, which attaches it there.
#
# /home lives on the VM's data disk, which the host snapshots. Everything
# else is rebuilt from this file: the Nix store is a read-only disk image
# shared by every VM.
{ config, lib, pkgs, ... }:

let
  cfg = config.workstation;
  # Code mode (Mission 11) runs the agent's Python here: dill keeps a
  # conversation's variables across kernel restarts; the rest is for web
  # data, documents and analysis larger than memory. youtube-transcript-api
  # is the transcriber skill's caption source (Mission 17, K3).
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
    youtube-transcript-api
  ]);

  # `layer` checks a named tool out of the Nix store on demand (Mission 20):
  # `layer use <name> [reason] [-- <cmd>]` builds the manifest's attr through
  # the egress proxy if the closure is not already present, logs the entry
  # to the host's ledger, and puts the closure on PATH for the command (or
  # prints the activation line). `layer install` keeps it in the agent's nix
  # profile; `nix gc` may remove an installed-but-unused closure, so the
  # manifest is the check-out list, not a cache.
  layer = pkgs.writeShellApplication {
    name = "layer";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.nix ];
    text = ''
      set -euo pipefail
      manifest=/etc/layers.json
      ledger_url=''${MIKE_LAYER_LEDGER_URL:-}
      roots="$HOME/.local/share/mike/layers"

      usage() {
        cat >&2 <<'EOF'
      layer list                      names, purposes and how to enter each layer
      layer use <name> [reason] [-- <cmd>...]
                                    fetch the layer (once), then run the command
                                    with it on PATH, or print its activation line
      layer install <name> [reason] keep the layer in the agent's nix profile
      layer forget <name>           remove it from the profile again
      layer env <name>              print export lines for the layer's env vars
      EOF
        exit 2
      }

      attr()  { jq -r --arg n "$1" '.layers[$n].attr // empty' "$manifest"; }
      pkgs_of() { jq -r --arg n "$1" '.layers[$n].packages // [] | map("p.\(.)") | join(" ")' "$manifest"; }
      has()   { jq -e --arg n "$1" '.layers | has($n)' "$manifest" >/dev/null; }

      # Log the check-out to the host-side ledger (vsock relay on 8201). A
      # dead relay must not break the tool, so failure downgrades to stderr.
      ledger() {
        [ -n "$ledger_url" ] || return 0
        curl -sf -m 5 -X POST -H 'content-type: application/json' \
          --data-binary "$1" "$ledger_url" \
          || echo "layer: ledger relay unreachable; entry not logged" >&2
      }

      # Build the layer's closure if it is not already a gc root; returns the
      # store path on stdout. The registry pins nixpkgs to the same revision
      # the VM was built from, so almost everything substitutes.
      ensure() {
        local name="$1" reason="''${2:-}" out a expr
        out="$roots/$name"
        if [ ! -e "$out" ]; then
          a="$(attr "$name")"
          if [ "$a" = "symlinkJoin" ]; then
            # `with` scopes attrs but binds no `p.` names, so the package
            # list has to come through an explicit let-binding — and the
            # build happens once, not twice.
            expr="let p = import <nixpkgs> {}; in p.symlinkJoin { name = \"layer-$name\"; paths = [ $(pkgs_of "$name") ]; }"
            out_path="$(nix build --no-link --print-out-paths --expr "$expr")"
            nix-store --add-root "$out" --realise "$out_path" >/dev/null
          else
            nix-store --add-root "$out" --realise \
              "$(nix build --no-link --print-out-paths "nixpkgs#$a")" >/dev/null
          fi
          ledger "{\"event\":\"layer_fetch\",\"vm\":\"$HOSTNAME\",\"layer\":\"$name\",\"store_path\":\"$(readlink "$out")\",\"reason\":$(jq -Rn --arg r "$reason" '$r')}"
        fi
        readlink "$out"
      }

      enter_line() {
        jq -r --arg n "$1" --arg p "$2" \
          '.layers[$n].env // {} | to_entries | map("export \(.key)=\(.value|@sh)") | join("; ") + (if length > 0 then "; " else "" end) + "export PATH=\($p)/bin:$PATH"' \
          "$manifest"
      }

      cmd="''${1:-}"; [ $# -gt 0 ] && shift
      case "$cmd" in
        list)
          if [ "''${1:-}" = "--json" ]; then
            # name -> installed, checked against the layer gc roots.
            first=1
            printf '{'
            for name in $(jq -r '.layers | keys[]' "$manifest"); do
              [ "$first" -eq 0 ] && printf ','
              first=0
              if [ -e "$roots/$name" ]; then printf '"%s":true' "$name"; else printf '"%s":false' "$name"; fi
            done
            printf '}\n'
          else
            jq -r '.layers | to_entries[] | "\(.key)\n  \(.value.purpose)\n  enter: layer use \(.key)\n  unlocks: \(.value.unlocks)"' "$manifest"
          fi
          ;;
        env)
          has "''${1:?layer name}" || { echo "unknown layer: $1" >&2; exit 1; }
          jq -r --arg n "$1" '.layers[$n].env // {} | to_entries[] | "export \(.key)=\(.value|@sh)"' "$manifest"
          ;;
        use|install)
          name="''${1:?layer name}"; shift
          has "$name" || { echo "unknown layer: $name (layer list)" >&2; exit 1; }
          reason="''${*%% -- *}"; [ "$reason" = "$*" ] || set -- "''${*#* -- }"
          path="$(ensure "$name" "$reason")"
          if [ "$cmd" = install ]; then
            nix profile install "$path"
            ledger "{\"event\":\"layer_install\",\"vm\":\"$HOSTNAME\",\"layer\":\"$name\",\"store_path\":\"$path\",\"reason\":$(jq -Rn --arg r "$reason" '$r')}"
            echo "installed $name ($path)"
          else
            env_line="$(enter_line "$name" "$path")"
            if [ "''${1:-}" = "--" ]; then shift; fi
            if [ $# -gt 0 ]; then
              eval "$env_line"
              exec "$@"
            else
              echo "$env_line"
              echo "# eval \"\$(layer use $name)\" to enter, or: layer use $name -- <cmd>" >&2
            fi
          fi
          ;;
        forget)
          name="''${1:?layer name}"; shift
          nix profile remove "layers.$name" 2>/dev/null || nix profile remove "$name" 2>/dev/null || true
          rm -f "$roots/$name"
          echo "forgot $name"
          ;;
        *) usage ;;
      esac
    '';
  };
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

    # The host's secrets vault (infra/node-a/vault.nix) on a local port: a
    # request to $MIKE_VAULT_URL/<lease>/<host>/<path> goes to <host> with a
    # secret attached on the host, so this machine never holds the secret.
    # Each connection is relayed to host port 8200 over vsock, which tells
    # the vault which VM is asking.
    systemd.sockets.mike-vault = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ "127.0.0.1:8200" ];
      socketConfig.Accept = true;
    };
    systemd.services."mike-vault@" = {
      description = "Relay to the host's secrets vault";
      serviceConfig = {
        ExecStart = "${pkgs.socat}/bin/socat STDIO VSOCK-CONNECT:2:8200";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        DynamicUser = true;
      };
    };
    environment.variables.MIKE_VAULT_URL = "http://127.0.0.1:8200";

    environment.systemPackages = with pkgs; [
      bashInteractive
      coreutils
      curl
      ffmpeg-headless
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
      # The transcriber skill: video metadata and captions, audio when asked.
      yt-dlp
      zip
      # The `layer` wrapper itself, from the let block above.
      layer
    ];


    # Layers: the store stays a read-only image for the base system, and a
    # writable overlay on the home disk takes what `nix` fetches through the
    # egress proxy. Fetched closures persist on home.img, so snapshots and
    # restores cover them with the agent's files; a wipe drops them too.
    microvm.writableStoreOverlay = "/home";
    nix = {
      enable = true;
      # auto-optimise-store hardlinks through the overlay, which microvm.nix
      # asserts against; keep it off.
      settings = {
        experimental-features = [ "nix-command" "flakes" ];
        auto-optimise-store = false;
      };
      # The same nixpkgs the VM was built from: `nixpkgs#foo` resolves without
      # network and substitutes cover nearly everything it names.
      registry.nixpkgs.to = {
        type = "path";
        path = pkgs.path;
      };
      nixPath = [ "nixpkgs=${pkgs.path}" ];
      gc = {
        automatic = true;
        dates = "weekly";
        options = "--delete-older-than 30d";
      };
    };

    # The daemon does the fetching, so it needs the proxy vars (production
    # guests set them on every process through environment.variables).
    systemd.services.nix-daemon.serviceConfig.Environment =
      lib.mapAttrsToList
        (k: v: "${k}=${v}")
        (lib.filterAttrs (k: _: lib.hasInfix "proxy" k) config.environment.variables);

    # The manifest the `layer` script and the harness both read; one source.
    environment.etc."layers.json".source = ./layers.json;
    environment.etc."layers/fonts.conf".text = ''
      <?xml version="1.0"?>
      <!DOCTYPE fontconfig SYSTEM "fonts.dtd">
      <fontconfig>
        <include>/etc/fonts/fonts.conf</include>
        <dir>~/.nix-profile/share/fonts</dir>
      </fontconfig>
    '';

    # Layer check-ins are logged on the host, not in the guest: a local
    # socket relays each JSON line over vsock to a host-side journald sink,
    # the same shape as the vault relay above.
    systemd.sockets.mike-layer-ledger = {
      wantedBy = [ "sockets.target" ];
      listenStreams = [ "127.0.0.1:8201" ];
      socketConfig.Accept = true;
    };
    systemd.services."mike-layer-ledger@" = {
      description = "Relay one layer-ledger line to the host";
      serviceConfig = {
        ExecStart = "${pkgs.socat}/bin/socat STDIO VSOCK-CONNECT:2:8201";
        StandardInput = "socket";
        StandardOutput = "socket";
        StandardError = "journal";
        DynamicUser = true;
      };
    };
    environment.variables.MIKE_LAYER_LEDGER_URL = "http://127.0.0.1:8201";

    documentation.enable = false;
  };
}
