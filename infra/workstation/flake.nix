{
  description = "Mike workstation VMs: one persistent microVM per employee (Mission 13)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, microvm }:
    let
      lib = nixpkgs.lib;
      # Dev only: the harness's public key, read at evaluation time
      # (`--impure`), so no key is committed. Production passes keys from the
      # host's provisioning instead.
      devKeys = let key = builtins.getEnv "WORKSTATION_SSH_PUBKEY"; in lib.optional (key != "") key;

      # A development VM: QEMU, guest ssh forwarded to port 2222. On a Mac it
      # uses Hypervisor.framework; on Linux it uses KVM when present and
      # software emulation otherwise (e.g. inside Docker Desktop on an M1,
      # which has no nested virtualization). Cloud Hypervisor needs KVM.
      devVm = hostSystem: lib.nixosSystem {
        system = lib.replaceString "-darwin" "-linux" hostSystem;
        modules = [
          microvm.nixosModules.microvm
          ./guest.nix
          {
            workstation.authorizedKeys = devKeys;
            microvm = {
              hypervisor = "qemu";
              vmHostPackages = nixpkgs.legacyPackages.${hostSystem};
              # "host" needs hardware acceleration; "max" also runs emulated.
              cpu = lib.mkIf (lib.hasSuffix "-linux" hostSystem) "max";
              interfaces = [{ type = "user"; id = "usernet"; mac = "02:00:00:00:00:01"; }];
              forwardPorts = [{ from = "host"; host.port = 2222; guest.port = 22; }];
            };
            networking.firewall.allowedTCPPorts = [ 22 ];
          }
        ];
      };

      # The production guest: Cloud Hypervisor, ssh over vsock only (systemd's
      # ssh generator listens on vsock port 22; the host connects with
      # `ssh vsock-mux/<socket>`). Networking and the data disk are wired by
      # the host module.
      cloudHypervisorVm = system: lib.nixosSystem {
        inherit system;
        modules = [
          microvm.nixosModules.microvm
          ./guest.nix
          {
            microvm = {
              hypervisor = "cloud-hypervisor";
              vsock.cid = 3;
              vsock.ssh.enable = true;
            };
          }
        ];
      };
    in
    {
      nixosConfigurations = {
        dev-aarch64-darwin = devVm "aarch64-darwin";
        dev-aarch64-linux = devVm "aarch64-linux";
        ch-x86_64-linux = cloudHypervisorVm "x86_64-linux";
        ch-aarch64-linux = cloudHypervisorVm "aarch64-linux";
      };

      packages.aarch64-darwin.dev-vm = self.nixosConfigurations.dev-aarch64-darwin.config.microvm.declaredRunner;
      packages.aarch64-linux.dev-vm = self.nixosConfigurations.dev-aarch64-linux.config.microvm.declaredRunner;
      packages.x86_64-linux.ch-vm = self.nixosConfigurations.ch-x86_64-linux.config.microvm.declaredRunner;
      packages.aarch64-linux.ch-vm = self.nixosConfigurations.ch-aarch64-linux.config.microvm.declaredRunner;
    };
}
