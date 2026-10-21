"""Loads a pyannote checkpoint with weights_only=True, allowlisting stand-in
classes for the pyannote objects it pickles (only the tensors are used)."""
import re, sys, types
import torch


def load(path):
    allowed = [torch.torch_version.TorchVersion]
    for _ in range(20):
        try:
            with torch.serialization.safe_globals(allowed):
                return torch.load(path, map_location="cpu", weights_only=True)
        except Exception as error:  # noqa: BLE001
            m = re.search(r"GLOBAL ([\w.]+) was not an allowed", str(error))
            if not m:
                raise
            module, _, name = m.group(1).rpartition(".")
            parts = module.split(".")
            for i in range(1, len(parts) + 1):
                sys.modules.setdefault(".".join(parts[:i]), types.ModuleType(".".join(parts[:i])))
            stub = type(name, (), {"__setstate__": lambda self, state: None, "__init__": lambda self, *a, **k: None,
                                   "__module__": module})
            if "Enum" in name or "Problem" in name or "Resolution" in name:
                stub = type(name, (), {"__new__": lambda cls, *a, **k: object.__new__(cls), "__module__": module})
            setattr(sys.modules[module], name, stub)
            allowed.append(stub)
    raise RuntimeError("too many globals")
