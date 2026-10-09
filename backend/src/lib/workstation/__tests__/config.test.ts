import { describe, expect, it } from "vitest";

import { workstationFor } from "../config";

const base = {
  WORKSTATION_USER_IDS: "user-a, user-b",
  WORKSTATION_SSH_HOST: "127.0.0.1",
  WORKSTATION_SSH_PORT: "2222",
  WORKSTATION_SSH_IDENTITY_FILE: "/keys/dev",
};

describe("workstationFor", () => {
  it("gives a listed user the configured VM", () => {
    expect(workstationFor("user-b", base)).toEqual({
      host: "127.0.0.1",
      port: 2222,
      user: "agent",
      identityFile: "/keys/dev",
      proxyCommand: undefined,
      knownHostsFile: undefined,
      snapshot: undefined,
    });
  });

  it("gives an unlisted user nothing", () => {
    expect(workstationFor("user-c", base)).toBeNull();
    expect(workstationFor("user-a", { ...base, WORKSTATION_USER_IDS: "" })).toBeNull();
  });

  it("needs an identity file and a way to connect", () => {
    expect(workstationFor("user-a", { ...base, WORKSTATION_SSH_IDENTITY_FILE: "" })).toBeNull();
    expect(workstationFor("user-a", { ...base, WORKSTATION_SSH_HOST: "" })).toBeNull();
  });

  it("connects through a vsock proxy without a host", () => {
    const target = workstationFor("user-a", { ...base, WORKSTATION_SSH_HOST: "", WORKSTATION_SSH_PORT: "", WORKSTATION_SSH_PROXY_COMMAND: "systemd-ssh-proxy vsock-mux/run/a.sock 22" });
    expect(target).toMatchObject({ host: "workstation", port: undefined, proxyCommand: "systemd-ssh-proxy vsock-mux/run/a.sock 22" });
  });

  it("names the host snapshot service when both socket and VM are set", () => {
    expect(workstationFor("user-a", { ...base, WORKSTATION_SNAPSHOT_SOCKET: "/run/mike-workstations/control.sock", WORKSTATION_NAME: "ws-owner" })?.snapshot).toEqual({
      socketPath: "/run/mike-workstations/control.sock",
      vm: "ws-owner",
    });
    expect(workstationFor("user-a", { ...base, WORKSTATION_SNAPSHOT_SOCKET: "/run/x.sock" })?.snapshot).toBeUndefined();
  });
});
