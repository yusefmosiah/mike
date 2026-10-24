import CoreML
import AVFoundation
func load(_ p: String, _ u: MLComputeUnits) throws -> MLModel { let c = MLModelConfiguration(); c.computeUnits = u; let t = Date(); let m = try MLModel(contentsOf: URL(fileURLWithPath: p), configuration: c); print("load \(p.split(separator: "/").last!) \(u.rawValue): \(String(format: "%.2f", Date().timeIntervalSince(t)))s"); return m }
func wav(_ p: String) -> [Float] { let f = try! AVAudioFile(forReading: URL(fileURLWithPath: p)); let b = AVAudioPCMBuffer(pcmFormat: f.processingFormat, frameCapacity: AVAudioFrameCount(f.length))!; try! f.read(into: b); var a = Array(UnsafeBufferPointer(start: b.floatChannelData![0], count: Int(b.frameLength))); while a.count < 160000 { a += a }; return Array(a.prefix(160000)) }
func arr(_ shape: [Int], _ v: (Int) -> Float) -> MLMultiArray { let m = try! MLMultiArray(shape: shape.map { NSNumber(value: $0) }, dataType: .float32); for i in 0..<m.count { m[i] = NSNumber(value: v(i)) }; return m }
func vec(_ m: MLMultiArray) -> [Float] { (0..<m.count).map { m[$0].floatValue } }
func cosine(_ a: [Float], _ b: [Float]) -> Float { var d: Float = 0, x: Float = 0, y: Float = 0; for i in 0..<a.count { d += a[i]*b[i]; x += a[i]*a[i]; y += b[i]*b[i] }; return d / (sqrt(x)*sqrt(y)) }
let a = CommandLine.arguments  // dir
let dir = a[1], audio = Array(a[2...])
let v2 = try load("\(dir)/wespeaker_v2.mlmodelc", .cpuOnly)
let fb = try load("\(dir)/FBank.mlmodelc", .cpuOnly)
let emb = try load("\(dir)/Embedding.mlmodelc", a.count > 0 ? .cpuAndNeuralEngine : .cpuOnly)
let embCpu = try load("\(dir)/Embedding.mlmodelc", .cpuOnly)
var v2e: [[Float]] = [], newE: [[Float]] = [], newCpu: [[Float]] = []
for p in audio {
    let w = wav(p)
    for scale in [Float(1)] {
        let wave = arr([3,160000]) { w[$0 % 160000] * scale }
        let mask = arr([3,589]) { _ in 1 }
        let o = try v2.prediction(from: MLDictionaryFeatureProvider(dictionary: ["waveform": MLFeatureValue(multiArray: wave), "mask": MLFeatureValue(multiArray: mask)]))
        var e = vec(o.featureValue(for: "embedding")!.multiArrayValue!); e = Array(e.prefix(256)); v2e.append(e)
        let w1 = arr([1,1,160000]) { w[$0] * scale }
        let f = try fb.prediction(from: MLDictionaryFeatureProvider(dictionary: ["audio": MLFeatureValue(multiArray: w1)])).featureValue(for: "fbank_features")!.multiArrayValue!
        print("fbank shape", f.shape, "v2 emb count", vec(o.featureValue(for: "embedding")!.multiArrayValue!).count)
        for (m, store) in [(emb, 0), (embCpu, 1)] {
            let ins = try MLDictionaryFeatureProvider(dictionary: ["fbank_features": MLFeatureValue(multiArray: f), "weights": MLFeatureValue(multiArray: arr([1,589]) { _ in 1 })])
            let r = vec(try m.prediction(from: ins).featureValue(for: "embedding")!.multiArrayValue!)
            if store == 0 { newE.append(r) } else { newCpu.append(r) }
        }
        var t = Date(); for _ in 0..<10 { _ = try emb.prediction(from: MLDictionaryFeatureProvider(dictionary: ["fbank_features": MLFeatureValue(multiArray: f), "weights": MLFeatureValue(multiArray: arr([1,589]) { _ in 1 })])) }
        print(String(format: "Embedding ANE predict mean %.1f ms", Date().timeIntervalSince(t) * 100))
    }
}
for i in 0..<audio.count { print("clip \(i): cos(v2 cpu, new ANE)=\(cosine(v2e[i], newE[i])), cos(new cpu,new ANE)=\(cosine(newCpu[i], newE[i])), cos(v2,newcpu)=\(cosine(v2e[i], newCpu[i]))") }
if audio.count > 1 { print("cross-speaker cos v2: \(cosine(v2e[0], v2e[1])) new: \(cosine(newE[0], newE[1]))") }
