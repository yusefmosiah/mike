import sys, coremltools as ct, numpy as np
from coremltools.converters.mil.frontend.milproto.load import load as milload
from coremltools.converters.mil import Builder as mb
from coremltools.converters.mil.mil import types
P="dl_eou/320ms/streaming_encoder.mlpackage"
out=sys.argv[1]
m=ct.models.MLModel(P, skip_model_load=True); spec=m.get_spec()
prog=milload(spec, spec.specificationVersion, m.weights_dir); f=prog.functions['main']
def find(n): return [v for o in f.operations for v in o.outputs if v.name==n][0]
for n in ("cache_last_channel","cache_last_time"):
    v=f.inputs[n]; v._sym_type=types.tensor(types.fp16, v.shape)
with f:
    enc=mb.cast(x=find("obj_1_cast_fp16"),dtype="fp32",name="encoded_output")
    pre=mb.cast(x=find("var_28_cast_fp16"),dtype="fp32",name="new_pre_cache")
    ch=mb.identity(x=find("obj_5_cast_fp16"),name="new_cache_last_channel")
    tm=mb.identity(x=find("obj_7_cast_fp16"),name="new_cache_last_time")
f.set_outputs([enc,pre,ch,tm])
from coremltools.converters.mil.mil.passes.pass_registry import PASS_REGISTRY
PASS_REGISTRY['common::dead_code_elimination'](prog)
ml=ct.convert(prog, convert_to="mlprogram", compute_precision=ct.precision.FLOAT16, minimum_deployment_target=ct.target.iOS17, compute_units=ct.ComputeUnit.CPU_ONLY)
# rename outputs/inputs to original names
spec=ml.get_spec()
print([ (i.name,i.type.multiArrayType.dataType) for i in spec.description.input])
print([ (i.name,i.type.multiArrayType.dataType) for i in spec.description.output])
ml.save(out)
