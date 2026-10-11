# Home egress

YouTube asks data-centre addresses to sign in, so a workstation on node-a
cannot fetch captions. This sends YouTube's hosts, and only those, out through
the owner's Mac at home instead.

```
workstation VM ──> tinyproxy on node-a ──(Upstream for YouTube hosts)──> 127.0.0.1:18118 on node-a
   ──ssh -R tunnel──> 127.0.0.1:18118 on the Mac (proxy.mjs) ──> www.youtube.com
```

- `proxy.mjs` serves CONNECT to port 443 of the listed hosts
  (`HOME_EGRESS_HOSTS`, default `youtube.com,youtu.be,youtube-nocookie.com`)
  and refuses anything else, including any name that resolves to a private,
  loopback, link-local or CGNAT address, so the tunnel cannot reach the home
  network or the Mac's own services. It logs host and outcome only.
- `tunnel.sh` holds the reverse tunnel open with the Mac's existing key for
  node-a. launchd restarts it after a network change, sleep or reboot.
- `infra/node-a/workstations.nix` has the matching `Upstream` lines and the
  one nftables exception that lets tinyproxy reach `127.0.0.1:18118`.

When the Mac is asleep, offline or the agents are stopped, YouTube requests
fail as they did before; nothing else is affected.

## Install, check, remove (on the Mac)

```sh
infra/home-egress/install.sh            # two per-user launchd agents; no admin rights
launchctl list | grep com.mike.home-egress
tail ~/Library/Logs/MikeHomeEgress/proxy.log
ssh node-a 'ss -ltn | grep 18118'       # the tunnel's end on node-a
infra/home-egress/install.sh uninstall
```

The agents run the copies in `~/Library/Application Support/MikeHomeEgress`;
re-run `install.sh` after changing the sources here. The proxy runs on the Node
binary found at install time (`NODE=/path/to/node` to choose another).
