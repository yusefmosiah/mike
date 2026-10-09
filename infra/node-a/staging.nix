# Mike staging on node-a: the repository's own docker-compose stack under
# rootful Podman (Docker would set the kernel's FORWARD policy to DROP and
# cut off the workstation VMs' NAT), with Caddy terminating TLS for
# choir-ip.com on 80/443.
#
#   /var/lib/mike-staging/src          the checkout being served (rsync'd, no .env files)
#   /var/lib/mike-staging/secrets.env  compose-level secrets, generated once
#   /var/lib/mike-staging/app.env      backend secrets, generated once
#   /var/lib/mike-staging/backend.env  model and search keys, copied in by the operator
#   /var/lib/mike-staging/workstation.env  the owner's workstation VM, written by owner-link
#   /var/lib/mike-staging/backups/<time>/  daily: postgres.dump (restore-checked) and storage.tar.zst
#   mike-staging deploy | up | down | ps | logs [svc] | owner-link <email> | backup | health
{ config, lib, pkgs, ... }:

let
  domain = "choir-ip.com";
  root = "/var/lib/mike-staging";
  overrideFile = ./staging/compose.override.yml;

  stagingTool = pkgs.writeShellApplication {
    name = "mike-staging";
    runtimeInputs = with pkgs; [ coreutils findutils gnutar zstd openssl gnugrep curl jq podman docker-compose ];
    text = ''
      export DOCKER_HOST=unix:///run/podman/podman.sock
      compose() {
        docker-compose --project-name mike --project-directory ${root}/src \
          -f ${root}/src/docker-compose.yml -f ${overrideFile} --env-file ${root}/secrets.env "$@"
      }
      rand() { openssl rand -hex 32; }
      b64() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

      ensure_secrets() {
        umask 077
        if [ ! -f ${root}/secrets.env ]; then
          jwt_secret=$(rand)
          # A service_role JWT signed with GoTrue's secret (HS256, ten years).
          header=$(printf '{"alg":"HS256","typ":"JWT"}' | b64)
          payload=$(printf '{"iss":"mike-staging","role":"service_role","exp":%s}' "$(( $(date +%s) + 315360000 ))" | b64)
          sig=$(printf '%s.%s' "$header" "$payload" | openssl dgst -sha256 -hmac "$jwt_secret" -binary | b64)
          {
            echo "POSTGRES_PASSWORD=$(rand)"
            # GoTrue's database role password comes from docker/db-init/roles.sql;
            # the database is reachable only inside the compose network.
            echo "GOTRUE_DB_PASSWORD=postgres"
            echo "GOTRUE_JWT_SECRET=$jwt_secret"
            echo "AUTH_SERVICE_KEY=$header.$payload.$sig"
            echo "STORAGE_ACCESS_KEY=mike$(openssl rand -hex 8)"
            echo "STORAGE_SECRET_KEY=$(rand)"
            echo "FRONTEND_URL=https://${domain}"
            echo "AUTH_PUBLIC_URL=https://${domain}/gotrue"
            echo "API_PUBLIC_URL=https://${domain}/api"
            echo "BACKEND_PORT=127.0.0.1:3001"
            echo "FRONTEND_PORT=127.0.0.1:3000"
            echo "AUTH_PORT=127.0.0.1:54321"
            echo "GOTRUE_DISABLE_SIGNUP=true"
            echo "GOTRUE_MAILER_AUTOCONFIRM=false"
            echo "GOTRUE_EXTERNAL_GOOGLE_ENABLED=false"
            echo "SENTRY_DISABLED=true"
          } > ${root}/secrets.env
        fi
        if [ ! -f ${root}/app.env ]; then
          {
            echo "USER_API_KEYS_ENCRYPTION_SECRET=$(rand)"
            echo "DOWNLOAD_SIGNING_SECRET=$(rand)"
            echo "AUTH_HANDOFF_ENCRYPTION_SECRET=$(rand)"
            echo "ALLOWED_ORIGINS=https://${domain}"
          } > ${root}/app.env
        fi
      }

      # The compose root .env is the backend's env_file.
      write_backend_env() {
        umask 077
        cat ${root}/app.env > ${root}/src/.env
        for extra in backend.env workstation.env; do
          if [ -f "${root}/$extra" ]; then cat "${root}/$extra" >> ${root}/src/.env; fi
        done
        # A private stack reports errors to no one.
        echo "SENTRY_DISABLED=true" >> ${root}/src/.env
        echo "CODE_MODE_ENABLED=true" >> ${root}/src/.env
      }

      cmd=''${1:-}
      case "$cmd" in
        deploy)
          ensure_secrets
          write_backend_env
          GIT_SHA=$(cat ${root}/src/.git-sha 2>/dev/null || echo unknown)
          export GIT_SHA
          compose build
          compose up -d --remove-orphans ;;
        up) compose up -d ;;
        down) compose down ;;
        ps) compose ps ;;
        logs) shift; compose logs --tail=200 "$@" ;;
        compose) shift; compose "$@" ;;
        owner-link)
          # A one-time sign-in link for an account (created if missing, with
          # no password). Prints the link; nothing is emailed.
          email=''${2:?email}
          service_key=$(grep '^AUTH_SERVICE_KEY=' ${root}/secrets.env | cut -d= -f2-)
          api=http://127.0.0.1:54321
          curl -fsS -X POST "$api/admin/users" -H "Authorization: Bearer $service_key" -H 'Content-Type: application/json' \
            -d "$(jq -n --arg e "$email" '{email:$e, email_confirm:true}')" >/dev/null 2>&1 || true
          link=$(curl -fsS -X POST "$api/admin/generate_link" -H "Authorization: Bearer $service_key" -H 'Content-Type: application/json' \
            -d "$(jq -n --arg e "$email" --arg r "https://${domain}/auth/callback" '{type:"magiclink", email:$e, redirect_to:$r}')")
          # The owner gets the host's workstation VM (infra/node-a/workstations.nix).
          user_id=$(jq -r '.id // .user.id // empty' <<<"$link")
          if [ -n "$user_id" ] && ! grep -qs "^WORKSTATION_USER_IDS=$user_id\$" ${root}/workstation.env; then
            umask 077
            {
              echo "WORKSTATION_USER_IDS=$user_id"
              echo "WORKSTATION_NAME=ws-owner"
              echo "WORKSTATION_SSH_PROXY_COMMAND=node /app/dist/lib/workstation/vsockProxy.js /run/mike-workstations/ws-owner.sock 22"
              echo "WORKSTATION_SSH_IDENTITY_FILE=/run/workstation-key/harness_ed25519"
              echo "WORKSTATION_SNAPSHOT_SOCKET=/run/mike-workstations/control.sock"
            } > ${root}/workstation.env
            write_backend_env
            compose up -d backend >&2
          fi
          jq -r '.action_link // .properties.action_link' <<<"$link" ;;
        backup)
          # A dump that has not been restored is a hope, not a backup: each
          # one is restored into a scratch database and its tables counted.
          dest=${root}/backups/$(date -u +%Y%m%dT%H%M%SZ)
          mkdir -p "$dest"
          chmod 700 ${root}/backups
          podman exec mike-db-1 pg_dump -U postgres -Fc postgres > "$dest/postgres.dump"
          podman exec mike-db-1 sh -c 'dropdb -U postgres --if-exists restore_check && createdb -U postgres restore_check'
          podman exec -i mike-db-1 pg_restore -U postgres --no-owner -d restore_check < "$dest/postgres.dump" 2> "$dest/restore.log" || true
          tables=$(podman exec mike-db-1 psql -U postgres -d restore_check -tAc "select count(*) from information_schema.tables where table_schema = 'public'")
          live=$(podman exec mike-db-1 psql -U postgres -d postgres -tAc "select count(*) from information_schema.tables where table_schema = 'public'")
          podman exec mike-db-1 dropdb -U postgres restore_check
          echo "public tables: live $live, restored $tables" > "$dest/restore-check.txt"
          if [ "$tables" != "$live" ]; then echo "backup restore check FAILED: $(cat "$dest/restore-check.txt")" >&2; exit 1; fi
          tar -C /var/lib/containers/storage/volumes/mike_storage_data/_data -cf - . | zstd -q -T0 > "$dest/storage.tar.zst"
          # Keep fourteen days.
          find ${root}/backups -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
          echo "backup $dest: $(du -sh "$dest" | cut -f1), $(cat "$dest/restore-check.txt")" ;;
        health)
          # Public endpoints through Caddy and TLS, then the stack's own state.
          failed=0
          for path in / /api/health /gotrue/health; do
            code=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "https://${domain}$path" || true)
            if [ "$code" != 200 ]; then echo "unhealthy: $path returned $code" >&2; failed=1; fi
          done
          used=$(df --output=pcent / | tail -1 | tr -dc 0-9)
          if [ "$used" -ge 85 ]; then echo "disk: / is $used% full" >&2; failed=1; fi
          if [ "$failed" = 1 ]; then
            # Start whatever stopped; a crash loop stays visible in the journal.
            compose up -d >&2 || true
            exit 1
          fi
          echo "healthy" ;;
        *) echo "usage: mike-staging deploy|up|down|ps|logs [svc]|compose ...|owner-link <email>|backup|health" >&2; exit 2 ;;
      esac
    '';
  };
in
{
  virtualisation.podman = {
    enable = true;
    dockerSocket.enable = true;
    defaultNetwork.settings.dns_enabled = true;
  };
  virtualisation.containers.containersConf.settings.network.firewall_driver = "nftables";

  systemd.tmpfiles.rules = [ "d ${root} 0700 root root -" "d ${root}/src 0755 root root -" ];

  # Bring the stack back after a reboot (images and volumes persist).
  systemd.services.mike-staging = {
    description = "Mike staging stack (docker-compose on Podman)";
    after = [ "podman.socket" "network-online.target" ];
    wants = [ "network-online.target" ];
    requires = [ "podman.socket" ];
    wantedBy = [ "multi-user.target" ];
    unitConfig.ConditionPathExists = "${root}/secrets.env";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${stagingTool}/bin/mike-staging up";
      TimeoutStartSec = 900;
    };
  };

  systemd.services.mike-staging-backup = {
    description = "Back up Mike staging (Postgres, restore-checked, and object storage)";
    unitConfig.ConditionPathExists = "${root}/secrets.env";
    serviceConfig = { Type = "oneshot"; ExecStart = "${stagingTool}/bin/mike-staging backup"; };
  };
  systemd.timers.mike-staging-backup = {
    wantedBy = [ "timers.target" ];
    timerConfig = { OnCalendar = "*-*-* 03:30:00"; RandomizedDelaySec = "20m"; Persistent = true; };
  };
  systemd.services.mike-staging-health = {
    description = "Check Mike staging from the public URL";
    unitConfig.ConditionPathExists = "${root}/secrets.env";
    serviceConfig = { Type = "oneshot"; ExecStart = "${stagingTool}/bin/mike-staging health"; };
  };
  systemd.timers.mike-staging-health = {
    wantedBy = [ "timers.target" ];
    timerConfig = { OnBootSec = "5m"; OnUnitActiveSec = "5m"; };
  };

  services.caddy = {
    enable = true;
    email = "staging@${domain}";
    virtualHosts.${domain}.extraConfig = ''
      encode zstd gzip
      # GoTrue, for email links and OAuth callbacks.
      handle_path /gotrue/* {
        reverse_proxy 127.0.0.1:54321
      }
      # Presigned S3 requests (path-style, bucket "mike") go to RustFS with the
      # host and path they were signed for.
      @s3 {
        path /mike/*
        query X-Amz-Algorithm=*
      }
      handle @s3 {
        request_body {
          max_size 110MB
        }
        reverse_proxy 127.0.0.1:9000
      }
      handle {
        reverse_proxy 127.0.0.1:3000 {
          flush_interval -1
        }
      }
      header {
        Strict-Transport-Security "max-age=31536000"
        X-Content-Type-Options nosniff
        Referrer-Policy strict-origin-when-cross-origin
        -Server
      }
    '';
  };

  networking.firewall.allowedTCPPorts = [ 80 443 ];
  # The podman module opens DNS on podman0 only; compose networks get their
  # own bridges (podman1, ...), and their containers resolve each other there.
  networking.firewall.extraInputRules = ''
    iifname "podman*" meta l4proto { tcp, udp } th dport 53 accept
  '';
  environment.systemPackages = [ stagingTool pkgs.docker-compose ];
}
