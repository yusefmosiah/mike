#!/bin/sh
# Opens node-a's 127.0.0.1:18118 onto this Mac's home-egress proxy and keeps it
# there; launchd restarts it whenever it exits (network change, sleep, node-a
# reboot). ExitOnForwardFailure makes a still-held remote port end the attempt
# instead of leaving a tunnel that forwards nothing.
exec /usr/bin/ssh -N \
    -o BatchMode=yes \
    -o ExitOnForwardFailure=yes \
    -o ServerAliveInterval=20 \
    -o ServerAliveCountMax=3 \
    -o ConnectTimeout=15 \
    -R "127.0.0.1:${HOME_EGRESS_PORT:-18118}:127.0.0.1:${HOME_EGRESS_PORT:-18118}" \
    "${HOME_EGRESS_SSH_HOST:-node-a}"
