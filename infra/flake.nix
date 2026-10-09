{
  description = "Mike infrastructure: hosts (node-a) and workstation VMs";

  inputs = {
    # node-a's running nixpkgs at takeover (2026-10-09).
    nixpkgs.url = "github:NixOS/nixpkgs/ec84054698e3875e23d6057a10283eb9dfa41f1b";
    microvm = {
      url = "github:microvm-nix/microvm.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, microvm }: {
    nixosConfigurations.node-a = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit microvm; };
      modules = [ ./node-a/configuration.nix ];
    };
  };
}
