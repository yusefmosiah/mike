# Lets Choir's Node B use this host as a Nix remote builder.
{ ... }:
{
  users.users.root.openssh.authorizedKeys.keys = [
    ''restrict,command="nix-daemon --stdio" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEJ8EBaR/Mc4EtiLGKy8mDKy5H5Vey4VKpwpCHbSgKKT nix-builder@node-b''
  ];
  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    system-features = [ "benchmark" "big-parallel" "kvm" "nixos-test" ];
  };
}
