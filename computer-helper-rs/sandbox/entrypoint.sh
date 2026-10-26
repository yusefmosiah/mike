#!/bin/sh
# Start the desktop, then run the helper in the foreground: the container
# lives as long as the helper does.
set -eu

Xvfb "$DISPLAY" -screen 0 "$SANDBOX_SCREEN" -nolisten tcp &
socket="/tmp/.X11-unix/X${DISPLAY#:}"
tries=0
until [ -S "$socket" ]; do
  tries=$((tries + 1))
  if [ "$tries" -gt 100 ]; then
    echo "sandbox: the X server did not start" >&2
    exit 1
  fi
  sleep 0.1
done

eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS
/usr/libexec/at-spi-bus-launcher --launch-immediately &
openbox &

# The person watches; only the agent acts. SANDBOX_VNC_INPUT=1 lets the
# viewer type and click too.
view_only="-viewonly"
[ "${SANDBOX_VNC_INPUT:-0}" = "1" ] && view_only=""
x11vnc -display "$DISPLAY" -forever -shared -nopw -localhost -rfbport 5900 -quiet $view_only \
  >/dev/null 2>&1 &
websockify --web /usr/share/novnc 6080 localhost:5900 >/dev/null 2>&1 &

exec computer-helper-x11
