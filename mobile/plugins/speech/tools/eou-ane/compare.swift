import CoreML
import Foundation
// compare <orig.mlmodelc> <origUnits> <new.mlmodelc> <newUnits> [steps]
func units(_ s: String) -> MLComputeUnits { s == "ane" ? .cpuAndNeuralEngine : s == "gpu" ? .cpuAndGPU : s == "cpu" ? .cpuOnly : .all }
func load(_ p: String, _ u: String) throws -> MLModel { let c = MLModelConfiguration(); c.computeUnits = units(u); let t = Date(); let m = try MLModel(contentsOf: URL(fileURLWithPath: p), configuration: c); print("load \(p.split(separator: "/").suffix(2).joined(separator: "/")) \(u): \(String(format: "%.2f", Date().timeIntervalSince(t)))s"); return m }
let a = CommandLine.arguments
let ref = try load(a[1], a[2]), new = try load(a[3], a[4])
let steps = a.count > 5 ? Int(a[5])! : 30
struct R: RandomNumberGenerator { var s: UInt64 = 42; mutating func next() -> UInt64 { s = s &* 6364136223846793005 &+ 1442695040888963407; return s >> 11 } }
var rng = R()
func randn() -> Float { let u1 = Float.random(in: 1e-6..<1, using: &rng), u2 = Float.random(in: 0..<1, using: &rng); return sqrt(-2 * log(u1)) * cos(2 * .pi * u2) }
func zeros(_ shape: [Int], _ t: MLMultiArrayDataType) -> MLMultiArray { let m = try! MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: t); for i in 0..<m.count { m[i] = 0 }; return m }
struct State { var pre: MLMultiArray, ch: MLMultiArray, tm: MLMultiArray, len: MLMultiArray }
func fresh(_ dt: MLMultiArrayDataType) -> State { State(pre: zeros([1,128,9], .float32), ch: zeros([17,1,70,512], dt), tm: zeros([17,1,512,8], dt), len: zeros([1], .int32)) }
func dtype(_ m: MLModel) -> MLMultiArrayDataType { m.modelDescription.inputDescriptionsByName["cache_last_channel"]!.multiArrayConstraint!.dataType }
var s1 = fresh(dtype(ref)), s2 = fresh(dtype(new))
func step(_ m: MLModel, _ s: inout State, _ mel: MLMultiArray, _ localLen: Bool) throws -> [Float] {
    let len = try MLMultiArray(shape: [1], dataType: .int32); len[0] = 64
    let inp = try MLDictionaryFeatureProvider(dictionary: ["audio_signal": MLFeatureValue(multiArray: mel), "audio_length": MLFeatureValue(multiArray: len), "pre_cache": MLFeatureValue(multiArray: s.pre), "cache_last_channel": MLFeatureValue(multiArray: s.ch), "cache_last_time": MLFeatureValue(multiArray: s.tm), "cache_last_channel_len": MLFeatureValue(multiArray: s.len)])
    let o = try m.prediction(from: inp)
    s.pre = o.featureValue(for: "new_pre_cache")!.multiArrayValue!
    s.ch = o.featureValue(for: "new_cache_last_channel")!.multiArrayValue!
    s.tm = o.featureValue(for: "new_cache_last_time")!.multiArrayValue!
    if localLen { let l = try MLMultiArray(shape: [1], dataType: .int32); l[0] = NSNumber(value: min(s.len[0].intValue + 4, 70)); s.len = l } else { s.len = o.featureValue(for: "new_cache_last_channel_len")!.multiArrayValue! }
    let e = o.featureValue(for: "encoded_output")!.multiArrayValue!
    return (0..<e.count).map { e[$0].floatValue }
}
var worst: Float = 0, worstCos: Float = 1
for i in 0..<steps {
    let mel = try MLMultiArray(shape: [1,128,64], dataType: .float32)
    let speechy = (i % 6) < 4
    for k in 0..<mel.count { mel[k] = NSNumber(value: randn() * (speechy ? 2.0 : 0.3) - (speechy ? 3 : 8)) }
    let r = try step(ref, &s1, mel, false)
    let n = try step(new, &s2, mel, true)
    var d: Float = 0, dot: Float = 0, na: Float = 0, nb: Float = 0
    for k in 0..<r.count { d = max(d, abs(r[k]-n[k])); dot += r[k]*n[k]; na += r[k]*r[k]; nb += n[k]*n[k] }
    let cos = dot / (sqrt(na)*sqrt(nb)); worst = max(worst, d); worstCos = min(worstCos, cos)
    if i < 3 || i % 10 == 9 { print(String(format: "step %d: max|d| %.4f cos %.6f (ref max %.2f)", i, d, cos, r.map { abs($0) }.max()!)) }
}
print(String(format: "WORST over %d steps: max|d| %.4f, min cos %.6f", steps, worst, worstCos))
