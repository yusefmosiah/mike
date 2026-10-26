# The agent's own desktop: a virtual X display with a window manager, a
# browser and a text editor, the X11 computer helper connected to the API,
# and a noVNC view of the screen for the person to watch.
#
# Build from computer-helper-rs/:  docker build -f sandbox/Dockerfile -t computer-sandbox .
# Settings come from the environment; see sandbox/README.md.

FROM rust:1.99-trixie AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
RUN cargo build --release --locked -p computer-x11

FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb openbox x11vnc novnc websockify \
      dbus dbus-x11 at-spi2-core \
      firefox-esr mousepad \
      fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --shell /bin/sh agent
COPY --from=build /src/target/release/computer-helper-x11 /usr/local/bin/
COPY sandbox/entrypoint.sh /usr/local/bin/sandbox-entrypoint
USER agent
WORKDIR /home/agent
ENV DISPLAY=:1 \
    GTK_MODULES=gail:atk-bridge \
    GNOME_ACCESSIBILITY=1 \
    COMPUTER_PLATFORM=sandbox \
    SANDBOX_SCREEN=1280x800x24
# noVNC, for watching. Publish it to localhost or behind an authenticating proxy only.
EXPOSE 6080
ENTRYPOINT ["/usr/local/bin/sandbox-entrypoint"]
